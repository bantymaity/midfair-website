# MedFair — Vercel AI Analyze + Payment-Verified Delivery Functions

Standalone Vercel serverless functions: real Gemini 1.5 Flash document analysis, a
Lemon Squeezy checkout + signed-webhook verification pipeline, and a post-payment
receipt email. This folder is **not** part of the FastAPI/React app in this workspace —
deploy it separately on Vercel (or copy the `api/` files into an existing Vercel project).

## Files
- **`api/analyze.js`** — accepts `multipart/form-data` (file + category), parses fully in memory with `busboy`, sends the file to Gemini 1.5 Flash (`responseMimeType: "application/json"`), returns `{ summary_title, key_findings, action_plan, full_letter_content }`.
- **`api/create-checkout.js`** — call this right before opening the Lemon Squeezy overlay. Caches the analyzed letter in Vercel KV under a random `order_token` (1-hour TTL) and returns a checkout URL with that token attached as `checkout[custom][order_token]`.
- **`api/webhook.js`** — Lemon Squeezy webhook endpoint. Verifies the `X-Signature` header via HMAC-SHA256 (`LEMON_SQUEEZY_WEBHOOK_SECRET`) using the **raw** request body, then on a valid `order_created` event marks the cached order `verified: true` and sends a branded receipt email (Resend) with a "Download My Letter Again" link.
- **`api/order-status.js`** — polled by the frontend after `Checkout.Success` fires, and loaded by `recover-letter.html`. Only returns the letter content once `api/webhook.js` has verified the order — this is what actually gates PDF generation, not the client-side event.
- **`/recover-letter.html`** (site root, next to `index.html`) — the page the emailed backup link points to; re-downloads the PDF client-side using the same token.

## Why a cache at all?
The webhook fires from Lemon Squeezy's servers, completely separately from the browser tab that ran the analysis — there's no way to hand off "this order is verified" without *some* shared, short-lived state. `letter:{order_token}` entries in Vercel KV auto-expire after **1 hour** (`ex: 3600`) whether or not payment ever completes, and are never written anywhere else. This is documented in `privacy.html` as a short-lived checkout cache, not permanent storage.

## Deploy steps
1. `cd vercel-api && npm install`
2. In the Vercel dashboard:
   - **Storage → Create Database → KV** — link it to this project (auto-injects `KV_REST_API_URL` / `KV_REST_API_TOKEN`)
   - **Project Settings → Environment Variables**, add:
     - `GEMINI_API_KEY` — https://aistudio.google.com/apikey
     - `RESEND_API_KEY` — https://resend.com/api-keys
     - `LEMON_SQUEEZY_WEBHOOK_SECRET` — set when you create the webhook below
     - `SITE_URL` — your deployed domain, e.g. `https://medfair.us` (used to build the recovery link)
3. In your Lemon Squeezy dashboard → **Settings → Webhooks** → Add webhook:
   - URL: `https://YOUR-DOMAIN/api/webhook`
   - Events: `order_created`
   - Copy the **Signing secret** into `LEMON_SQUEEZY_WEBHOOK_SECRET`
4. Update the placeholders before going live:
   - `LEMON_CHECKOUT_BASE_URL` in `api/create-checkout.js`
   - `FROM_ADDRESS` in `api/webhook.js` (must be a domain verified in Resend)
5. `vercel deploy`. Keep `index.html`, `recover-letter.html`, and `api/` in the same Vercel project so all the relative `fetch('/api/...')` calls hit the same origin.

## Notes
- All secrets are read from `process.env` only — never hardcoded.
- The webhook returns `500` on internal fulfillment errors (after signature is already verified) so Lemon Squeezy retries delivery; it returns `200` for anything it intentionally ignores (unrelated event types, unknown/expired tokens) so Lemon Squeezy doesn't retry those forever.
- Frontend PDF generation in `index.html` is gated on `api/order-status.js` reporting `verified: true` — the `Checkout.Success` browser event only triggers polling, it does not unlock anything by itself.
