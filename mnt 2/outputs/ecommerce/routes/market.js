/**
 * routes/market.js — server-side market data for the /board graphs UI
 *
 * GET /api/market → { updated, prices: {slug:{raw,psa10,src,url}}, history: [{t,slug,raw}] }
 *
 * The server fetches TCGplayer raw prices (via pokemontcg.io) itself every
 * REFRESH_HOURS and on boot — no client-side CORS/rate-limit flakiness.
 * History is appended to market-history.json and committed to GitHub via
 * GITHUB_TOKEN so it survives Render's ephemeral disk; restored on boot.
 * Known graded reference points (e.g. Collectr PSA 10 pulls) live in PSA10_REF.
 */

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const router  = express.Router();

const HIST_PATH     = path.join(__dirname, '..', 'market-history.json');
const REFRESH_HOURS = 6;

// pokemontcg.io queries per site slug (Pokémon only; raw ungraded market)
const QUERIES = {
  'rayquaza-vmax-evolving-skies-111-psa10':  'name:"Rayquaza VMAX" number:111 set.id:swsh7',
  'pikachu-vmax-vivid-voltage-044-psa10':    'name:"Pikachu VMAX" number:44 set.id:swsh4',
  'gengar-ex-phantom-forces-34-psa10':       'name:"Gengar EX" number:34 set.id:xy4',
  'charizard-ex-svp-074-paldean-fates-psa10':'name:"Charizard ex" number:74 set.id:svp',
  'zekrom-celebrations-114-psa10':           'name:"Zekrom" set.id:cel25c number:114',
  'reshiram-celebrations-113-psa10':         'name:"Reshiram" set.id:cel25c number:113',
  'volcanion-ex-jtg-182-sir-psa10':          'name:"Volcanion ex" number:182',
  'ionos-kilowattrel-jtg-163-psa10':         'name:"Iono\'s Kilowattrel" number:163',
};

// Graded reference points pulled from Collectr through Denny's session
// (update values when a fresh pull is done; date documents the pull)
const PSA10_REF = {
  'rayquaza-vmax-evolving-skies-111-psa10':  { psa10: 197, asOf: '2026-07-26', src: 'Collectr graded chart' },
  'mega-greninja-ex-cri-116-sir-psa10':      { psa10: 723, raw: 239.29, asOf: '2026-07-27', src: 'Collectr graded chart' },
  'gengar-ex-phantom-forces-34-psa10':       { psa10: 653, raw: 88.28,  asOf: '2026-07-27', src: 'Collectr graded chart' },
  'mega-latias-ex-meg-181-sir-psa10':        { psa10: 240, raw: 92.24,  asOf: '2026-07-27', src: 'Collectr graded chart' },
  'charmander-mep-038-first-partner-psa10':  { psa10: 249, raw: 38.47,  asOf: '2026-07-27', src: 'Collectr graded chart' },
  'rockets-moltres-ex-dri-229-psa10':        { psa10: 325, raw: 107.63, asOf: '2026-07-27', src: 'Collectr graded chart' },
  'mega-charizard-x-ex-pfl-109-psa10':       { psa10: 143, raw: 29.71,  asOf: '2026-07-27', src: 'Collectr graded chart' },
  'luffy-op10-118-alt-art-psa10':            { psa10: 160, raw: 67.83,  asOf: '2026-07-27', src: 'Collectr graded chart' },
  'luffy-op13-118-psa10':                    { psa10: 286, raw: 100.42, asOf: '2026-07-27', src: 'Collectr graded chart' },
};

// PSA cert numbers per slug — enriched with pop counts when PSA_TOKEN env var
// is set on Render (free token: psacard.com → account → API access).
// PSA's public API verifies certs + population data; it has NO prices.
const CERTS = {
  'rockets-moltres-ex-dri-229-psa10': '159704981',
  'luffy-op10-118-alt-art-psa10': '158375940',
  'mega-charizard-x-ex-pfl-109-psa10': '146834547',
  'rayquaza-vmax-evolving-skies-111-psa10': '93418850',
  'charizard-ex-svp-074-paldean-fates-psa10': '124615880',
  'luffy-op13-118-psa10': '155324312',
  'luffy-tarou-op11-005-psa10': '130837550',
};

let cache = { updated: null, prices: {}, history: [] };

