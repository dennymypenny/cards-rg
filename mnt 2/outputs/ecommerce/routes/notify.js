/**
 * routes/notify.js — Push notifications via ntfy.sh (free, no signup)
 *
 * Denny subscribes to his topic at: https://ntfy.sh/crg-denny-alerts
 * Or via the ntfy mobile app (iOS / Android) — search topic: crg-denny-alerts
 *
 * Set a custom topic with env var NTFY_TOPIC to keep it private.
 */

const express = require('express');
const router  = express.Router();

// In-memory cart activity log (persists until server restart)
const cartActivity = [];

// POST /api/notify/cart  — called by frontend when a card is added to cart
router.post('/cart', async (req, res) => {
  try {
    const { cert, subject, brand, price, variation, serial, grade } = req.body || {};

    const event = {
      cert:      cert      || '—',
      subject:   subject   || 'Unknown card',
      brand:     brand     || '',
      price:     price     || '',
      variation: variation || '',
      serial:    serial    || '—',
      grade:     grade     || '—',
      timestamp: new Date().toISOString(),
      ip:        req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown'
    };

    cartActivity.unshift(event);
    if (cartActivity.length > 200) cartActivity.pop(); // keep last 200 events

    // ── Push notification via ntfy.sh ──────────────────────────────────────
    const topic = process.env.NTFY_TOPIC || 'crg-denny-alerts';
    const extras = [variation, serial !== '—' ? serial : null, grade !== '—' ? grade : null]
      .filter(Boolean).join(' · ');
    const body = `${subject} — ${price}${extras ? '\n' + extras : ''}`;

    try {
      await fetch(`https://ntfy.sh/${topic}`, {
        method:  'POST',
        headers: {
          'Title':        '🛒 Cart Activity — CRG Cards',
          'Priority':     'default',
          'Tags':         'shopping_cart',
          'Content-Type': 'text/plain; charset=utf-8',
        },
        body,
        signal: AbortSignal.timeout(4000) // 4 s max — never block cart UX
      });
    } catch (ntfyErr) {
      // ntfy failure is non-fatal
      console.warn('[notify] ntfy.sh push failed:', ntfyErr.message);
    }

    console.log(`[notify] Cart add: ${subject} (${price})`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[notify] Error:', err.message);
    res.status(500).json({ ok: false });
  }
});

// GET /api/notify/cart-activity  — recent additions (admin-session required)
router.get('/cart-activity', (req, res) => {
  if (!req.session?.adminId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json(cartActivity);
});

module.exports = { router, cartActivity };
