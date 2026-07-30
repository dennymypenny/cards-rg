/**
 * db.js — SQLite database setup & seed data
 * Uses sql.js (pure JavaScript/WASM — no native compilation required)
 */

const bcrypt = require('bcryptjs');
const path   = require('path');
const fs     = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'store.db');

let sqlDb = null; // raw sql.js Database instance

// ── SAVE DB TO DISK ────────────────────────────────────────────────────────

function saveDb() {
  if (!sqlDb) return;
  try {
    const data = sqlDb.export();
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (e) {
    console.error('Warning: could not save database:', e.message);
  }
}

// Save on process exit
process.on('exit', saveDb);
process.on('SIGINT',  () => { saveDb(); process.exit(0); });
process.on('SIGTERM', () => { saveDb(); process.exit(0); });

// ── PARAMETER NORMALIZER ──────────────────────────────────────────────────────

function normalizeParams(args) {
  if (args.length === 0) return [];
  if (args.length === 1 && Array.isArray(args[0])) return args[0];
  return Array.from(args);
}

// ── PREPARED STATEMENT WRAPPER ────────────────────────────────────────────────
// Provides a better-sqlite3-compatible API on top of sql.js

function prepare(sql) {
  return {
    // Execute a write statement, returns { lastInsertRowid, changes }
    run(...args) {
      const params = normalizeParams(args);
      sqlDb.run(sql, params);
      const idResult = sqlDb.exec('SELECT last_insert_rowid()');
      const lastInsertRowid = idResult[0]?.values[0]?.[0] ?? 0;
      const changes = sqlDb.getRowsModified();
      saveDb();
      return { lastInsertRowid, changes };
    },

    // Fetch a single row as an object (or undefined)
    get(...args) {
      const params = normalizeParams(args);
      const stmt = sqlDb.prepare(sql);
      try {
        stmt.bind(params);
        if (stmt.step()) return stmt.getAsObject();
        return undefined;
      } finally {
        stmt.free();
      }
    },

    // Fetch all matching rows as an array of objects
    all(...args) {
      const params = normalizeParams(args);
      const stmt = sqlDb.prepare(sql);
      const results = [];
      try {
        stmt.bind(params);
        while (stmt.step()) results.push(stmt.getAsObject());
      } finally {
        stmt.free();
      }
      return results;
    }
  };
}

// ── TRANSACTION WRAPPER ───────────────────────────────────────────────────────

function transaction(fn) {
  return function (...args) {
    sqlDb.run('BEGIN');
    try {
      const result = fn(...args);
      sqlDb.run('COMMIT');
      saveDb();
      return result;
    } catch (e) {
      sqlDb.run('ROLLBACK');
      throw e;
    }
  };
}

// ── EXEC (multi-statement SQL) ────────────────────────────────────────────────

function exec(sql) {
  sqlDb.exec(sql);
  saveDb();
}

// ── SCHEMA ───────────────────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS admins (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    email       TEXT    UNIQUE NOT NULL,
    password    TEXT    NOT NULL,
    name        TEXT    NOT NULL DEFAULT 'Admin',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    slug        TEXT    UNIQUE NOT NULL,
    description TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS products (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    name          TEXT    NOT NULL,
    slug          TEXT    UNIQUE NOT NULL,
    description   TEXT,
    price         INTEGER NOT NULL,
    compare_price INTEGER,
    stock         INTEGER NOT NULL DEFAULT 0,
    sku           TEXT,
    image_url     TEXT,
    badge         TEXT,
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS orders (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number     TEXT    UNIQUE NOT NULL,
    stripe_session   TEXT    UNIQUE,
    stripe_payment   TEXT,
    status           TEXT    NOT NULL DEFAULT 'pending',
    customer_name    TEXT    NOT NULL,
    customer_email   TEXT    NOT NULL,
    customer_phone   TEXT,
    shipping_address TEXT,
    subtotal         INTEGER NOT NULL,
    shipping         INTEGER NOT NULL DEFAULT 0,
    tax              INTEGER NOT NULL DEFAULT 0,
    total            INTEGER NOT NULL,
    notes            TEXT,
    created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
    name       TEXT    NOT NULL,
    price      INTEGER NOT NULL,
    quantity   INTEGER NOT NULL,
    subtotal   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS offers (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id   INTEGER REFERENCES products(id) ON DELETE SET NULL,
    product_name TEXT    NOT NULL,
    list_price   INTEGER,
    amount       INTEGER NOT NULL,
    name         TEXT,
    email        TEXT    NOT NULL,
    message      TEXT,
    status       TEXT    NOT NULL DEFAULT 'new',
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS subscribers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT    UNIQUE NOT NULL,
    name       TEXT,
    source     TEXT    NOT NULL DEFAULT 'popup',
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
  CREATE INDEX IF NOT EXISTS idx_products_active   ON products(active);
  CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_orders_email      ON orders(customer_email);
  CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
  CREATE INDEX IF NOT EXISTS idx_offers_status     ON offers(status);
`;

// ── SEED ADMIN ──────────────────────────────────────────────────────────

function seedAdmin() {
  const existing = prepare('SELECT id FROM admins LIMIT 1').get();
  const email    = process.env.ADMIN_EMAIL    || 'admin@yourstore.com';
  const password = process.env.ADMIN_PASSWORD || '1134';
  const hash     = bcrypt.hashSync(password, 12);

  if (!existing) {
    prepare('INSERT INTO admins (email, password, name) VALUES (?, ?, ?)').run(email, hash, 'Admin');
    console.log(`✅ Admin account created: ${email}`);
  } else if (process.env.ADMIN_PASSWORD) {
    // Sync password & email from env var on every startup so Render env changes take effect
    prepare('UPDATE admins SET password = ?, email = ? WHERE id = ?').run(hash, email, existing.id);
    console.log(`🔄 Admin credentials synced from env vars`);
  }
}

// ── SEED SAMPLE PRODUCTS ──────────────────────────────────────────────────────

function seedSampleData() {
  // Version-gated re-seed: bump 'seed_version' to force a fresh seed on next deploy
  const SEED_VERSION = '23';
  const verRow = prepare('SELECT value FROM settings WHERE key = ?').get('seed_version');
  if (verRow && verRow.value === SEED_VERSION) return;

  // Clear existing catalog so we can re-seed cleanly
  try {
    prepare('DELETE FROM order_items').run();
    prepare('DELETE FROM orders').run();
    prepare('DELETE FROM products').run();
    prepare('DELETE FROM categories').run();
  } catch(e) { /* ignore if tables missing */ }

  // ── CATEGORIES ─────────────────────────────────────────────────────────
  const catSoccer  = prepare('INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)').run('Soccer',         'soccer',       'Grail soccer cards featuring the world\'s g[...]', 1);
  const catNBA     = prepare('INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)').run('NBA Basketball', 'nba',          'Iconic NBA cards and game-used memorabilia[...]', 2);
  const catFootball = prepare('INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)').run('Football',      'football',     'NFL football grails, patches, autos, and vi[...]', 3);
  const catOther   = prepare('INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)').run('Collectibles',   'collectibles', 'Rare non-sport and pop culture collectible [...]', 4);
  const catPokemon = prepare('INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)').run('Pokémon',        'pokemon',      'Rare and graded Pokémon cards — holos, [...]', 5);

  const ins = 'INSERT INTO products (category_id, name, slug, description, price, compare_price, stock, sku, image_url, badge, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)';

  // ── SOCCER ──────────────────────────────────────────────────────────
  prepare(ins).run(catSoccer,
    'Lionel Messi 2023 Leaf Metal Anime Nation "Leo the Lion" #ANB-30 /373 PSA 10',
    'messi-2023-leaf-anime-nation-anb30-psa10',
    'Lionel Messi 2023 Leaf Metal Anime Nation — "Leo the Lion" #ANB-30, serial numbered 45/373, graded PSA 10 Gem Mint (cert #76705063). Stunning anime artwork by Japanese manga/caricature art[...]',
    32000, null, 1, 'CRG-MESSI-ANIME-NATION-PSA10', '/images/messi-anime-nation-anb30.jpg', 'Numbered');

  // ... (seeded product inserts omitted for brevity) ...

  // Removed (Jul 27 2026): Luffy-Tarou OP11 $730 — off storefront per Denny
  prepare('UPDATE products SET active = 0, updated_at = datetime(\'now\') WHERE slug = ? AND active = 1')
    .run('luffy-tarou-op11-005-psa10');

  // New add (Jul 27 2026): Uta EB03-003 Special Alternate Art PSA 10
  addIfMissing('one-piece',
    'Uta 2026 One Piece EB03 #003 Special Alternate Art PSA 10',
    'uta-eb03-003-sp-alt-art-psa10',
    'Uta — 2026 One Piece Card Game Extra Booster 3: Heroines Edition, Special Alternate Art #EB03-003, graded PSA 10 GEM MINT (cert #154831634). The FILM RED songstress in a breathtaking sta[...]',
    82000, 'CRG-UTA-EB03-003-SP-PSA10', '/images/uta-eb03-003-sp-alt-art-psa10.jpg', 'PSA 10');

  // New adds (Jul 27 2026): One Piece trio — Buggy OP09, Boa Hancock ST17, Ace OP07 3rd Anniv
  addIfMissing('one-piece',
    'Buggy 2024 One Piece OP09 #051 Alternate Art PSA 10',
    'buggy-op09-051-alt-art-psa10',
    'Buggy — 2024 One Piece Card Game OP09: Emperors in the New World, Alternate Art #OP09-051, graded PSA 10 GEM MINT (cert #120423945). The Four Emperors / Cross Guild clown himself looming[...]',
    15000, 'CRG-BUGGY-OP09-051-PSA10', '/images/buggy-op09-051-alt-art-psa10.jpg', 'PSA 10');
  addIfMissing('one-piece',
    'Boa Hancock 2025 One Piece Illustration Box Vol.1 #004 PSA 10',
    'boa-hancock-st17-004-illustration-box-psa10',
    'Boa Hancock — 2025 One Piece Card Game Illustration Box Vol.1 #ST17-004, graded PSA 10 GEM MINT (cert #150654688). The Pirate Empress of the Kuja Pirates in a stunning Illustration Box [...]',
    22500, 'CRG-BOA-HANCOCK-ST17-004-PSA10', '/images/boa-hancock-st17-004-illustration-box-psa10.jpg', 'PSA 10');
  addIfMissing('one-piece',
    'Portgas D. Ace 2025 One Piece OP07 #053 3rd Anniversary Winner PSA 10',
    'ace-op07-053-3rd-anniversary-winner-psa10',
    'Portgas D. Ace — 2025 One Piece Card Game OP07-053, 3rd Anniversary "3 Brothers" PK-Winner promo, graded PSA 10 GEM MINT (cert #151899662). A tournament-only Winner promo with the 3rd A[...]',
    26000, 'CRG-ACE-OP07-053-3RDANV-PSA10', '/images/ace-op07-053-3rd-anniversary-winner-psa10.jpg', 'PSA 10');

  // NOTE: Removed the Luffy ST01-012 addIfMissing seed entry here to prevent it from being re-added on future re-seeds.

  // SOLD on eBay (Jul 28 2026): Luffy OP10-118 Alt Art (Royal Blood) — remove from storefront
  prepare('UPDATE products SET active = 0, updated_at = datetime(\'now\') WHERE slug = ? AND active = 1')
    .run('luffy-op10-118-alt-art-psa10');

  // SOLD on eBay (Jul 30 2026): Monkey D. Luffy 2023 — remove from storefront
  prepare('UPDATE products SET active = 0, updated_at = datetime(\'now\') WHERE slug = ? AND active = 1')
    .run('luffy-st01-012-1st-anniversary-psa10');

  // SOLD on eBay (Jul 28 2026): Boa Hancock ST17-004 Illustration Box — remove from storefront
  prepare('UPDATE products SET active = 0, updated_at = datetime(\'now\') WHERE slug = ? AND active = 1')
    .run('boa-hancock-st17-004-illustration-box-psa10');

  // ── PRICE OVERRIDES (set from /hub price editor) ─────────────────────────
  // Applied on every boot, AFTER all seeds/one-off fixes, so hub-made price
  // changes survive Render's ephemeral disk. The hub's price endpoint keeps
  // this file current (and commits it to GitHub when GITHUB_TOKEN is set).
  try {
    const ovPath = path.join(__dirname, 'price-overrides.json');
    if (fs.existsSync(ovPath)) {
      const overrides = JSON.parse(fs.readFileSync(ovPath, 'utf8')) || {};
      for (const [slug, cents] of Object.entries(overrides)) {
        const c = Math.round(Number(cents));
        if (Number.isFinite(c) && c >= 100) {
          prepare('UPDATE products SET price = ?, updated_at = datetime(\'now\') WHERE slug = ? AND price <> ?')
            .run(c, slug, c);
        }
      }
    }
  } catch (e) {
    console.warn('Warning: could not apply price-overrides.json:', e.message);
  }
  saveDb();

  return this;
}

// ── HELPERS ───────────────────────────────────────────────────────────

const helpers = {
  formatPrice(cents) {
    return (cents / 100).toFixed(2);
  },

  generateOrderNumber() {
    const now = new Date();
    const ymd  = now.toISOString().slice(2, 10).replace(/-/g, '');
    const rand = Math.floor(Math.random() * 9000 + 1000);
    return `ORD-${ymd}-${rand}`;
  },

  getSettings() {
    const rows = prepare('SELECT key, value FROM settings').all();
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  },

  updateSetting(key, value) {
    prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  }
};

// ── PUBLIC DB OBJECT ────────────────────────────────────────────────────────
// Exposes a better-sqlite3-compatible interface

const db = {
  prepare,
  exec,
  transaction,
  helpers,

  // Async initializer — call once at startup before routes handle requests
  async init() {
    if (sqlDb) return this; // already initialized

    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs({
      locateFile: file => path.join(require.resolve('sql.js'), '..', file)
    });

    // Load existing DB from disk, or create fresh
    if (fs.existsSync(DB_PATH)) {
      const buffer = fs.readFileSync(DB_PATH);
      sqlDb = new SQL.Database(buffer);
      console.log('✅ Database loaded from disk');
    } else {
      sqlDb = new SQL.Database();
      console.log('✅ New database created');
    }

    // Enable foreign keys
    sqlDb.run('PRAGMA foreign_keys = ON');

    // Create schema
    sqlDb.exec(SCHEMA);
    saveDb();

    // Seed data
    seedAdmin();
    seedSampleData();

    // One-off catalog fixes (idempotent — no re-seed, orders untouched)
    prepare('UPDATE products SET active = 0, updated_at = datetime(\'now\') WHERE slug = ? AND active = 1')
      .run('marino-1996-ud-alltime-records-2420-5000');

    // SOLD (Jul 11 2026): Marino Quad Patch Auto + Mickey Lorcana D100 — remove from storefront
    prepare('UPDATE products SET active = 0, updated_at = datetime(\'now\') WHERE slug = ? AND active = 1')
      .run('marino-2022-panini-one-quad-patch-auto-10-15');
    prepare('UPDATE products SET active = 0, updated_at = datetime(\'now\') WHERE slug = ? AND active = 1')
      .run('mickey-2023-lorcana-d100-collectors-edition-psa10');

    // Price drop (Jul 11 2026): Messi Anime Nation "Leo the Lion" → $320
    prepare('UPDATE products SET price = 32000, updated_at = datetime(\'now\') WHERE slug = ? AND price <> 32000')
      .run('messi-2023-leaf-anime-nation-anb30-psa10');

    // Kobe/Messi Leaf Pearl: corrected to dual-sided PP2-3 with Messi front (Jul 2026)
    prepare('UPDATE products SET name = ?, description = ?, image_url = ?, updated_at = datetime(\'now\') WHERE slug = ?')
      .run(
        'Lionel Messi / Kobe Bryant 2021-22 Leaf Pearl Dual Pearlescent Patch #PP2-3 — 3/3',
        'Lionel Messi / Kobe Bryant 2021-22 Leaf Pearl Multi-Sport — Dual Pearlescent Patch #PP2-3, serial numbered 3/3. ONE OF ONLY THREE COPIES IN EXISTENCE. Two of the greatest athletes who [...]',
        '/images/kobe-messi-leaf-pearl-pp2-3.jpg',
        'kobe-bryant-2000-leaf-pearl-pearlescent-patch-3-3');

    // New products added without re-seed (idempotent by slug; also in seed for future re-seeds)
    const addIfMissing = (catSlug, name, slug, desc, price, sku, image, badge) => {
      if (prepare('SELECT id FROM products WHERE slug = ?').get(slug)) return;
      const cat = prepare('SELECT id FROM categories WHERE slug = ?').get(catSlug);
      if (!cat) return;
      prepare('INSERT INTO products (category_id, name, slug, description, price, compare_price, stock, sku, image_url, badge, active) VALUES (?, ?, ?, ?, ?, null, 1, ?, ?, ?, 1)')
        .run(cat.id, name, slug, desc, price, sku, image, badge);
    };

    // ... (many addIfMissing calls omitted for brevity) ...

    // Removed (Jul 27 2026): Luffy-Tarou OP11 $730 — off storefront per Denny
    prepare('UPDATE products SET active = 0, updated_at = datetime(\'now\') WHERE slug = ? AND active = 1')
      .run('luffy-tarou-op11-005-psa10');

    // New add (Jul 27 2026): Uta EB03-003 Special Alternate Art PSA 10
    addIfMissing('one-piece',
      'Uta 2026 One Piece EB03 #003 Special Alternate Art PSA 10',
      'uta-eb03-003-sp-alt-art-psa10',
      'Uta — 2026 One Piece Card Game Extra Booster 3: Heroines Edition, Special Alternate Art #EB03-003, graded PSA 10 GEM MINT (cert #154831634). The FILM RED songstress in a breathtaking sta[...]',
      82000, 'CRG-UTA-EB03-003-SP-PSA10', '/images/uta-eb03-003-sp-alt-art-psa10.jpg', 'PSA 10');

    // New adds (Jul 27 2026): One Piece trio — Buggy OP09, Boa Hancock ST17, Ace OP07 3rd Anniv
    addIfMissing('one-piece',
      'Buggy 2024 One Piece OP09 #051 Alternate Art PSA 10',
      'buggy-op09-051-alt-art-psa10',
      'Buggy — 2024 One Piece Card Game OP09: Emperors in the New World, Alternate Art #OP09-051, graded PSA 10 GEM MINT (cert #120423945). The Four Emperors / Cross Guild clown himself looming[...]',
      15000, 'CRG-BUGGY-OP09-051-PSA10', '/images/buggy-op09-051-alt-art-psa10.jpg', 'PSA 10');
    addIfMissing('one-piece',
      'Boa Hancock 2025 One Piece Illustration Box Vol.1 #004 PSA 10',
      'boa-hancock-st17-004-illustration-box-psa10',
      'Boa Hancock — 2025 One Piece Card Game Illustration Box Vol.1 #ST17-004, graded PSA 10 GEM MINT (cert #150654688). The Pirate Empress of the Kuja Pirates in a stunning Illustration Box [...]',
      22500, 'CRG-BOA-HANCOCK-ST17-004-PSA10', '/images/boa-hancock-st17-004-illustration-box-psa10.jpg', 'PSA 10');
    addIfMissing('one-piece',
      'Portgas D. Ace 2025 One Piece OP07 #053 3rd Anniversary Winner PSA 10',
      'ace-op07-053-3rd-anniversary-winner-psa10',
      'Portgas D. Ace — 2025 One Piece Card Game OP07-053, 3rd Anniversary "3 Brothers" PK-Winner promo, graded PSA 10 GEM MINT (cert #151899662). A tournament-only Winner promo with the 3rd A[...]',
      26000, 'CRG-ACE-OP07-053-3RDANV-PSA10', '/images/ace-op07-053-3rd-anniversary-winner-psa10.jpg', 'PSA 10');

    // SOLD on eBay (Jul 28 2026): Luffy OP10-118 Alt Art (Royal Blood) — remove from storefront
    prepare('UPDATE products SET active = 0, updated_at = datetime(\'now\') WHERE slug = ? AND active = 1')
      .run('luffy-op10-118-alt-art-psa10');

    // SOLD on eBay (Jul 30 2026): Monkey D. Luffy 2023 — remove from storefront
    prepare('UPDATE products SET active = 0, updated_at = datetime(\'now\') WHERE slug = ? AND active = 1')
      .run('luffy-st01-012-1st-anniversary-psa10');

    // SOLD on eBay (Jul 28 2026): Boa Hancock ST17-004 Illustration Box — remove from storefront
    prepare('UPDATE products SET active = 0, updated_at = datetime(\'now\') WHERE slug = ? AND active = 1')
      .run('boa-hancock-st17-004-illustration-box-psa10');

    // ── PRICE OVERRIDES (set from /hub price editor) ─────────────────────────
    // Applied on every boot, AFTER all seeds/one-off fixes, so hub-made price
    // changes survive Render's ephemeral disk. The hub's price endpoint keeps
    // this file current (and commits it to GitHub when GITHUB_TOKEN is set).
    try {
      const ovPath = path.join(__dirname, 'price-overrides.json');
      if (fs.existsSync(ovPath)) {
        const overrides = JSON.parse(fs.readFileSync(ovPath, 'utf8')) || {};
        for (const [slug, cents] of Object.entries(overrides)) {
          const c = Math.round(Number(cents));
          if (Number.isFinite(c) && c >= 100) {
            prepare('UPDATE products SET price = ?, updated_at = datetime(\'now\') WHERE slug = ? AND price <> ?')
              .run(c, slug, c);
          }
        }
      }
    } catch (e) {
      console.warn('Warning: could not apply price-overrides.json:', e.message);
    }
    saveDb();

    return this;
  }
};

module.exports = db;
