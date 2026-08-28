// api/webhook.js
// Vercel Serverless Function — Lemon Squeezy signed webhook listener.
//
// Verifies the X-Signature header against process.env.LEMON_SQUEEZY_WEBHOOK_SECRET
// using a raw-body HMAC-SHA256 comparison (constant-time). Only once the signature
// is verified does this function mark the corresponding cached order as "paid" and
// send the customer a branded receipt email with a backup download link — the
// frontend's PDF generation is gated on THIS verification (via /api/order-status),
// not on the client-side Lemon.js "Checkout.Success" event alone.

const crypto = require('crypto');
const { kv } = require('@vercel/kv');
const { Resend } = require('resend');

// Disables Vercel's automatic body parsing so we can hash the exact raw bytes
// Lemon Squeezy signed — parsing/re-serializing JSON first would break the signature.
module.exports.config = { api: { bodyParser: false } };

const CACHE_TTL_SECONDS = 60 * 60; // keep the verified record around for the recovery link
const SITE_URL = process.env.SITE_URL || 'https://YOUR-DOMAIN.example';
// TODO: replace with a "from" address on a domain verified in your Resend dashboard.
const FROM_ADDRESS = 'MedFair <receipts@YOUR-VERIFIED-DOMAIN.com>';

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function isValidSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;
  const expectedHex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const expected = Buffer.from(expectedHex, 'utf8');
  const provided = Buffer.from(String(signatureHeader), 'utf8');
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

function buildReceiptEmailHtml({ orderNumber, recoveryUrl }) {
  return `
  <div style="background:#F8FAFC; padding:32px 16px; font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:520px; margin:0 auto; background:#ffffff; border-radius:16px; overflow:hidden; border:1px solid #E7EBF1;">
      <div style="background:linear-gradient(120deg,#0B1B3A,#2F6BFF); padding:28px 32px;">
        <span style="color:#ffffff; font-family:Arial,sans-serif; font-weight:800; font-size:20px; letter-spacing:-0.02em;">MedFair</span>
      </div>
      <div style="padding:32px;">
        <h1 style="font-size:20px; color:#0B1B3A; margin:0 0 12px;">Your dispute letter is ready</h1>
        <p style="color:#334155; font-size:14px; line-height:1.6; margin:0 0 20px;">
          Thanks for your purchase${orderNumber ? ` — order <strong>#${orderNumber}</strong>` : ''}. Your full, personalized dispute letter was generated and downloaded in your browser.
        </p>
        <p style="color:#334155; font-size:14px; line-height:1.6; margin:0 0 28px;">
          Lost the file, or need it again on another device? Use the secure link below — it stays active for the next hour.
        </p>
        <a href="${recoveryUrl}" style="display:inline-block; background:linear-gradient(100deg,#0B1B3A,#2F6BFF); color:#ffffff; text-decoration:none; font-weight:700; font-size:14px; padding:14px 28px; border-radius:12px;">
          Download My Letter Again
        </a>
        <p style="color:#94A3B8; font-size:12px; line-height:1.6; margin:28px 0 0;">
          MedFair provides informational, AI-generated summaries only and does not constitute legal, medical, or financial advice. This link and the underlying letter data are automatically deleted within one hour.
        </p>
      </div>
    </div>
  </div>`;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed.');

  if (!process.env.LEMON_SQUEEZY_WEBHOOK_SECRET) {
    console.error('LEMON_SQUEEZY_WEBHOOK_SECRET is not set.');
    return res.status(500).send('Server misconfigured.');
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers['x-signature'];

  if (!isValidSignature(rawBody, signature, process.env.LEMON_SQUEEZY_WEBHOOK_SECRET)) {
    console.warn('Webhook signature verification failed.');
    return res.status(401).send('Invalid signature.');
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    return res.status(400).send('Invalid JSON.');
  }

  const eventName = payload && payload.meta && payload.meta.event_name;
  if (eventName !== 'order_created') {
    // Acknowledge everything else (subscription events, test pings, etc.) so
    // Lemon Squeezy doesn't retry — we simply have nothing to do for them here.
    return res.status(200).send(`Ignored event: ${eventName || 'unknown'}`);
  }

  const orderToken = payload.meta && payload.meta.custom_data && payload.meta.custom_data.order_token;
  const attrs = (payload.data && payload.data.attributes) || {};
  const email = attrs.user_email || null;
  const orderNumber = attrs.order_number || null;

  if (!orderToken) {
    console.error('order_created webhook missing custom_data.order_token — cannot correlate.');
    return res.status(200).send('No order_token in custom_data — nothing to fulfill.');
  }

  try {
    const cacheKey = `letter:${orderToken}`;
    const cached = await kv.get(cacheKey);

    if (!cached) {
      console.error('No cached letter found for order_token (expired or unknown):', orderToken);
      return res.status(200).send('No cached letter for this token — it may have expired.');
    }

    // Mark verified=true — this is what /api/order-status checks before the
    // frontend is allowed to generate/download the PDF.
    await kv.set(cacheKey, { ...cached, verified: true, email, orderNumber }, { ex: CACHE_TTL_SECONDS });

    if (process.env.RESEND_API_KEY && email) {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const recoveryUrl = `${SITE_URL}/recover-letter.html?token=${encodeURIComponent(orderToken)}`;
      await resend.emails.send({
        from: FROM_ADDRESS,
        to: email,
        subject: `Your MedFair Dispute Letter${orderNumber ? ` — Order #${orderNumber}` : ''}`,
        html: buildReceiptEmailHtml({ orderNumber, recoveryUrl }),
      });
    } else if (!process.env.RESEND_API_KEY) {
      console.warn('RESEND_API_KEY not set — skipping receipt email (order still marked verified).');
    }

    return res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook fulfillment error:', err);
    // Return 500 so Lemon Squeezy retries delivery (their retry policy will re-attempt
    // the email/verification step; signature has already been proven valid above).
    return res.status(500).send('Fulfillment error — will retry.');
  }
};
