/**
 * db.js &#8212; SQLite database setup & seed data
 * Uses sql.js (pure JavaScript/WASM &#8212; no native compilation required)
 */

const bcrypt = require('bcryptjs');
const path   = require('path');
const fs     = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'store.db');

let sqlDb = null; // raw sql.js Database instance

// &#9472;&#9472; SAVE DB TO DISK &#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;

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

// &#9472;&#9472; PARAMETER NORMALIZER &#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;

function normalizeParams(args) {
  if (args.length === 0) return [];
  if (args.length === 1 && Array.isArray(args[0])) return args[0];
  return Array.from(args);
}

// &#9472;&#9472; PREPARED STATEMENT WRAPPER &#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;
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

// &#9472;&#9472; TRANSACTION WRAPPER &#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;

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

// &#9472;&#9472; EXEC (multi-statement SQL) &#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;

function exec(sql) {
  sqlDb.exec(sql);
  saveDb();
}

// &#9472;&#9472; SCHEMA &#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;

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

// &#9472;&#9472; SEED ADMIN &#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;
function seedAdmin() {
  const existing = prepare('SELECT id FROM admins LIMIT 1').get();
  if (existing) return;
  const email    = process.env.ADMIN_EMAIL    || 'admin@yourstore.com';
  const password = process.env.ADMIN_PASSWORD || 'changeme123';
  const hash     = bcrypt.hashSync(password, 12);
  prepare('INSERT INTO admins (email, password, name) VALUES (?, ?, ?)').run(email, hash, 'Admin');
  console.log(`&#9989; Admin account created: ${email}`);
}

