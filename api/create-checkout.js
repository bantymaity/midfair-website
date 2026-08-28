// api/create-checkout.js
// Vercel Serverless Function — prepares a Lemon Squeezy checkout for a specific
// analyzed letter. Caches the letter content in Vercel KV (short-lived, auto-expiring)
// keyed by a random order token, then returns a checkout URL with that token attached
// as custom checkout data so the webhook can correlate the eventual payment back to it.

const crypto = require('crypto');
const { kv } = require('@vercel/kv');

const CACHE_TTL_SECONDS = 60 * 60; // 1 hour — auto-expires even if payment never completes

// TODO: replace with your real Lemon Squeezy checkout URL, e.g.
// https://your-store.lemonsqueezy.com/checkout/buy/your-variant-id
const LEMON_CHECKOUT_BASE_URL = 'https://YOUR-STORE.lemonsqueezy.com/checkout/buy/YOUR_VARIANT_ID';

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

  const checkoutUrl = `${LEMON_CHECKOUT_BASE_URL}?checkout[custom][order_token]=${encodeURIComponent(orderToken)}`;
  return res.status(200).json({ checkoutUrl, orderToken });
};
