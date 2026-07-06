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

  CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
  CREATE INDEX IF NOT EXISTS idx_products_active   ON products(active);
  CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_orders_email      ON orders(customer_email);
  CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
  CREATE INDEX IF NOT EXISTS idx_offers_status     ON offers(status);
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
  const SEED_VERSION = '22';
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
  const catSoccer  = prepare('INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)').run('Soccer',         'soccer',       'Grail soccer cards featuring the world\'s greatest players', 1).lastInsertRowid;
  const catNBA     = prepare('INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)').run('NBA Basketball', 'nba',          'Iconic NBA cards and game-used memorabilia', 2).lastInsertRowid;
  const catFootball = prepare('INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)').run('Football',      'football',     'NFL football grails, patches, autos, and vintage', 3).lastInsertRowid;
  const catOther   = prepare('INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)').run('Collectibles',   'collectibles', 'Rare non-sport and pop culture collectible cards', 4).lastInsertRowid;
  const catPokemon = prepare('INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)').run('Pokémon',        'pokemon',      'Rare and graded Pokémon cards — holos, slabs, and fire pulls', 5).lastInsertRowid;

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
    23000, null, 1, 'CRG-LY-26-MONOPOLY', '/images/lamine-yamal-2026-prizm-monopoly.jpg', 'Hot');

  prepare(ins).run(catSoccer,
    'Lionel Messi 2019 Panini Chronicles Pitch Kings #PK1 PSA 10',
    'messi-2019-chronicles-pitch-kings-psa10',
    'Lionel Messi 2019 Panini Chronicles Pitch Kings #PK1, graded PSA 10 Gem Mint (cert #61933251). One of the most stunning Messi cards ever produced — a watercolor-art masterpiece from the Chronicles Pitch Kings set. PSA 10: perfect corners, flawless surface, perfect centering. The GOAT in a slab. Ships in original PSA holder, fully insured.',
    40000, null, 1, 'CRG-MESSI-19-PK1-PSA10', '/images/messi-2019-chronicles-pitch-kings-psa10.jpg', 'PSA 10');

  prepare(ins).run(catSoccer,
    'Lionel Messi 2022-23 Donruss Pitch Kings Green #1 SGC 10',
    'messi-2022-donruss-pitch-kings-green-sgc10',
    'Lionel Messi 2022-23 Panini Donruss Soccer Pitch Kings Green #1, graded SGC 10 GEM (cert #8030909). Messi in the Argentina white — the year he lifted the World Cup. The Green parallel pops hard in hand with a stunning card back design. SGC 10: flawless across all four corners. Sealed and certified forever. Ships in original SGC slab.',
    12500, null, 1, 'CRG-MESSI-22-DPK-GREEN-SGC10', '/images/messi-2022-donruss-pitch-kings-green-sgc10.jpg', 'SGC 10');

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

  prepare(ins).run(catFootball,
    'Dan Marino 2022 Panini One Quad Patch Auto #63 — 10/15',
    'marino-2022-panini-one-quad-patch-auto-10-15',
    'Dan Marino 2022 Panini One #63 — Quad Jersey Patch Auto, serial numbered 10/15. One of the most premium football cards you can own: four authentic game-worn Marino jersey swatches, a hard-signed on-card autograph, and an oversized format that makes it a true showpiece. Only 15 exist in the world. Miami Dolphins Hall of Famer. Ships fully insured.',
    45000, null, 1, 'CRG-MARINO-22-ONE-QUAD-10-15', '/images/marino-2022-panini-one-quad-patch-auto-10-15.jpg', 'Grail');

  prepare(ins).run(catFootball,
    'Dan Marino 1996 Upper Deck NFL All-Time Records 50,000 Yards Passing — 2420/5000',
    'marino-1996-ud-alltime-records-2420-5000',
    'Dan Marino 1996 Upper Deck Memorabilia NFL All-Time Records — 50,000 Yards Passing. Limited Edition 2420/5000. A commemorative oversized card celebrating the moment Marino became the first QB in history to throw for 50,000 yards — a record that stood for over a decade. Nearly 30 years old, well preserved in its original case. A must for any Marino or Dolphins collector.',
    8000, null, 1, 'CRG-MARINO-96-UD-50K', '/images/marino-1996-ud-alltime-records-2420-5000.jpg', 'Vintage');

