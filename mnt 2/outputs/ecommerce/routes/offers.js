/**
 * routes/offers.js — "Make Offer" submissions
 *
 * POST /api/offers      — public: submit an offer on a product
 * GET  /api/offers      — admin: list offers (newest first)
 *
 * Offers are stored in SQLite and pushed to Denny's phone via ntfy.sh
 * (same topic as cart alerts: NTFY_TOPIC or 'crg-denny-alerts').
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db');

// Simple per-IP rate limit: max 5 offers per 10 minutes
const recent = new Map(); // ip -> [timestamps]
function rateLimited(ip) {
  const now  = Date.now();
  const hits = (recent.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  if (hits.length >= 5) return true;
  hits.push(now);
  recent.set(ip, hits);
  return false;
}

// POST /api/offers
router.post('/', async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    if (rateLimited(ip)) {
      return res.status(429).json({ error: 'Too many offers — please try again later.' });
    }

    const { productId, amount, name, email, message } = req.body || {};

    // ── Validate ────────────────────────────────────────────────────────────
    const amountCents = Math.round(Number(amount) * 100);
    if (!Number.isFinite(amountCents) || amountCents < 100) {
      return res.status(400).json({ error: 'Please enter a valid offer amount.' });
    }
    if (amountCents > 100000000) { // $1M sanity cap
      return res.status(400).json({ error: 'Offer amount is too large.' });
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
      return res.status(400).json({ error: 'Please enter a valid email so we can respond.' });
    }

    const product = db.prepare('SELECT id, name, price FROM products WHERE id = ? AND active = 1')
                      .get(Number(productId));
    if (!product) {
      return res.status(404).json({ error: 'Product not found.' });
    }

    const cleanName    = String(name    || '').slice(0, 100).trim();
    const cleanEmail   = String(email).slice(0, 200).trim();
    const cleanMessage = String(message || '').slice(0, 500).trim();

    // ── Store ───────────────────────────────────────────────────────────────
    const result = db.prepare(
      `INSERT INTO offers (product_id, product_name, list_price, amount, name, email, message)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(product.id, product.name, product.price, amountCents, cleanName, cleanEmail, cleanMessage);

    // ── Push notification via ntfy.sh (non-fatal on failure) ───────────────
    const topic = process.env.NTFY_TOPIC || 'crg-denny-alerts';
    const fmt   = c => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
    const pct   = product.price ? Math.round((amountCents / product.price) * 100) : null;
    const body  =
      `${product.name}\n` +
      `Offer: ${fmt(amountCents)}${pct ? ` (${pct}% of ${fmt(product.price)})` : ''}\n` +
      `From: ${cleanName || 'No name'} — ${cleanEmail}` +
      (cleanMessage ? `\n"${cleanMessage}"` : '');

    try {
      const r = await fetch(`https://ntfy.sh/${topic}`, {
        method:  'POST',
        headers: {
          'Title':        '💰 New Offer — CardsRG',
          'Priority':     'high',
          'Tags':         'moneybag',
          // ntfy forwards the notification to this inbox as an email too
          'Email':        process.env.OFFER_EMAIL || 'cardsrgshop@gmail.com',
          'Content-Type': 'text/plain; charset=utf-8',
        },
        body,
        signal: AbortSignal.timeout(6000)
      });
      if (!r.ok) console.warn('[offers] ntfy.sh push rejected: HTTP', r.status, await r.text().catch(() => ''));
    } catch (ntfyErr) {
      console.warn('[offers] ntfy.sh push failed:', ntfyErr.message);
    }

    console.log(`[offers] #${result.lastInsertRowid}: ${fmt(amountCents)} on "${product.name}" from ${cleanEmail}`);
    res.json({ ok: true, message: 'Offer received! We\'ll get back to you by email — usually within 24 hours.' });
  } catch (err) {
    console.error('[offers] Error:', err.message);
    res.status(500).json({ error: 'Something went wrong submitting your offer.' });
  }
});

// GET /api/offers — admin only
router.get('/', (req, res) => {
  if (!req.session?.adminId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const offers = db.prepare('SELECT * FROM offers ORDER BY created_at DESC LIMIT 200').all();
  res.json(offers);
});

module.exports = router;