async function fetchPsaPop() {
  if (!process.env.PSA_TOKEN) return;
  for (const slug in CERTS) {
    try {
      const r = await fetch('https://api.psacard.com/publicapi/cert/GetByCertNumber/' + CERTS[slug], {
        headers: { 'Authorization': 'Bearer ' + process.env.PSA_TOKEN },
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) continue;
      const d = await r.json();
      const c = d.PSACert || d;
      if (c && (c.TotalPopulation != null || c.PopulationHigher != null)) {
        cache.prices[slug] = { ...(cache.prices[slug] || {}),
          pop: c.TotalPopulation, popHigher: c.PopulationHigher, certVerified: true };
      }
    } catch (e) { /* non-fatal */ }
  }
}

// restore history from disk (repo file, survives deploys once committed)
try {
  if (fs.existsSync(HIST_PATH)) {
    const h = JSON.parse(fs.readFileSync(HIST_PATH, 'utf8'));
    if (Array.isArray(h)) cache.history = h;
  }
} catch (e) { console.warn('[market] history restore failed:', e.message); }

async function fetchOne(q) {
  const url = 'https://api.pokemontcg.io/v2/cards?pageSize=3&q=' + encodeURIComponent(q);
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      for (const c of (d.data || [])) {
        const tp = (c.tcgplayer || {});
        const pr = tp.prices || {};
        for (const v of ['holofoil', 'normal', 'reverseHolofoil']) {
          if (pr[v] && pr[v].market) return { raw: pr[v].market, url: tp.url || '', variant: v };
        }
      }
      return null;
    } catch (e) {
      if (i === 2) throw e;
      await new Promise(res => setTimeout(res, 2000));
    }
  }
}

async function commitHistory(json) {
  if (!process.env.GITHUB_TOKEN) return;
  try {
    const repo     = process.env.GITHUB_REPO || 'dennymypenny/cards-rg';
    const filePath = 'mnt 2/outputs/ecommerce/market-history.json';
    const apiUrl   = `https://api.github.com/repos/${repo}/contents/` +
                     filePath.split('/').map(encodeURIComponent).join('/');
    const headers  = {
      'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
      'Accept':        'application/vnd.github+json',
      'User-Agent':    'cardsrg-hub',
    };
    const cur = await fetch(apiUrl, { headers, signal: AbortSignal.timeout(8000) });
    const sha = cur.ok ? (await cur.json()).sha : undefined;
    await fetch(apiUrl, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Market data refresh (${Object.keys(cache.prices).length} priced)`,
        content: Buffer.from(json).toString('base64'),
        ...(sha ? { sha } : {}),
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) { console.warn('[market] history commit failed:', e.message); }
}

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  const t = Date.now();
  // Guard against the commit->deploy->boot->commit loop: if the newest
  // recorded point is younger than 5h, refresh prices in memory only —
  // no history append, no GitHub commit (which auto-triggers a deploy).
  const lastT = cache.history.length ? Math.max(...cache.history.map(h => h.t)) : 0;
  const record = (t - lastT) > 5 * 60 * 60 * 1000;
  let ok = 0, fail = 0;
  for (const slug in QUERIES) {
    try {
      const got = await fetchOne(QUERIES[slug]);
      if (got) {
        cache.prices[slug] = { raw: got.raw, src: `TCGplayer market (${got.variant}, raw)`, url: got.url };
        if (record) cache.history.push({ t, slug, raw: got.raw });
        ok++;
      }
    } catch (e) { fail++; /* keep last cached value — STALE by omission of update */ }
  }
  // merge graded reference points (+ Collectr raw as fallback where TCGplayer has none)
  for (const slug in PSA10_REF) {
    const ref = PSA10_REF[slug];
    const cur = cache.prices[slug] || {};
    cache.prices[slug] = { ...cur, psa10: ref.psa10, psa10AsOf: ref.asOf, psa10Src: ref.src,
                           ...(cur.raw == null && ref.raw != null ? { raw: ref.raw, src: 'Collectr raw (as of ' + ref.asOf + ')' } : {}) };
  }
  // cap history to ~1 year of 4x-daily points
  if (cache.history.length > 15000) cache.history = cache.history.slice(-15000);
  await fetchPsaPop();
  cache.updated = new Date().toISOString();
  const json = JSON.stringify(cache.history);
  try { fs.writeFileSync(HIST_PATH, json); } catch (e) {}
  if (ok > 0 && record) commitHistory(json);
  console.log(`[market] refresh: ${ok} priced, ${fail} failed`);
  refreshing = false;
}

// boot + interval
refresh();
setInterval(refresh, REFRESH_HOURS * 60 * 60 * 1000);

router.get('/', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json(cache);
});

module.exports = router;
