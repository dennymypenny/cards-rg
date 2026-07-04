/**
 * db.js — SQLite database setup & seed data
 * Uses sql.js (pure JavaScript/WASM — no native compilation required)
 */

const bcrypt = require('bcryptjs');
const path   = require('path');
const fs     = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'store.db');

let sqlDb = null; // raw sql.js Database instance

// ── SAVE DB TO DISK ───────────────────────────────────────────────────────────

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

// ── SCHEMA ────────────────────────────────────────────────────────────────────

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

  CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
  CREATE INDEX IF NOT EXISTS idx_products_active   ON products(active);
  CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_orders_email      ON orders(customer_email);
  CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
`;

// ── SEED ADMIN ────────────────────────────────────────────────────────────────

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
  const SEED_VERSION = '5';
  const verRow = prepare('SELECT value FROM settings WHERE key = ?').get('seed_version');
  if (verRow && verRow.value === SEED_VERSION) return;

  // Clear existing catalog so we can re-seed cleanly
  try {
    prepare('DELETE FROM order_items').run();
    prepare('DELETE FROM orders').run();
    prepare('DELETE FROM products').run();
    prepare('DELETE FROM categories').run();
  } catch(e) { /* ignore if tables missing */ }

  // ── CATEGORIES ──────────────────────────────────────────────────────────────
  const catNBA    = prepare('INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)').run('NBA Basketball', 'nba', 'Iconic NBA rookie cards and game-used memorabilia', 1).lastInsertRowid;
  const catSoccer = prepare('INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)').run('Soccer',         'soccer', 'Grail soccer cards featuring the world\'s greatest players', 2).lastInsertRowid;

  const ins = 'INSERT INTO products (category_id, name, slug, description, price, compare_price, stock, sku, image_url, badge, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)';

  // ── NBA BASKETBALL ───────────────────────────────────────────────────────────
  prepare(ins).run(catNBA,
    'LeBron James 2003-04 Topps Chrome Refractor RC #111',
    'lebron-james-2003-04-topps-chrome-refractor-rc',
    'LeBron James 2003-04 Topps Chrome Refractor Rookie Card #111. One of the most iconic rookie cards in basketball history. The Topps Chrome Refractor is LeBron\'s most sought-after base-brand RC and a cornerstone piece of any serious NBA collection. Sharp corners, great centering, clean surface. Ships in a penny sleeve inside a rigid top-loader, bubble-wrapped for protection.',
    25000, null, 1, 'CRG-LBJ-03-REF', null, 'Hot');

  prepare(ins).run(catNBA,
    'Kobe Bryant 1996-97 Topps Chrome RC #138',
    'kobe-bryant-1996-97-topps-chrome-rc',
    'Kobe Bryant 1996-97 Topps Chrome Rookie Card #138. The original Kobe Chrome rookie — still one of the most recognizable cards in the hobby. Hall of Famer, Los Angeles Lakers legend. A must-have for any Lakers or Kobe collection. Ships double-sleeved in a rigid top-loader, bubble-wrapped and packed securely.',
    80000, null, 1, 'CRG-KB-96-RC', null, 'Hot');

  prepare(ins).run(catNBA,
    'Michael Jordan 1997-98 Fleer Showcase Row 0 #15',
    'michael-jordan-1997-98-fleer-showcase-row-0',
    'Michael Jordan 1997-98 Fleer Showcase Row 0 #15. Fleer Showcase Row 0 is the short-printed top tier of the iconic Showcase set — notoriously hard to find. A true grail piece for any MJ or 90s NBA collection. 6× NBA Champion, Hall of Famer, Chicago Bulls. Ships double-sleeved in a rigid top-loader, securely bubble-wrapped.',
    120000, null, 1, 'CRG-MJ-97-ROW0', null, 'Grail');

  prepare(ins).run(catNBA,
    'Stephen Curry 2009-10 Topps Gold Refractor RC /2009',
    'stephen-curry-2009-10-topps-gold-refractor-rc',
    'Stephen Curry 2009-10 Topps Gold Refractor Rookie Card, serial numbered /2009. A numbered Steph Curry rookie — the man who changed basketball forever. The Gold Refractor parallel is one of the most collectible from his debut year. Serial numbered to 2009. Ships double-sleeved in a rigid top-loader, securely packed.',
    45000, null, 1, 'CRG-SC-09-GOLD', null, 'Numbered');

  prepare(ins).run(catNBA,
    'Kobe Bryant 2000 Leaf Pearl Pearlescent Patch #24 — 3/3',
    'kobe-bryant-2000-leaf-pearl-pearlescent-patch-3-3',
    'Kobe Bryant 2000 Leaf Pearl Pearlescent Patch #24, serial 3/3. ONE OF ONLY THREE IN EXISTENCE. This is one of only three copies of this card ever made — a Kobe Pearlescent Patch numbered 3/3. A once-in-a-collection opportunity. Ultra-premium, ultra-rare. Ships fully insured, signature required. Message for high-value shipping details.',
    150000, null, 1, 'CRG-KB-00-PATCH-3', null, 'Grail');

  // ── SOCCER ──────────────────────────────────────────────────────────────────
  prepare(ins).run(catSoccer,
    'Messi / Pelé / Beckham / Maradona 2021 Leaf Fabled Four Quad Auto /25',
    'messi-pele-beckham-maradona-2021-leaf-fabled-four-quad-auto',
    'Messi / Pelé / Beckham / Maradona — 2021 Leaf Fabled Four #TFF-01, serial /25. Four of the greatest footballers in history on a single quad-autograph card, serial numbered to just 25. Lionel Messi, Pelé, David Beckham, and Diego Maradona — a piece of soccer history. Rare and visually stunning. Ships double-sleeved in a rigid top-loader, securely bubble-wrapped.',
    60000, null, 1, 'CRG-QUAD-AUTO-25', null, 'Grail');

  prepare(ins).run(catSoccer,
    'Lionel Messi 2022 Donruss Pitch Kings Green Parallel SGC 10',
    'lionel-messi-2022-donruss-pitch-kings-green-parallel-sgc-10',
    'Lionel Messi 2022 Donruss Pitch Kings Green Parallel, graded SGC 10 Gem Mint — the highest possible grade. Clean corners, perfect centering, flawless surface. Comes in the original SGC slab. SGC 10 is the pinnacle of card grading. Ships in original SGC slab, bubble-wrapped and boxed securely.',
    40000, null, 1, 'CRG-MESSI-SGC10', null, 'SGC 10');

  // ── NEW CARDS ────────────────────────────────────────────────────────────────
  prepare(ins).run(catSoccer,
    'Lamine Yamal 2026 Panini Monopoly Prizm FIFA World Cup 26 #41 Gold Prizm',
    'lamine-yamal-2026-panini-monopoly-prizm-wc26-gold',
    'Lamine Yamal 2026 Panini Monopoly Prizm FIFA World Cup 26™ #41 — Gold/Rainbow Prizm parallel. The hottest young player on the planet on one of the most eye-catching parallels of the year. Yamal was instrumental in Spain\'s 2024 Euro championship campaign and is widely regarded as the face of the next generation of soccer. The Monopoly Prizm Gold is a stunning holo prizm that catches light from every angle. Ungraded, near-mint condition. Ships double-sleeved in a rigid top-loader, bubble-wrapped for protection.',
    12500, null, 1, 'CRG-LY-26-MONOPOLY-GOLD', '/images/lamine-yamal-2026-prizm-monopoly.jpg', 'Hot');

  prepare(ins).run(catSoccer,
    'Lionel Messi 2022-23 Topps Crystal Premium UCL Clear Cut Careers #LM-1 PSA 10',
    'messi-2022-23-topps-crystal-ucl-clear-cut-careers-psa10',
    'Lionel Messi 2022-23 Topps Crystal Premium UEFA Champions League — Clear Cut Careers #LM-1, graded PSA 10 Gem Mint (cert #82317682). The highest grade possible. This stunning Crystal Premium card captures three different eras of Messi\'s legendary Barcelona career in a single, visually striking design. PSA 10 Gem Mint: perfect corners, perfect centering, flawless surface — as good as it gets. Comes in the original PSA slab. Messi. PSA 10. Need we say more? Ships in original PSA slab, bubble-wrapped and double-boxed securely.',
    35000, null, 1, 'CRG-MESSI-CRYSTAL-PSA10', '/images/messi-2022-crystal-ucl-psa10.jpg', 'PSA 10');

  // Default settings
  const setq = 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)';
  prepare(setq).run('store_name',               process.env.STORE_NAME     || 'CRG Cards');
  prepare(setq).run('store_currency',           process.env.STORE_CURRENCY || 'USD');
  prepare(setq).run('tax_rate',                 '0');
  prepare(setq).run('shipping_flat',            '0');
  prepare(setq).run('free_shipping_threshold',  '0');
  prepare(setq).run('seed_version',             SEED_VERSION);

  console.log('CRG Cards products and categories seeded (v' + SEED_VERSION + ')');
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

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

// ── PUBLIC DB OBJECT ──────────────────────────────────────────────────────────
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

    return this;
  }
};

module.exports = db;
