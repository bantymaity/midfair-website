// api/create-checkout.js
// Vercel Serverless Function — prepares a Lemon Squeezy checkout for a specific
// analyzed letter. Caches the letter content in Vercel KV (short-lived, auto-expiring)
// keyed by a random order token, then returns a checkout URL with that token attached
// as custom checkout data so the webhook can correlate the eventual payment back to it.

const crypto = require('crypto');
const { kv } = require('@vercel/kv');

const CACHE_TTL_SECONDS = 60 * 60; // 1 hour — auto-expires even if payment never completes

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  const { letterHTML } = req.body || {};
  if (!letterHTML || typeof letterHTML !== 'string') {
    return res.status(400).json({ error: 'letterHTML is required.' });
  }

  const orderToken = crypto.randomUUID();

  try {
    await kv.set(
      `letter:${orderToken}`,
      { letterHTML, verified: false, email: null, orderNumber: null },
      { ex: CACHE_TTL_SECONDS }
    );
  } catch (err) {
    console.error('KV write error in create-checkout:', err);
    return res.status(500).json({ error: 'Could not prepare checkout. Please try again.' });
  }

  // --- SMART SYSTEM: Lemon Squeezy API (With hardcoded IDs to fix 404 issue) ---
  try {
    // শুধু এই দুটো লাইনে কোটেশনের (" ") ভেতরে আপনার আসল আইডি নম্বর দুটো বসিয়ে দিন
    const variantId = "2075803"; 
    const storeId = "1328203";       
    const apiKey = process.env.LEMON_SQUEEZY_API_KEY;

    const lsRes = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        data: {
          type: 'checkouts',
          attributes: {
            checkout_data: { custom: { order_token: orderToken } }
          },
          relationships: {
            store: { data: { type: 'stores', id: storeId } },
            variant: { data: { type: 'variants', id: variantId } }
          }
        }
      })
    });

    const lsData = await lsRes.json();
    if (!lsRes.ok) {
       console.error("Lemon Squeezy API Error:", lsData);
       return res.status(500).json({ error: 'Failed to create checkout link via API.' });
    }

    const checkoutUrl = lsData.data.attributes.url;
    return res.status(200).json({ checkoutUrl, orderToken });

  } catch (apiErr) {
    console.error('API execution error:', apiErr);
    return res.status(500).json({ error: 'Internal server error while creating checkout.' });
  }
};