// ── POKÉMON ──────────────────────────────────────────────────────────────────
prepare(ins).run(catPokemon,
  'Pokémon Mythical Collection — Genesect Box (Sealed)',
    'pokemon-mythical-collection-genesect-box-sealed',
      'Pokémon TCG Mythical Pokémon Collection — Genesect. Factory sealed box from the 2016 20th Anniversary Generations series. Includes the Genesect promo card, 2 Generations booster packs, 1 Pokémon TCG Online code card, and a Genesect collector\'s pin. One of the most sought-after sealed Mythical Collection boxes — Genesect\'s Generations-era promo is a favorite among collectors. Ships double-boxed and fully insured.',
        75000, null, 1, 'CRG-POKEMON-GENESECT-MYTHICAL-BOX', '/images/pokemon-genesect-mythical-box.jpg', 'Sealed');
        
        prepare(ins).run(catPokemon,
          'Pokémon Scarlet & Violet 151 Ultra-Premium Collection (Sealed)',
            'pokemon-sv151-ultra-premium-collection-sealed',
              'Pokémon TCG Scarlet & Violet — 151 Ultra-Premium Collection. Factory sealed. The ultimate Mew-themed set celebrating the original 151 Pokémon. Includes 16 booster packs, a special foil promo card, an oversized foil Mew card, Mew VMAX & Mew V alternate art promos, premium card sleeves, a collector\'s portfolio, a coin, and an acrylic display stand. One of the most premium sealed products ever produced for the TCG. Ships double-boxed, fully insured.',
                96000, null, 1, 'CRG-POKEMON-SV151-UPC', '/images/pokemon-sv151-ultra-premium.jpg', 'Sealed');

  prepare(ins).run(catPokemon,
    'Pokémon Kleavor VSTAR Premium Collection (Sealed)',
    'pokemon-kleavor-vstar-premium-collection-sealed',
    'Pokémon TCG Kleavor VSTAR Premium Collection — factory sealed. Includes Kleavor VSTAR and Kleavor V foil promos, an oversize Kleavor VSTAR card, a VSTAR marker, and 6 Pokémon TCG booster packs from the Sword & Shield era. Ships double-boxed and fully insured.',
    8900, null, 1, 'CRG-POKEMON-KLEAVOR-VSTAR-PREMIUM', '/images/pokemon-kleavor-vstar-premium.jpg', 'Sealed');

  prepare(ins).run(catPokemon,
    'Pokémon Kleavor VSTAR Special Collection (Sealed)',
    'pokemon-kleavor-vstar-special-collection-sealed',
    'Pokémon TCG Kleavor VSTAR Special Collection — factory sealed. Includes Kleavor VSTAR and Kleavor V foil promos, a VSTAR marker, and 4 Pokémon TCG booster packs. A clean sealed piece from the Sword & Shield era. Ships double-boxed and fully insured.',
    7500, null, 1, 'CRG-POKEMON-KLEAVOR-VSTAR-SPECIAL', '/images/pokemon-kleavor-vstar-special.jpg', 'Sealed');

  prepare(ins).run(catPokemon,
    'Pokémon Mabosstiff ex Box (Sealed)',
    'pokemon-mabosstiff-ex-box-sealed',
    'Pokémon TCG Mabosstiff ex Box — factory sealed. Includes a foil Mabosstiff ex promo, foil Maschiff, an oversize Mabosstiff ex card, and 4 Pokémon TCG booster packs. Ships double-boxed and fully insured.',
    4000, null, 1, 'CRG-POKEMON-MABOSSTIFF-EX-BOX', '/images/pokemon-mabosstiff-ex-box.jpg', 'Sealed');

  prepare(ins).run(catPokemon,
    'Pokémon Hop\'s Zacian ex Box (Sealed)',
    'pokemon-hops-zacian-ex-box-sealed',
    'Pokémon TCG Hop\'s Zacian ex Box — factory sealed. Includes foil promos of Hop\'s Zacian ex, Hop\'s Wooloo, and Hop\'s Dubwool, an oversize Hop\'s Zacian ex card, a sticker, and 4 Pokémon TCG booster packs. Ships double-boxed and fully insured.',
    4000, null, 1, 'CRG-POKEMON-HOPS-ZACIAN-EX-BOX', '/images/pokemon-hops-zacian-ex-box.jpg', 'Sealed');

  prepare(ins).run(catPokemon,
    'Pokémon Charizard ex Premium Collection (Sealed)',
    'pokemon-charizard-ex-premium-collection-sealed',
    'Pokémon TCG Charizard ex Premium Collection — factory sealed. Includes an etched foil Charizard ex promo, foil Charmander and Charmeleon, 6 booster packs, a magnetic card protector with display base, and 65 Charizard Tera card sleeves. One of the most in-demand modern Charizard sealed products. Ships double-boxed and fully insured.',
    12000, null, 1, 'CRG-POKEMON-CHARIZARD-EX-PREMIUM', '/images/pokemon-charizard-ex-premium.jpg', 'Sealed');

  prepare(ins).run(catPokemon,
    'Pokémon Iono\'s Bellibolt ex Premium Collection (Sealed)',
    'pokemon-ionos-bellibolt-ex-premium-collection-sealed',
    'Pokémon TCG Iono\'s Bellibolt ex Premium Collection — factory sealed. Includes a full-art foil Iono\'s Bellibolt ex promo, foil Iono\'s Tadbulb, acrylic standees of Iono and friends, a double-sided backdrop display, a photo sticker, and 6 Pokémon TCG booster packs. Ships double-boxed and fully insured.',
    6000, null, 1, 'CRG-POKEMON-IONOS-BELLIBOLT-PREMIUM', '/images/pokemon-ionos-bellibolt-ex-premium.jpg', 'Sealed');

  prepare(ins).run(catPokemon,
    'Pokémon Snorlax GX Box (Sealed)',
    'pokemon-snorlax-gx-box-sealed',
    'Pokémon TCG Snorlax GX Box (2016) — factory sealed. Includes a never-before-seen Snorlax GX foil promo, an oversize Snorlax GX card, and 4 booster packs including sought-after Evolutions and Fates Collide era packs. A tough sealed box to find in this condition — strong long-term hold. Ships double-boxed and fully insured.',
    34000, null, 1, 'CRG-POKEMON-SNORLAX-GX-BOX', '/images/pokemon-snorlax-gx-box.jpg', 'Sealed');

  prepare(ins).run(catPokemon,
    'Pokémon 151 Mini Tins 5-Pack + 4 Promos — Costco Exclusive (Sealed)',
    'pokemon-151-mini-tins-5-pack-costco-sealed',
    'Pokémon TCG Scarlet & Violet 151 Mini Tin 5-Pack Bundle — Costco exclusive, factory sealed. Includes 5 mini tins (each with 2 booster packs, coin, and art card) plus 4 exclusive Cosmos foil promos: Pikachu, Bulbasaur, Charmander, and Squirtle. Heavily sought after since it left shelves. Ships double-boxed and fully insured.',
    29900, null, 1, 'CRG-POKEMON-151-MINI-TINS-5PACK', '/images/pokemon-151-mini-tins-5pack.jpg', 'Sealed');
                
                  // Default settings
  const setq = 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)';
  prepare(setq).run('store_name',               process.env.STORE_NAME     || 'CRG Cards');
  prepare(setq).run('store_currency',           process.env.STORE_CURRENCY || 'USD');
  prepare(setq).run('tax_rate',                 '0');
  prepare(setq).run('shipping_flat',            '499');   // $4.99 standard shipping
  prepare(setq).run('free_shipping_threshold',  '10000'); // free shipping on orders $100+
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
