/**
 * routes/track.js — first-party, cookie-free site analytics for cardsrg.com
 *
 * POST /api/track            { t:'view'|'click'|'leave', sid, p, r, utm, w, label, ms, scroll }
 * GET  /api/track/events?since=<ms>&key=<STATS_KEY>   raw events (for the Pulse dashboard task)
 * GET  /api/track/summary?key=<STATS_KEY>              quick aggregate for the last 30 days
 *
 * Events live in SQLite, which Render wipes on every deploy, so the Pulse
 * scheduled task pulls raw events every few hours and keeps its own copy.
 * Set STATS_KEY on Render to protect the read endpoints (defaults to 'crg').
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db');
const crypto  = require('crypto');

db.exec(`CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  t TEXT NOT NULL,
  sid TEXT,
  vid TEXT,
  p TEXT,
  r TEXT,
  utm TEXT,
  w INTEGER,
  c TEXT,
  label TEXT,
  ms INTEGER,
  scroll INTEGER
)`);

const KEY = process.env.STATS_KEY || 'crg';
function authed(req) { return (req.query.key || req.get('x-stats-key')) === KEY; }

function cleanRef(r) {
  try {
    if (!r) return '';
    const h = new URL(r).hostname.replace(/^www\./, '');
    if (/cardsrg\.com$/.test(h)) return '';
    if (/instagram\.com|l\.instagram/.test(h)) return 'instagram.com';
    if (/facebook\.com|fb\.com|lm\.facebook/.test(h)) return 'facebook.com';
    if (/t\.co|twitter\.com|x\.com/.test(h)) return 'x.com';
    if (/youtube\.com|youtu\.be/.test(h)) return 'youtube.com';
    if (/ebay\./.test(h)) return 'ebay.com';
    if (/google\./.test(h)) return 'google.com';
    return h;
  } catch (e) { return ''; }
}

router.post('/', (req, res) => {
  try {
    const b = req.body || {};
    const t = String(b.t || '');
    if (!['view', 'click', 'leave'].includes(t)) return res.status(400).json({ ok: false });
    // anonymous visitor id: hash of IP + UA + day (rotates daily; no cookie, nothing personal stored)
    const ip = req.ip || '';
    const day = new Date().toISOString().slice(0, 10);
    const vid = crypto.createHash('sha256').update(ip + '|' + (req.get('user-agent') || '') + '|' + day).digest('hex').slice(0, 16);
    const country = req.get('cf-ipcountry') || '';
    db.prepare(`INSERT INTO events (at,t,sid,vid,p,r,utm,w,c,label,ms,scroll) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      Date.now(), t,
      String(b.sid || '').slice(0, 32), vid,
      String(b.p || '/').slice(0, 120),
      cleanRef(b.r).slice(0, 80),
      String(b.utm || '').slice(0, 60),
      Math.min(Number(b.w) || 0, 10000),
      country.slice(0, 2),
      String(b.label || '').slice(0, 120),
      Math.min(Number(b.ms) || 0, 3600000),
      Math.min(Number(b.scroll) || 0, 100)
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false }); }
});

router.get('/events', (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });
  const since = Number(req.query.since) || (Date.now() - 60 * 864e5);
  const rows = db.prepare('SELECT at,t,sid,vid,p,r,utm,w,c,label,ms,scroll FROM events WHERE at > ? ORDER BY at ASC LIMIT 20000').all(since);
  res.json({ now: Date.now(), events: rows });
});

router.get('/summary', (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });
  const since = Date.now() - 30 * 864e5;
  const views    = db.prepare("SELECT COUNT(*) n FROM events WHERE t='view' AND at>?").get(since).n;
  const visitors = db.prepare("SELECT COUNT(DISTINCT vid) n FROM events WHERE t='view' AND at>?").get(since).n;
  const clicks   = db.prepare("SELECT COUNT(*) n FROM events WHERE t='click' AND at>?").get(since).n;
  const refs     = db.prepare("SELECT r, COUNT(*) n FROM events WHERE t='view' AND at>? GROUP BY r ORDER BY n DESC LIMIT 10").all(since);
  const top      = db.prepare("SELECT label, COUNT(*) n FROM events WHERE t='click' AND at>? GROUP BY label ORDER BY n DESC LIMIT 10").all(since);
  res.json({ days: 30, views, visitors, clicks, referrers: refs, top_clicks: top });
});

module.exports = router;
