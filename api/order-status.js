// api/order-status.js
// Vercel Serverless Function — polled by the frontend after Lemon Squeezy's
// client-side "Checkout.Success" event fires, and loaded directly by
// recover-letter.html via the emailed backup link.
//
// Returns { verified: false } until api/webhook.js has confirmed the payment via a
// signature-verified Lemon Squeezy webhook. The frontend must NOT generate/download
// the PDF until this endpoint reports verified: true — this is the enforcement point
// that prevents trusting the client-side checkout event alone.

const { kv } = require('@vercel/kv');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed. Use GET.' });

  const token = req.query && req.query.token;
  if (!token) return res.status(400).json({ error: 'token query param is required.' });

  try {
    const cached = await kv.get(`letter:${token}`);
    if (!cached) {
      return res.status(404).json({ verified: false, expired: true });
    }
    return res.status(200).json({
      verified: !!cached.verified,
      email: cached.email || null,
      // Only ever return the letter content once payment is verified server-side.
      letterHTML: cached.verified ? cached.letterHTML : null,
    });
  } catch (err) {
    console.error('order-status KV read error:', err);
    return res.status(500).json({ error: 'Could not check order status.' });
  }
};
