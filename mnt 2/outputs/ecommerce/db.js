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
  const SEED_VERSION = '8';
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
  const catSoccer = prepare('INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)').run('Soccer',         'soccer',       'Grail soccer cards featuring the world\'s greatest players', 1).lastInsertRowid;
  const catNBA    = prepare('INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)').run('NBA Basketball', 'nba',          'Iconic NBA cards and game-used memorabilia', 2).lastInsertRowid;
  const catOther  = prepare('INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)').run('Collectibles',   'collectibles', 'Rare non-sport and pop culture collectible cards', 3).lastInsertRowid;

  const ins = 'INSERT INTO products (category_id, name, slug, description, price, compare_price, stock, sku, image_url, badge, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)';

  // ── SOCCER ──────────────────────────────────────────────────────────────────
  prepare(ins).run(catSoccer,
    'Lionel Messi 2022 Topps ARG Fileteado AFA Disc #DI4 PSA 10',
    'messi-2022-topps-arg-fileteado-afa-disc-psa10',
    'Lionel Messi 2022 Topps ARG Fileteado — AFA Disc #DI4, graded PSA 10 Gem Mint (cert #86725240). An incredibly unique Argentine format — the Fileteado disc card is a one-of-a-kind design exclusive to the Argentine market, featuring Messi in the iconic Albiceleste. PSA 10 GEM MINT: perfect corners, perfect centering, flawless surface. Comes in original PSA slab.',
    90000, null, 1, 'CRG-MESSI-ARG-DISC-PSA10', '/images/messi_psa10_post.jpg', 'PSA 10');

  prepare(ins).run(catSoccer,
    'Lionel Messi 2018 Panini Adrenalyn XL FIFA WC Road to Russia Ltd. Ed. PSA 10',
    'messi-2018-panini-adrenalyn-xl-wc-road-russia-psa10',
    'Lionel Messi 2018 Panini Adrenalyn XL FIFA World Cup — Road to Russia Limited Edition, graded PSA 10 Gem Mint (cert #93183045). A Limited Edition from the iconic 2018 WC cycle. PSA 10 Gem Mint in the original slab. Pre-WC Messi in pristine condition — a clean, sharp piece for any collection.',
    25000, null, 1, 'CRG-MESSI-ADRENALYN-PSA10', '/images/messi_adrenalyn_front.jpg', 'PSA 10');

  prepare(ins).run(catSoccer,
    'Lionel Messi 2023 Topps Chrome MLS Big City Strikers Gold Refractor #BCS7 /50 PSA 10',
    'messi-2023-topps-chrome-mls-big-city-strikers-gold-refractor-psa10',
    'Lionel Messi 2023 Topps Chrome MLS — Big City Strikers Gold Refractor #BCS7, serial numbered /50, graded PSA 10 Gem Mint (cert #89157561). Messi in his Inter Miami era on a stunning Gold Refractor, numbered to just 50. PSA 10 perfection. One of the hottest Messi MLS cards in the hobby.',
    240000, null, 1, 'CRG-MESSI-MLS-GOLD-50-PSA10', '/images/messi_chrome_gold_front.jpg', 'Numbered');

  prepare(ins).run(catSoccer,
    'Lionel Messi 2022 Donruss Pitch Kings Green Parallel SGC 10',
    'messi-2022-donruss-pitch-kings-green-parallel-sgc10',
    'Lionel Messi 2022 Donruss Pitch Kings — Green Parallel, graded SGC 10 Gem Mint. The highest possible grade. Clean corners, perfect centering, flawless surface. A bold and vibrant design — the Pitch Kings insert is one of the most visually striking in the Donruss Soccer lineup. Comes in original SGC slab.',
    40000, null, 1, 'CRG-MESSI-PITCH-KINGS-SGC10', '/images/messi-pitch-kings-2022.jpg', 'SGC 10');

  prepare(ins).run(catSoccer,
    'Messi / Pelé / Beckham / Maradona 2021 Leaf Fabled Four #TFF-01 /25',
    'messi-pele-beckham-maradona-2021-leaf-fabled-four-25',
    'Messi / Pelé / Beckham / Maradona — 2021 Leaf Fabled Four #TFF-01, serial numbered /25. Four of the greatest footballers in history on one card, numbered to just 25. Lionel Messi, Pelé, David Beckham, and Diego Maradona — an absolutely iconic piece of soccer history. Raw but stunning.',
    60000, null, 1, 'CRG-FABLED-FOUR-25', '/images/leaf-fabled-four-tff01.jpg', 'Numbered');

  prepare(ins).run(catSoccer,
    'Lionel Messi 2022-23 Topps Crystal UCL Clear Cut Careers #LM-1 PSA 10',
    'messi-2022-topps-crystal-ucl-psa10',
    'Lionel Messi 2022-23 Topps Crystal Premium UEFA Champions League — Clear Cut Careers #LM-1, graded PSA 10 Gem Mint (cert #82317682). A stunning Crystal Premium card capturing Messi\'s legendary Barcelona career. PSA 10: perfect corners, perfect centering, flawless surface. Comes in original PSA slab.',
    38000, null, 1, 'CRG-MESSI-CRYSTAL-PSA10', '/images/messi-2022-crystal-ucl-psa10.jpg', 'PSA 10');

  prepare(ins).run(catSoccer,
    'Lamine Yamal 2026 Panini Monopoly Prizm FIFA World Cup 26',
    'lamine-yamal-2026-panini-monopoly-prizm-wc26',
    'Lamine Yamal 2026 Panini Monopoly Prizm FIFA World Cup 26™ — the hottest young player on the planet. Yamal was instrumental in Spain\'s 2024 Euro championship and is widely regarded as the face of the next generation of soccer. Eye-catching prizm design, near-mint condition. Ships double-sleeved in a rigid top-loader, bubble-wrapped.',
    12500, null, 1, 'CRG-LY-26-MONOPOLY', '/images/lamine-yamal-2026-prizm-monopoly.jpg', 'Hot');

  // ── NBA BASKETBALL ───────────────────────────────────────────────────────────
  prepare(ins).run(catNBA,
    'Kobe Bryant 2000 Leaf Pearl Pearlescent Patch #24 — 3/3',
    'kobe-bryant-2000-leaf-pearl-pearlescent-patch-3-3',
    'Kobe Bryant 2000 Leaf Pearl Pearlescent Patch #24, serial 3/3. ONE OF ONLY THREE IN EXISTENCE. This is one of only three copies of this card ever made. A Kobe Pearlescent Patch numbered 3/3 — a true once-in-a-collection grail. Ultra-premium and ultra-rare. Ships fully insured, signature required.',
    150000, null, 1, 'CRG-KB-00-PATCH-3', '/images/kobe_leaf_pearl_full.jpg', 'Grail');

  // ── COLLECTIBLES ─────────────────────────────────────────────────────────────
  prepare(ins).run(catOther,
    'Stan Lee 2011 Topps Allen & Ginter World\'s Champions #274 PSA 10',
    'stan-lee-2011-topps-allen-ginter-psa10',
    'Stan Lee 2011 Topps Allen & Ginter — World\'s Champions #274, graded PSA 10 Gem Mint (cert #77779080). The Founder of Marvel Comics himself, immortalized in the iconic Allen & Ginter format. PSA 10 Gem Mint — a true pop culture grail. Perfect for any Marvel or comic book fan.',
    10000, null, 1, 'CRG-STAN-LEE-PSA10', '/images/stanlee_allen_ginter_front.jpg', 'PSA 10');

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