// &#9472;&#9472; SEED SAMPLE PRODUCTS &#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;
function seedSampleData() {
  const SEED_VERSION = '3';
  const verRow = prepare('SELECT value FROM settings WHERE key = ?').get('seed_version');
  if (verRow && verRow.value === SEED_VERSION) return;
  try {
    prepare('DELETE FROM order_items').run();
    prepare('DELETE FROM orders').run();
    prepare('DELETE FROM products').run();
    prepare('DELETE FROM categories').run();
  } catch(e) {}
  const cat2 = prepare('INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)').run('Pokemon','pokemon','Sealed booster boxes, ETBs, and bundles',1).lastInsertRowid;
  const cat3 = prepare('INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)').run('Sports Cards','sports','NBA, NFL, and MLB hobby boxes and blasters',2).lastInsertRowid;
  const cat4 = prepare('INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)').run('Graded Cards','graded','PSA-certified slabs guaranteed PSA 9 or 10', 3).lastInsertRowid;
  const cat5 = prepare('INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)').run('Mystery Boxes','mystery','CRG signature mystery boxes &#8212; every rip hits',4).lastInsertRowid;
  const ins = 'INSERT INTO products (category_id,name,slug,description,price,compare_price,stock,sku,image_url,badge,active) VALUES (?,?, ?, ?, ?, ?, ?, ?, ?, ?, 1)';
  prepare(ins).run(cat2,'Pokemon Prismatic Evolutions Booster Box','pokemon-prismatic-evolutions-booster-box','Sealed Prismatic Evolutions booster box, 36 packs. Pull Eevee-lution SIRs, Tera Charizard ex, and more.',18999,22999,20,'PKM-PEV-BB',
    null,'Hot');
  prepare(ins).run(cat2,'Pokemon Surging Sparks ETB','pokemon-surging-sparks-etb','Surging Sparks ETB featuring Pikachu ex. 9 booster packs and premium accessories.',5499,6499,30,'PKM-SS-ETB',
    null,'New');
  prepare(ins).run(cat2,'Pokemon Shrouded Fable Bundle','pokemon-shrouded-fable-bundle','6-pack booster bundle from the Shrouded Fable set. Dark-type Pokemon and Special Illustration Rares.',3499,null,40,'PKM-SF-BB',
    null,null);
  prepare(ins).run(cat2,'Pokemon Stellar Crown Booster Box','pokemon-stellar-crown-booster-box','Stellar Crown sealed booster box, 36 packs. Pull Terapagos ex, Latios ex, and Special Illustration Rares.',14999,17999,15,'PKM-SC-BB',
    null,null);
  prepare(ins).run(cat3,'Panini Prizm NBA Hobby Box 2024-25','panini-prizm-nba-hobby-box','2024-25 Panini Prizm Basketball hobby box. 12 packs, guaranteed 3 autos and 6 prizm parallels.',21999,24999,12,'PAN-PZM-NBA',
    null,'Hot');
  prepare(ins).run(cat3,'Topps Chrome Baseball Hobby Box 2024','topps-chrome-baseball-hobby-box','Sealed 2024 Topps Chrome Baseball hobby box. 18 packs, guaranteed autos and refractors.',18999,null,15,'TOP-CHR-BB',
    null,null);
  prepare(ins).run(cat3,'Panini Select NFL Blaster','panini-select-nfl-blaster-box','Panini Select NFL blaster box. 6 packs with Blaster-only parallels.',3999,4999,35,'PAN-SEL-NFL',
    null,null);
  prepare(ins).run(cat3,'Bowman Baseball Hobby Box 2024','bowman-baseball-hobby-box-2024','2024 Bowman Baseball hobby box &#8212; the gold standard for prospect cards. 24 packs, loaded with Chrome Prospect Autos.',16999,null,10,'BOW-BB-24',
    null,'New');
  prepare(ins).run(cat4,'PSA Graded Mystery Card (PSA 9+)','psa-graded-mystery-card','Receive 1 random PSA-graded card guaranteed PSA 9 or PSA 10. Pokemon or sports &#8212; always a fire pull.',3999,9999,20,'PSA-MYS-9+',
    null,'New');
  prepare(ins).run(cat4,'PSA 10 Graded Slab (Pokemon)','psa-10-graded-slab-pokemon','PSA 10 Gem Mint graded Pokemon card. Random selection &#8212; could be a vintage base set card or a modern SIR. All PSA 10.',14999,19999,8,'PSA-10-PKM',
    null,'Hot');
  prepare(ins).run(cat5,'Grail Hunter Mystery Box','grail-hunter-mystery-box','The CRG signature experience: 10 random packs, 1 guaranteed hit, and a chance at a PSA graded slab. The hunt never stops.',4999,6499,25,'CRG-GHB',
    null,'Hot');
  prepare(ins).run(cat5,'Vintage Vault Mystery Box','vintage-vault-mystery-box','Curated vintage mystery box: 5 packs from sets before 2020. Perfect for the collector chasing throwback hits.',3999,5499,15,'CRG-VVB',
    null,null);
  const setq ='INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)';
  prepare(setq).run('store_name',process.env.STORE_NAME || 'CRG Cards');
  prepare(setq).run('store_currency','USD');
  prepare(setq).run('tax_rate','0');
  prepare(setq).run('shipping_flat','0');
  prepare(setq).run('free_shipping_threshold','0');
  prepare(setq).run('seed_version',SEED_VERSION);
  console.log('CRG Cards seeded (v' + SEED_VERSION + ')');
}

const helpers = {
  formatPrice(c){ return (c/100).toFixed(2); },
  generateOrderNumber() {
    const now = new Date();
    return 'ORD-' + now.toISOString().slice(2,10).replace(/-/g,'') + '-' + Math.floor(Math.random()*9000+1000);
  },
  getSettings() {
    const rows = prepare('SELECT key,value FROM settings').all();
    return Object.fromEntries(rows.map(r=>[r.key,r.value]));
  },
  updateSetting(key,value){ prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key,value); }
};

const db = {
  prepare, exec, transaction, helpers,
  async init() {
    if (sqlDb) return this;
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs({ locateFile: f => require('path').join(require.resolve('sql.js'),'..',f) });
    if (require('fs').existsSync(DB_PATH)) {
      sqlDb = new SQL.Database(require('fs').readFileSync(DB_PATH));
      console.log('&#9989; DB loaded');
    } else {
      sqlDb = new SQL.Database();
      console.log('&#9989; New DB');
    }
    sqlDb.run('PRAGMA foreign_keys = ON');
    sqlDb.exec(SCHEMA);
    saveDb();
    seedAdmin();
    seedSampleData();
    return this;
  }
};

module.exports = db;
