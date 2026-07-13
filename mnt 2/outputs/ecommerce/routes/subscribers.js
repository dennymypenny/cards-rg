/**
 * routes/subscribers.js — CRG List email signups (drops, giveaways, news)
 *
 * POST /api/subscribe             — public: join the list
 * GET  /api/subscribe             — admin: list subscribers (newest first)
 * GET  /api/subscribe/export.csv  — admin: download the list as CSV
 *
 * Table `subscribers` is plain CREATE IF NOT EXISTS in db.js — survives
 * re-seeds, no SEED_VERSION bump needed.
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db');

// Simple per-IP rate limit: max 5 signup attempts per 10 minutes
const recent = new Map(); // ip -> [timestamps]
function rateLimited(ip) {
  const now  = Date.now();
  const hits = (recent.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  if (hits.length >= 5) return true;
  hits.push(now);
  recent.set(ip, hits);
  return false;
}

// POST /api/subscribe
router.post('/', async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    if (rateLimited(ip)) {
      return res.status(429).json({ error: 'Too many attempts — please try again later.' });
    }

    const { email, name, source } = req.body || {};
    const cleanEmail = String(email || '').slice(0, 200).trim().toLowerCase();
    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email.' });
    }
    const cleanName   = String(name   || '').slice(0, 100).trim();
    const cleanSource = String(source || 'popup').slice(0, 40).trim() || 'popup';

    const existing = db.prepare('SELECT id FROM subscribers WHERE email = ?').get(cleanEmail);
    if (existing) {
      return res.json({ ok: true, already: true, message: 'You\'re already on the list — you\'re all set! 🎉' });
    }

    db.prepare('INSERT INTO subscribers (email, name, source) VALUES (?, ?, ?)')
      .run(cleanEmail, cleanName || null, cleanSource);

    // Push notification via ntfy.sh (non-fatal on failure)
    const topic = process.env.NTFY_TOPIC || 'crg-denny-alerts';
    try {
      const count = db.prepare('SELECT COUNT(*) AS n FROM subscribers').get()?.n;
      await fetch(`https://ntfy.sh/${topic}`, {
        method:  'POST',
        headers: {
          'Title':        '📧 New CRG List signup',
          'Tags':         'email',
          'Content-Type': 'text/plain; charset=utf-8',
        },
        body: `${cleanEmail}${cleanName ? ` (${cleanName})` : ''}\nList total: ${count}`,
        signal: AbortSignal.timeout(4000)
      });
    } catch (ntfyErr) {
      console.warn('[subscribers] ntfy.sh push failed:', ntfyErr.message);
    }

    console.log(`[subscribers] + ${cleanEmail} (${cleanSource})`);
    res.json({ ok: true, message: 'You\'re in! First dibs on drops & giveaways. 🔥' });
  } catch (err) {
    console.error('[subscribers] Error:', err.message);
    res.status(500).json({ error: 'Something went wrong — please try again.' });
  }
});

// GET /api/subscribe — admin only
router.get('/', (req, res) => {
  if (!req.session?.adminId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const subs = db.prepare('SELECT * FROM subscribers ORDER BY created_at DESC LIMIT 1000').all();
  res.json(subs);
});

// GET /api/subscribe/export.csv — admin only
router.get('/export.csv', (req, res) => {
  if (!req.session?.adminId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const subs = db.prepare('SELECT email, name, source, created_at FROM subscribers ORDER BY created_at DESC').all();
  const esc  = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv  = ['email,name,source,signed_up']
    .concat(subs.map(s => [s.email, s.name, s.source, s.created_at].map(esc).join(',')))
    .join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="crg-email-list.csv"');
  res.send(csv);
});

module.exports = router;
