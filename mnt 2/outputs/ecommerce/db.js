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

  // ── CATEGORIES ──────────────────────────────────────────────────────────────
  const catSoccer  = prepare('INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)').run('Soccer',         'soccer',       'Grail soccer cards featuring the world\'s greatest players', 1).lastInsertRowid;
  const catNBA     = prepare('INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)').run('NBA Basketball', 'nba',          'Iconic NBA cards and game-used memorabilia', 2).lastInsertRowid;
  const catFootball = prepare('INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)').run('Football',      'football',     'NFL football grails, patches, autos, and vintage', 3).lastInsertRowid;
  const catOther   = prepare('INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)').run('Collectibles',   'collectibles', 'Rare non-sport and pop culture collectible cards', 4).lastInsertRowid;
  const catPokemon = prepare('INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)').run('Pokémon',        'pokemon',      'Rare and graded Pokémon cards — holos, slabs, and fire pulls', 5).lastInsertRowid;

  const ins = 'INSERT INTO products (category_id, name, slug, description, price, compare_price, stock, sku, image_url, badge, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)';

  // ── SOCCER ──────────────────────────────────────────────────────────────────
  prepare(ins).run(catSoccer,
    'Lionel Messi 2023 Leaf Metal Anime Nation "Leo the Lion" #ANB-30 /373 PSA 10',
    'messi-2023-leaf-anime-nation-anb30-psa10',
    'Lionel Messi 2023 Leaf Metal Anime Nation — "Leo the Lion" #ANB-30, serial numbered 45/373, graded PSA 10 Gem Mint (cert #76705063). Stunning anime artwork by Japanese manga/caricature artist Shion Minabe: Messi in the Albiceleste alongside a roaring lion on a color-shifting metal foil canvas. Leaf Web Exclusive with a tiny print run. PSA 10 GEM MINT in the original slab.',
    32000, null, 1, 'CRG-MESSI-ANIME-NATION-PSA10', '/images/messi-anime-nation-anb30.jpg', 'Numbered');

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
    'Lionel Messi / Kobe Bryant 2021-22 Leaf Pearl Dual Pearlescent Patch #PP2-3 — 3/3',
    'kobe-bryant-2000-leaf-pearl-pearlescent-patch-3-3',
    'Lionel Messi / Kobe Bryant 2021-22 Leaf Pearl Multi-Sport — Dual Pearlescent Patch #PP2-3, serial numbered 3/3. ONE OF ONLY THREE COPIES IN EXISTENCE. Two of the greatest athletes who ever lived, united on one card. The front: Lionel Messi with an authentic game-used patch set in a shimmering pearlescent frame. Flip it over: Kobe Bryant with a stunning three-color Lakers patch of his own. Game-used memorabilia from BOTH legends, authenticity guaranteed by Leaf Trading Cards, sealed in the original Leaf case. The GOAT of football and the Black Mamba do not share cardboard often — and never this rare. This is not just a card, it is a museum piece and the centerpiece of any collection. Ships double-boxed, fully insured, signature required.',
    150000, null, 1, 'CRG-KB-00-PATCH-3', '/images/kobe-messi-leaf-pearl-pp2-3.jpg', 'Grail');

  prepare(ins).run(catNBA,
    'Magic Johnson Leaf Sports Heroes Signature Decade \'80s Auto #SD-MJ1 — 7/10',
    'magic-johnson-leaf-signature-decade-80s-auto-7-10',
    'Magic Johnson — Leaf Sports Heroes "Signature Decade \'80s" autograph #SD-MJ1, serial numbered 7/10. A bold on-card style Magic auto on a dazzling cracked-ice finish celebrating the decade Showtime ran the NBA. Only 10 copies exist. The Lakers legend\'s signature, certified by Leaf. Ships in a magnetic one-touch, bubble-wrapped and fully insured.',
    10000, null, 1, 'CRG-MAGIC-LEAF-SIGDECADE-7-10', '/images/magic-johnson-leaf-signature-decade-80s-auto-7-10.jpg', 'Numbered');

  // ── COLLECTIBLES ─────────────────────────────────────────────────────────────
  prepare(ins).run(catOther,
    'Stan Lee 2011 Topps Allen & Ginter World\'s Champions #274 PSA 10',
    'stan-lee-2011-topps-allen-ginter-psa10',
    'Stan Lee 2011 Topps Allen & Ginter — World\'s Champions #274, graded PSA 10 Gem Mint (cert #77779080). The Founder of Marvel Comics himself, immortalized in the iconic Allen & Ginter format. PSA 10 Gem Mint — a true pop culture grail. Perfect for any Marvel or comic book fan.',
    10000, null, 1, 'CRG-STAN-LEE-PSA10', '/images/stanlee_allen_ginter_front.jpg', 'PSA 10');

  prepare(ins).run(catOther,
    'Mickey Mouse 2023 Disney Lorcana D100 Collector\'s Edition #18/P1 PSA 10',
    'mickey-2023-lorcana-d100-collectors-edition-psa10',
    'Mickey Mouse — Friendly Face, 2023 Disney Lorcana Disney100 Collector\'s Edition promo #18/P1, graded PSA 10 Gem Mint (cert #84532044). The crown jewel of the D100 Collector\'s Edition gift set: golden art deco alt-art of Mickey with animator Mark Henn\'s printed signature on a stunning foil treatment. One of the most sought-after Lorcana cards — the market for this card has been on fire. PSA 10 GEM MINT in the original slab.',
    94000, null, 1, 'CRG-MICKEY-LORCANA-D100-PSA10', '/images/mickey-lorcana-d100.jpg', 'PSA 10');

  prepare(ins).run(catOther,
    'Rafael Nadal 2003 NetPro #70 Rookie Card PSA 10',
    'nadal-2003-netpro-70-rookie-psa10',
    'Rafael Nadal 2003 NetPro #70 — the King of Clay\'s true rookie card, graded PSA 10 GEM MINT (cert #49612693). Teenage Rafa crouched on the grass, years before 22 Grand Slams and 14 French Opens made him a legend. The 2003 NetPro is THE recognized Nadal rookie, and gem mint copies are the ones collectors fight over. Ships in the original PSA slab, bubble-wrapped and fully insured.',
    8500, null, 1, 'CRG-NADAL-03-NETPRO-70-PSA10', '/images/nadal-2003-netpro-70-rookie-psa10.jpg', 'PSA 10');

  prepare(ins).run(catFootball,
    'Randy Moss 2020 Panini Mosaic Old School Orange Fluorescent #OS14 — 1/25',
    'randy-moss-2020-mosaic-old-school-orange-fluorescent-1-25',
    'Randy Moss 2020 Panini Mosaic Football — Old School insert #OS14, Orange Fluorescent parallel, serial numbered 1/25. The FIRST copy off the press of only 25 in existence. The Freak in the iconic Vikings purple on a blazing orange fluorescent mosaic finish. Raw, pack-fresh condition. Ships in a magnetic one-touch, bubble-wrapped and fully insured.',
    10000, null, 1, 'CRG-MOSS-20-MOSAIC-OS14-ORANGE-1-25', '/images/randy-moss-2020-mosaic-old-school-orange-fluorescent-1-25.jpg', 'Numbered');

  prepare(ins).run(catFootball,
    'Dan Marino 2022 Panini One Quad Patch Auto #63 — 10/15',
    'marino-2022-panini-one-quad-patch-auto-10-15',
    'Dan Marino 2022 Panini One #63 — Quad Jersey Patch Auto, serial numbered 10/15. One of the most premium football cards you can own: four authentic game-worn Marino jersey swatches, a hard-signed on-card autograph, and an oversized format that makes it a true showpiece. Only 15 exist in the world. Miami Dolphins Hall of Famer. Ships fully insured.',
    45000, null, 1, 'CRG-MARINO-22-ONE-QUAD-10-15', '/images/marino-2022-panini-one-quad-patch-auto-10-15.jpg', 'Grail');

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
        'Lionel Messi / Kobe Bryant 2021-22 Leaf Pearl Multi-Sport — Dual Pearlescent Patch #PP2-3, serial numbered 3/3. ONE OF ONLY THREE COPIES IN EXISTENCE. Two of the greatest athletes who ever lived, united on one card. The front: Lionel Messi with an authentic game-used patch set in a shimmering pearlescent frame. Flip it over: Kobe Bryant with a stunning three-color Lakers patch of his own. Game-used memorabilia from BOTH legends, authenticity guaranteed by Leaf Trading Cards, sealed in the original Leaf case. The GOAT of football and the Black Mamba do not share cardboard often — and never this rare. This is not just a card, it is a museum piece and the centerpiece of any collection. Ships double-boxed, fully insured, signature required.',
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
    addIfMissing('soccer',
      'Lionel Messi 2023 Leaf Metal Anime Nation "Leo the Lion" #ANB-30 /373 PSA 10',
      'messi-2023-leaf-anime-nation-anb30-psa10',
      'Lionel Messi 2023 Leaf Metal Anime Nation — "Leo the Lion" #ANB-30, serial numbered 45/373, graded PSA 10 Gem Mint (cert #76705063). Stunning anime artwork by Japanese manga/caricature artist Shion Minabe: Messi in the Albiceleste alongside a roaring lion on a color-shifting metal foil canvas. Leaf Web Exclusive with a tiny print run. PSA 10 GEM MINT in the original slab.',
      32000, 'CRG-MESSI-ANIME-NATION-PSA10', '/images/messi-anime-nation-anb30.jpg', 'Numbered');
    addIfMissing('collectibles',
      'Mickey Mouse 2023 Disney Lorcana D100 Collector\'s Edition #18/P1 PSA 10',
      'mickey-2023-lorcana-d100-collectors-edition-psa10',
      'Mickey Mouse — Friendly Face, 2023 Disney Lorcana Disney100 Collector\'s Edition promo #18/P1, graded PSA 10 Gem Mint (cert #84532044). The crown jewel of the D100 Collector\'s Edition gift set: golden art deco alt-art of Mickey with animator Mark Henn\'s printed signature on a stunning foil treatment. One of the most sought-after Lorcana cards — the market for this card has been on fire. PSA 10 GEM MINT in the original slab.',
      94000, 'CRG-MICKEY-LORCANA-D100-PSA10', '/images/mickey-lorcana-d100.jpg', 'PSA 10');
    addIfMissing('football',
      'Randy Moss 2020 Panini Mosaic Old School Orange Fluorescent #OS14 — 1/25',
      'randy-moss-2020-mosaic-old-school-orange-fluorescent-1-25',
      'Randy Moss 2020 Panini Mosaic Football — Old School insert #OS14, Orange Fluorescent parallel, serial numbered 1/25. The FIRST copy off the press of only 25 in existence. The Freak in the iconic Vikings purple on a blazing orange fluorescent mosaic finish. Raw, pack-fresh condition. Ships in a magnetic one-touch, bubble-wrapped and fully insured.',
      10000, 'CRG-MOSS-20-MOSAIC-OS14-ORANGE-1-25', '/images/randy-moss-2020-mosaic-old-school-orange-fluorescent-1-25.jpg', 'Numbered');
    addIfMissing('collectibles',
      'Rafael Nadal 2003 NetPro #70 Rookie Card PSA 10',
      'nadal-2003-netpro-70-rookie-psa10',
      'Rafael Nadal 2003 NetPro #70 — the King of Clay\'s true rookie card, graded PSA 10 GEM MINT (cert #49612693). Teenage Rafa crouched on the grass, years before 22 Grand Slams and 14 French Opens made him a legend. The 2003 NetPro is THE recognized Nadal rookie, and gem mint copies are the ones collectors fight over. Ships in the original PSA slab, bubble-wrapped and fully insured.',
      8500, 'CRG-NADAL-03-NETPRO-70-PSA10', '/images/nadal-2003-netpro-70-rookie-psa10.jpg', 'PSA 10');
    addIfMissing('nba',
      'Magic Johnson Leaf Sports Heroes Signature Decade \'80s Auto #SD-MJ1 — 7/10',
      'magic-johnson-leaf-signature-decade-80s-auto-7-10',
      'Magic Johnson — Leaf Sports Heroes "Signature Decade \'80s" autograph #SD-MJ1, serial numbered 7/10. A bold on-card style Magic auto on a dazzling cracked-ice finish celebrating the decade Showtime ran the NBA. Only 10 copies exist. The Lakers legend\'s signature, certified by Leaf. Ships in a magnetic one-touch, bubble-wrapped and fully insured.',
      10000, 'CRG-MAGIC-LEAF-SIGDECADE-7-10', '/images/magic-johnson-leaf-signature-decade-80s-auto-7-10.jpg', 'Numbered');

    // Removed from sale (Jul 12 2026): Kobe/Messi Leaf Pearl, Messi Crystal UCL, Fabled Four
    prepare('UPDATE products SET active = 0, updated_at = datetime(\'now\') WHERE slug = ? AND active = 1')
      .run('kobe-bryant-2000-leaf-pearl-pearlescent-patch-3-3');
    prepare('UPDATE products SET active = 0, updated_at = datetime(\'now\') WHERE slug = ? AND active = 1')
      .run('messi-2022-topps-crystal-ucl-psa10');
    prepare('UPDATE products SET active = 0, updated_at = datetime(\'now\') WHERE slug = ? AND active = 1')
      .run('messi-pele-beckham-maradona-2021-leaf-fabled-four-25');

    // PSA 10 Pokémon slab drop (Jul 12 2026) — six new graded singles
    addIfMissing('pokemon',
      'Iono\'s Kilowattrel 2025 Journey Together #163 Illustration Rare PSA 10',
      'ionos-kilowattrel-jtg-163-psa10',
      'Iono\'s Kilowattrel — 2025 Pokémon Scarlet & Violet: Journey Together, Illustration Rare #163/159, graded PSA 10 GEM MINT (cert #120038268). One of the most beloved Illustration Rares in Journey Together: streamer superstar Iono and her Kilowattrel lighting up a gorgeous full-art scene. Flawless gem mint copy. Ships in the PSA slab, bubble-wrapped, double-boxed with tracking, from a smoke-free shop.',
      9000, 'CRG-IONO-KILOWATTREL-JTG163-PSA10', '/images/ionos-kilowattrel-jtg-163-psa10.jpg', 'PSA 10');
    addIfMissing('pokemon',
      'Volcanion ex 2025 Journey Together #182 Special Illustration Rare PSA 10',
      'volcanion-ex-jtg-182-sir-psa10',
      'Volcanion ex — 2025 Pokémon Scarlet & Violet: Journey Together, Special Illustration Rare #182/159, graded PSA 10 GEM MINT (cert #141084648). The Steam Pokémon erupting across a molten full-art canvas — one of the hardest-hitting SIRs in the set and an absolute showpiece in gem mint. Ships in the PSA slab, bubble-wrapped, double-boxed with tracking, from a smoke-free shop.',
      11000, 'CRG-VOLCANION-EX-JTG182-PSA10', '/images/volcanion-ex-jtg-182-sir-psa10.jpg', 'PSA 10');
    addIfMissing('pokemon',
      'Mega Latias ex 2025 Mega Evolution #181 Special Illustration Rare PSA 10',
      'mega-latias-ex-meg-181-sir-psa10',
      'Mega Latias ex — 2025 Pokémon Mega Evolution, Special Illustration Rare #181/132, graded PSA 10 GEM MINT (cert #137960092). A top chase card of the Mega Evolution base set: Mega Latias tearing across the sky in breathtaking full-bleed art. Demand for this SIR has been relentless, and gem mint copies are the ones that hold. Ships in the PSA slab, bubble-wrapped, double-boxed with tracking, fully insured, from a smoke-free shop.',
      30000, 'CRG-MEGA-LATIAS-EX-MEG181-PSA10', '/images/mega-latias-ex-meg-181-sir-psa10.jpg', 'PSA 10');
    addIfMissing('pokemon',
      'Pikachu VMAX 2020 Vivid Voltage #044 Full Art PSA 10',
      'pikachu-vmax-vivid-voltage-044-psa10',
      'Pikachu VMAX — 2020 Pokémon Sword & Shield: Vivid Voltage, Full Art #044/185, graded PSA 10 GEM MINT (cert #59950458). The legendary "Chonkachu" — Gigantamax Pikachu in all his oversized glory, the card that defined the Vivid Voltage era and a modern Pikachu staple every collection needs. Ships in the PSA slab, bubble-wrapped, double-boxed with tracking, from a smoke-free shop.',
      11500, 'CRG-PIKACHU-VMAX-VV044-PSA10', '/images/pikachu-vmax-vivid-voltage-044-psa10.jpg', 'PSA 10');
    addIfMissing('pokemon',
      'Tapu Bulu GX 2019 Hidden Fates Shiny Vault #SV91 Gold Full Art PSA 10',
      'tapu-bulu-gx-hidden-fates-sv91-psa10',
      'Tapu Bulu GX — 2019 Pokémon Sun & Moon: Hidden Fates Shiny Vault, Gold Secret Rare Full Art #SV91/SV94, graded PSA 10 GEM MINT (cert #119716792). Solid gold from the most iconic subset of the modern era: the Shiny Vault. The island guardian rendered in stunning gold foil, one of the final secret rares in the set. Ships in the PSA slab, bubble-wrapped, double-boxed with tracking, from a smoke-free shop.',
      8000, 'CRG-TAPU-BULU-GX-SV91-PSA10', '/images/tapu-bulu-gx-hidden-fates-sv91-psa10.jpg', 'PSA 10');
    addIfMissing('pokemon',
      'Mega Greninja ex 2026 Chaos Rising #116 Special Illustration Rare PSA 10',
      'mega-greninja-ex-cri-116-sir-psa10',
      'Mega Greninja ex — 2026 Pokémon Mega Evolution: Chaos Rising, Special Illustration Rare #116/086, graded PSA 10 GEM MINT (cert #163077710). The undisputed king of Chaos Rising. Mega Greninja mid-strike in cinematic full-art — the most hunted card of the newest era of the TCG, already commanding grail status. Fresh PSA 10, flawless in hand. Ships in the PSA slab, bubble-wrapped, double-boxed with tracking, fully insured with signature confirmation, from a smoke-free shop.',
      90000, 'CRG-MEGA-GRENINJA-EX-CRI116-PSA10', '/images/mega-greninja-ex-cri-116-sir-psa10.jpg', 'PSA 10');
    addIfMissing('pokemon',
      'Gengar EX 2014 XY Phantom Forces #34 PSA 10',
      'gengar-ex-phantom-forces-34-psa10',
      'Gengar EX — 2014 Pokémon XY: Phantom Forces #34, graded PSA 10 GEM MINT (cert #97283003). A true modern-vintage classic: Gengar grinning through a swirling haunted cosmos on one of the most beloved EX cards of the XY era. Over a decade old and brutally tough in gem mint — PSA 10 copies keep disappearing into collections. Ships in the PSA slab, bubble-wrapped, double-boxed with tracking, fully insured, from a smoke-free shop.',
      75000, 'CRG-GENGAR-EX-XY34-PSA10', '/images/gengar-ex-phantom-forces-34-psa10.jpg', 'PSA 10');
    addIfMissing('pokemon',
      'Eevee ex 2024 Terastal Festival (JP) #224 Special Art Rare PSA 10',
      'eevee-ex-sv8a-224-sar-psa10',
      'Eevee ex — 2024 Pokémon Japanese SV8a: Terastal Festival ex, Special Art Rare #224/187, graded PSA 10 GEM MINT (cert #106408852). One of the most adored cards of the modern era: Eevee surrounded by Tera crystals hinting at every evolution, in gorgeous SAR art by Naoyo Kimura. The Eevee card of the set everyone chases. Ships in the PSA slab, bubble-wrapped, double-boxed with tracking, from a smoke-free shop.',
      10000, 'CRG-EEVEE-EX-SV8A224-PSA10', '/images/eevee-ex-sv8a-224-sar-psa10.jpg', 'PSA 10');
    addIfMissing('pokemon',
      'Meganium 2000 Japanese Neo Premium File #154 Holo PSA 10',
      'meganium-neo-premium-file-154-psa10',
      'Meganium — 2000 Pokémon Japanese Neo Genesis Premium File, Holo #154, graded PSA 10 GEM MINT (cert #113086406). True vintage Japanese Pokémon from the Neo era: Meganium in classic Ken Sugimori holo art from the sought-after Premium File promo set. 25+ years old and stunning in gem mint — these do not surface often. Ships in the PSA slab, bubble-wrapped, double-boxed with tracking, fully insured, from a smoke-free shop.',
      32500, 'CRG-MEGANIUM-NEO-PF154-PSA10', '/images/meganium-neo-premium-file-154-psa10.jpg', 'PSA 10');
    addIfMissing('pokemon',
      'Jolteon ex 2024 Terastal Festival (JP) #209 Special Art Rare PSA 10',
      'jolteon-ex-sv8a-209-sar-psa10',
      'Jolteon ex — 2024 Pokémon Japanese SV8a: Terastal Festival ex, Special Art Rare #209/187, graded PSA 10 GEM MINT (cert #128287129). Jolteon streaking through a lightning-charged cityscape in electric SAR artwork — one of the standout Eeveelution chase cards of Terastal Festival. Flawless gem mint. Ships in the PSA slab, bubble-wrapped, double-boxed with tracking, from a smoke-free shop.',
      13500, 'CRG-JOLTEON-EX-SV8A209-PSA10', '/images/jolteon-ex-sv8a-209-sar-psa10.jpg', 'PSA 10');
    addIfMissing('pokemon',
      'Feraligatr 2000 Japanese Neo Premium File #160 Holo PSA 10',
      'feraligatr-neo-premium-file-160-psa10',
      'Feraligatr — 2000 Pokémon Japanese Neo Genesis Premium File, Holo #160, graded PSA 10 GEM MINT (cert #118892901). The Big Jaw Pokémon roaring off the card in classic Ken Sugimori holo art from the sought-after Neo Premium File promo set. True vintage Japanese Pokémon, 25+ years old and immaculate in gem mint — the perfect partner to its Meganium sibling. Ships in the PSA slab, bubble-wrapped, double-boxed with tracking, fully insured, from a smoke-free shop.',
      40000, 'CRG-FERALIGATR-NEO-PF160-PSA10', '/images/feraligatr-neo-premium-file-160-psa10.jpg', 'PSA 10');

    // Removed from sale (Jul 13 2026): Messi 2018 Adrenalyn XL WC Road to Russia PSA 10, Messi 2022-23 Donruss Pitch Kings Green SGC 10 ($125)
    prepare('UPDATE products SET active = 0, updated_at = datetime(\'now\') WHERE slug = ? AND active = 1')
      .run('messi-2018-panini-adrenalyn-xl-wc-road-russia-psa10');
    prepare('UPDATE products SET active = 0, updated_at = datetime(\'now\') WHERE slug = ? AND active = 1')
      .run('messi-2022-donruss-pitch-kings-green-sgc10');

    // Price drop (Jul 13 2026): Messi 2023 Topps Chrome MLS Big City Strikers Gold /50 → $1700
    prepare('UPDATE products SET price = 170000, updated_at = datetime(\'now\') WHERE slug = ? AND price <> 170000')
      .run('messi-2023-topps-chrome-mls-big-city-strikers-gold-refractor-psa10');

    // Removed from sale (Jul 13 2026): Randy Moss 2020 Mosaic Old School Orange Fluorescent 1/25
    prepare('UPDATE products SET active = 0, updated_at = datetime(\'now\') WHERE slug = ? AND active = 1')
      .run('randy-moss-2020-mosaic-old-school-orange-fluorescent-1-25');

    // Removed from sale (Jul 13 2026): Pokemon Snorlax GX Box (Sealed)
    prepare('UPDATE products SET active = 0, updated_at = datetime(\'now\') WHERE slug = ? AND active = 1')
      .run('pokemon-snorlax-gx-box-sealed');

    // New adds (Jul 15 2026): Nico Paz Optic Pink Ice /25 + Patrick "Hambino" Renna signed Sandlot custom
    addIfMissing('soccer',
      'Nico Paz 2025-26 Donruss Road to FIFA World Cup 26 Optic Pink Ice #164 — 02/25',
      'nico-paz-2025-donruss-rtwc-optic-pink-ice-2-25',
      'Nico Paz — 2025-26 Panini Donruss Road to FIFA World Cup 26, Optic Pink Ice parallel #164, serial numbered 02/25. Only 25 copies exist of Argentina\'s next great playmaker on the blazing pink cracked ice Optic finish — one of the loudest, rarest parallels in the set, released as the world gears up for the 2026 World Cup. Paz announced himself with an assist in his Argentina debut and has been one of the most hyped young No. 10s in world football since. Cards of La Albiceleste\'s heirs numbered this low do not sit around. Pack-fresh and stunning in hand. Ships in a magnetic one-touch, bubble-wrapped, double-boxed with tracking, fully insured, from a smoke-free shop.',
      30000, 'CRG-NICO-PAZ-RTWC-OPTIC-PINK-ICE-2-25', '/images/nico-paz-2025-donruss-rtwc-optic-pink-ice-2-25.jpg', 'Numbered');
    addIfMissing('collectibles',
      'Patrick "Hambino" Renna Signed The Sandlot Custom Card — "HAM" Inscription',
      'hambino-patrick-renna-signed-sandlot-custom-auto',
      'Patrick "The Great Hambino" Renna hand-signed official Hambino custom trading card (2023), autographed in blue ink with the "HAM" inscription. "You\'re killing me, Smalls!" — the most quotable character from The Sandlot on a perfect retro 1960s-style All-Stars catcher card, bat-barrel nameplate and all. A must-have for any Sandlot fan, movie memorabilia collector, or baseball nostalgia junkie. Bold, clean signature across the front. Ships in a protective acrylic case, bubble-wrapped, double-boxed with tracking, from a smoke-free shop. Legends never die.',
      10000, 'CRG-HAMBINO-RENNA-SIGNED-CUSTOM', '/images/hambino-patrick-renna-signed-sandlot-custom-auto.jpg', 'Autograph');

    // New add (Jul 15 2026): Spider-Man 30th Anniversary Prism ISA 5
    addIfMissing('collectibles',
      'Spider-Man 1992 Comic Images 30th Anniversary #P9 "Promoted" Prism ISA 5',
      'spiderman-1992-comic-images-30th-p9-prism-isa5',
      'Spider-Man — 1992 Comic Images Spider-Man II: 30th Anniversary, Prism insert #P9 "Promoted", graded ISA 5 EX (cert #61595908). Web-slinging 90s nostalgia at its finest: Spidey swinging across a dazzling cracked-ice prism celebrating 30 years of the wall-crawler, with Stan Lee\'s 1942 promotion at Timely Comics chronicled on the back. These early-90s prisms are notorious for surface wear — a clean graded copy is a great way to own one of the era\'s most iconic inserts. Ships in the ISA slab, bubble-wrapped, double-boxed with tracking, from a smoke-free shop.',
      2000, 'CRG-SPIDERMAN-92-30TH-P9-PRISM-ISA5', '/images/spiderman-1992-comic-images-30th-p9-prism-isa5.jpg', 'Graded');

    // New add (Jul 15 2026): Udonis Haslem Select Tie-Dye Swatches /25 BGS 9.5
    addIfMissing('nba',
      'Udonis Haslem 2016-17 Select Swatches Tie-Dye Prizm #37 — 1/25 BGS 9.5',
      'udonis-haslem-2016-select-swatches-tie-dye-bgs95',
      'Udonis Haslem — 2016-17 Panini Select Swatches, Tie-Dye Prizm parallel #37 with game-worn jersey swatch, serial numbered 1/25, graded BGS 9.5 GEM MINT (cert #0010219560) with killer subgrades: 10 centering, 10 edges, 9.5 corners, 9.5 surface. THE FIRST COPY off the press of only 25 in existence. Mr. Miami Heat himself — 21 seasons, three championships, one franchise — in the iconic 40 on a psychedelic tie-dye prizm with an authentic piece of his jersey. 305 legend, hometown hero, forever Heat. Ships in the BGS slab, bubble-wrapped, double-boxed with tracking, fully insured, from a smoke-free shop.',
      6000, 'CRG-HASLEM-16-SELECT-TIEDYE-1-25-BGS95', '/images/udonis-haslem-2016-select-swatches-tie-dye-bgs95.jpg', 'Numbered');

    // New add (Jul 15 2026): Michael Jordan UD Milk Caps Foil CCG 10
    addIfMissing('nba',
      'Michael Jordan 1995 Upper Deck Milk Caps #S6 Foil — CCG 10 GEM MINT',
      'jordan-1995-ud-milk-caps-s6-foil-ccg10',
      'Michael Jordan — 1995 Upper Deck Milk Caps #S6, FOIL, graded CCG 10 GEM MINT (cert #798267625) with near-perfect subgrades: 10 corners, 10 centering, 10 edges, 9.5 surface. His Airness mid-90s at the height of the second three-peat era on one of the quirkiest, hardest-to-find Jordan oddball collectibles of the decade — a foil milk cap (POG) from Upper Deck, nearly impossible to find this clean 30 years later. A conversation piece for any MJ collection. Ships in the CCG slab, bubble-wrapped, double-boxed with tracking, from a smoke-free shop.',
      3500, 'CRG-JORDAN-95-UD-MILKCAP-S6-CCG10', '/images/jordan-1995-ud-milk-caps-s6-foil-ccg10.jpg', 'Graded');

    // New adds (Jul 15 2026): 23KT Gold cards — Kobe/MJ combo + Jordan Prism Holo
    addIfMissing('nba',
      'Kobe Bryant + Michael Jordan 23KT Gold Rookie Cards — Both WCG 10 (2-Card Lot)',
      'kobe-jordan-23kt-gold-rookie-combo-wcg10',
      'THE GOAT AND THE MAMBA — 2-card 23KT gold lot, both graded WCG 10 GEM-MT. Card 1: Kobe Bryant 1996-97 Fleer Flair Showcase Legacy "Rookie — Feel the Game (Away)" 23KT Gold (cert #64771718), young Kobe rising in the Lakers 8 on a basketball-textured gold canvas. Card 2: Michael Jordan 1986 Rookie "Feel the Game" 23KT Gold, \'86 Signature Series with printed signature (cert #64764850), MJ soaring on solid gold. Two legends, two slabs, one price. The ultimate 90s novelty grails for any basketball collection or display shelf. Both ship in their WCG slabs, bubble-wrapped, double-boxed with tracking, from a smoke-free shop.',
      7000, 'CRG-KOBE-MJ-23KT-GOLD-COMBO-WCG10', '/images/kobe-jordan-23kt-gold-rookie-combo-wcg10.jpg', 'Graded');
    addIfMissing('nba',
      'Michael Jordan 1998 Fleer 23KT Gold "1986 Rookie" Prism Holo Refractor WCG 10',
      'jordan-1998-fleer-23kt-gold-prism-holo-wcg10',
      'Michael Jordan — 1998 Fleer 23KT Gold "1986 Rookie" PRISM HOLO REFRACTOR, Signature Series with printed signature, graded WCG 10 GEM-MT (cert #64756250). MJ\'s iconic 1986 Fleer rookie pose reimagined in solid 23-karat gold with a stunning rainbow prism holo finish that dances in the light — the flashiest version of the most famous card pose in the hobby. Ships in the WCG slab, bubble-wrapped, double-boxed with tracking, from a smoke-free shop.',
      3500, 'CRG-JORDAN-98-FLEER-23KT-PRISM-WCG10', '/images/jordan-1998-fleer-23kt-gold-prism-holo-wcg10.jpg', 'Graded');

    // New adds (Jul 15 2026): Messi Leaf Legends ISA 10 + Messi/Ronaldo Double ISA 10
    addIfMissing('soccer',
      'Lionel Messi 2022 Leaf Legends Achievement #LA-05 — ISA 10 GEM MINT',
      'messi-2022-leaf-legends-la05-isa10',
      'Lionel Messi — 2022 Leaf Legends Achievement #LA-05, graded ISA 10 GEM MINT (cert #68481877). The GOAT in his Barcelona stripes on a classy black-and-white newsprint-style Legends design befitting the greatest to ever do it. Graded a perfect 10 the year he lifted the World Cup. A clean, elegant Messi slab at an entry price every collector can love. Ships in the ISA slab, bubble-wrapped, double-boxed with tracking, from a smoke-free shop.',
      3500, 'CRG-MESSI-22-LEAF-LEGENDS-LA05-ISA10', '/images/messi-2022-leaf-legends-la05-isa10.jpg', 'Graded');
    addIfMissing('soccer',
      'Lionel Messi / Cristiano Ronaldo 2022 Leaf Legends Double #LM-CR — ISA 10',
      'messi-ronaldo-2022-leaf-legends-double-isa10',
      'Lionel Messi / Cristiano Ronaldo — 2022 Leaf Legends Exclusive Edition DOUBLE #LM-CR, graded ISA 10 GEM MINT (cert #60754422). The two defining players of a generation, together on one card: Messi in the Blaugrana and Ronaldo in the famous white, the eternal debate sealed in a perfect-10 slab. The ultimate conversation piece for any football collection. Ships in the ISA slab, bubble-wrapped, double-boxed with tracking, from a smoke-free shop.',
      3500, 'CRG-MESSI-CR7-22-LEAF-DOUBLE-ISA10', '/images/messi-ronaldo-2022-leaf-legends-double-isa10.jpg', 'Graded');

    // New add (Jul 15 2026): Mickey Mantle 1964 All-Star Game patch card
    addIfMissing('collectibles',
      'Mickey Mantle 2010 Topps 1964 MLB All-Star Game Commemorative Patch #MCP-16',
      'mantle-2010-topps-1964-allstar-patch-mcp16',
      'Mickey Mantle — 2010 Topps Baseball Series 1, 1964 MLB All-Star Game Commemorative Patch #MCP-16. The Commerce Comet in pinstripes alongside a beautiful embroidered patch honoring the 1964 Midsummer Classic at brand-new Shea Stadium — a game The Mick himself played in. A classy, display-worthy Mantle for any Yankees or vintage baseball collection. Ships in a protective one-touch, bubble-wrapped, double-boxed with tracking, from a smoke-free shop.',
      3500, 'CRG-MANTLE-10-TOPPS-ASG-PATCH-MCP16', '/images/mantle-2010-topps-1964-allstar-patch-mcp16.jpg', 'Patch');

    // New add (Jul 15 2026): Mahomes Dynasty Collectibles MVP custom
    addIfMissing('football',
      'Patrick Mahomes 2024 Dynasty Collectibles "MVP" Cracked Ice Custom #15',
      'mahomes-2024-dynasty-mvp-custom',
      'Patrick Mahomes — 2024 Dynasty Collectibles "MVP" custom art card #15, cracked ice foil finish with printed signature and Lombardi trophy tribute back. The face of the NFL hoisting hardware on a dazzling gold-framed, cracked-ice canvas that lights up in hand. A striking display piece for any Chiefs or Mahomes collection. Ships in a magnetic one-touch, bubble-wrapped, double-boxed with tracking, from a smoke-free shop.',
      4000, 'CRG-MAHOMES-24-DYNASTY-MVP-CUSTOM', '/images/mahomes-2024-dynasty-mvp-custom.jpg', 'Custom');

    // New add (Jul 15 2026): Mahomes Select Premier Level Shock /249
    addIfMissing('football',
      'Patrick Mahomes 2024 Select Premier Level Red & Blue Shock Prizm #120 — /249',
      'mahomes-2024-select-premier-shock-249',
      'Patrick Mahomes — 2024 Panini Select, Premier Level Red & Blue Shock Prizm parallel #120, serial numbered 203/249. The two-time MVP and three-time champ slinging it in the Chiefs red on a wild black wave prizm crackling with red and blue shock energy. Select Premier Level parallels this loud always move fast. Pack-fresh in a one-touch. Ships bubble-wrapped, double-boxed with tracking, from a smoke-free shop.',
      4000, 'CRG-MAHOMES-24-SELECT-PREMIER-SHOCK-249', '/images/mahomes-2024-select-premier-shock-249.jpg', 'Numbered');

    // New add (Jul 15 2026): Magic/Kareem Legendary Tandems Red Cracked Ice
    addIfMissing('nba',
      'Magic Johnson / Kareem Abdul-Jabbar 2022-23 Contenders Optic Legendary Tandems #9 Red Cracked Ice',
      'magic-kareem-2022-optic-legendary-tandems-red-ice',
      'Magic Johnson / Kareem Abdul-Jabbar — 2022-23 Panini Contenders Optic, Legendary Tandems insert #9, Red Cracked Ice prizm. Showtime\'s two pillars — the no-look wizard and the skyhook king, six MVPs and five rings together in Tinseltown — sharing one card on a blazing red cracked ice finish. Pure Lakers royalty for the PC or the display shelf. Ships in a one-touch, bubble-wrapped, double-boxed with tracking, from a smoke-free shop.',
      2000, 'CRG-MAGIC-KAREEM-22-TANDEMS-RED-ICE', '/images/magic-kareem-2022-optic-legendary-tandems-red-ice.jpg', 'Insert');

    // New adds (Jul 15 2026): Wade RC lot + Magic Phazes
    addIfMissing('nba',
      'Dwyane Wade 2003-04 Topps Chrome Rookie Card #111',
      'wade-2003-topps-chrome-rc-111-lot-of-2',
      'Dwyane Wade — 2003-04 Topps Chrome Rookie Card #111. Flash\'s true chrome rookie: Draft Pick #5 soaring to the rack in the Heat black, from the legendary 2003 draft class (LeBron, Melo, Bosh, Wade). Miami legend, three rings, one of the greatest value RCs of the 2000s. Raw copy in a protective case — two available, so grab yours! Ships bubble-wrapped, double-boxed with tracking, from a smoke-free shop.',
      2500, 'CRG-WADE-03-TOPPS-CHROME-RC', '/images/wade-2003-topps-chrome-rc-111-lot-of-2.jpg', 'Rookie');
    // Wade sold individually (Jul 15 2026): $25 each, qty 2 — runs every boot (addIfMissing inserts stock 1)
    prepare('UPDATE products SET name = ?, description = ?, price = 2500, stock = 2, updated_at = datetime(\'now\') WHERE slug = ?')
      .run(
        'Dwyane Wade 2003-04 Topps Chrome Rookie Card #111',
        'Dwyane Wade — 2003-04 Topps Chrome Rookie Card #111. Flash\'s true chrome rookie: Draft Pick #5 soaring to the rack in the Heat black, from the legendary 2003 draft class (LeBron, Melo, Bosh, Wade). Miami legend, three rings, one of the greatest value RCs of the 2000s. Raw copy in a protective case — two available, so grab yours! Ships bubble-wrapped, double-boxed with tracking, from a smoke-free shop.',
        'wade-2003-topps-chrome-rc-111-lot-of-2');
    addIfMissing('nba',
      'Magic Johnson 2023-24 Donruss Optic Phazes #24 Holo Prizm',
      'magic-2023-optic-phazes-24-holo',
      'Magic Johnson — 2023-24 Panini Donruss Optic, Phazes insert #24, Holo Prizm. Four phases of Showtime brilliance on one card: Magic through the eras in the purple and gold, splashed across a psychedelic rainbow holo canvas. One of the best-looking Magic inserts in years, pack-fresh in a one-touch. Ships bubble-wrapped, double-boxed with tracking, from a smoke-free shop.',
      4500, 'CRG-MAGIC-23-OPTIC-PHAZES-24-HOLO', '/images/magic-2023-optic-phazes-24-holo.jpg', 'Insert');

    // New adds (Jul 15 2026): Venom Suspended Animation + Pulisic Monopoly Red
    addIfMissing('collectibles',
      'Venom 1994 Fleer Marvel Suspended Animation #4 of 12 — Limited Edition',
      'venom-1994-fleer-suspended-animation-4',
      'Venom — 1994 Fleer Amazing Spider-Man, Suspended Animation limited edition subset card, FOUR OF TWELVE. The symbiote at his menacing 90s best, tongue out and mid-lunge on a stained-glass web design with clear acetate-style borders — one of the coolest Venom inserts of the era, from the golden age of Marvel cards. Clean copy in a protective case. Ships bubble-wrapped, double-boxed with tracking, from a smoke-free shop.',
      2000, 'CRG-VENOM-94-FLEER-SUSPENDED-4', '/images/venom-1994-fleer-suspended-animation-4.jpg', 'Insert');
    addIfMissing('soccer',
      'Christian Pulisic 2026 Prizm Monopoly FIFA World Cup Red Prizm #47',
      'pulisic-2026-prizm-monopoly-red-47',
      'Christian Pulisic — 2026 Panini Prizm Monopoly FIFA World Cup, Red Prizm #47. Captain America in the USA white on a blazing red prizm finish, from the World Cup edition of the wildly popular Prizm Monopoly line — right as the tournament kicks off on home soil. Pack-fresh in a one-touch. Ships bubble-wrapped, double-boxed with tracking, from a smoke-free shop.',
      2000, 'CRG-PULISIC-26-MONOPOLY-RED-47', '/images/pulisic-2026-prizm-monopoly-red-47.jpg', 'Prizm');

    // New add (Jul 15 2026): Di Maria Trinity auto patch 1/20
    addIfMissing('soccer',
      'Ángel Di María 2022 Leaf Trinity Auto + Match-Worn Patch #PA-ADM — 1/20',
      'di-maria-2022-leaf-trinity-auto-patch-1-20',
      'Ángel Di María — 2022 Leaf Trinity #PA-ADM, authentic on-card style autograph + two-color MATCH-WORN patch, serial numbered 1/20 — THE FIRST COPY off the press. The World Cup final hero who scored in Argentina\'s 2022 triumph, with a gorgeous white-and-blue patch straight off his match-worn kit and a bold signature beneath it. Authenticity guaranteed by Leaf Trading Cards, sealed in the original case. Ships bubble-wrapped, double-boxed with tracking, fully insured, from a smoke-free shop.',
      8000, 'CRG-DIMARIA-22-TRINITY-AUTO-PATCH-1-20', '/images/di-maria-2022-leaf-trinity-auto-patch-1-20.jpg', 'Auto Patch');

    // New add (Jul 15 2026): Di Maria Futera Maestro match-worn 17/25
    addIfMissing('soccer',
      'Ángel Di María 2022 Futera Unique Maestro #MS06 Match-Worn Jersey — 17/25',
      'di-maria-2022-futera-maestro-ms06-17-25',
      'Ángel Di María — 2022 Futera Unique, MAESTRO #MS06 with game-worn memorabilia, serial numbered 17/25. An elegant sepia-toned tribute to El Fideo featuring a piece of his PSG jersey worn in the Champions League clash vs Real Madrid at the Parc des Princes on October 21, 2015 — match provenance printed right on the card. Futera\'s premium Unique line, only 25 copies in the world. Ships in a protective case, bubble-wrapped, double-boxed with tracking, from a smoke-free shop.',
      4500, 'CRG-DIMARIA-22-FUTERA-MAESTRO-17-25', '/images/di-maria-2022-futera-maestro-ms06-17-25.jpg', 'Match-Worn');

    // New add (Jul 16 2026): Di Maria Donruss Elite Pink Disco 01/25
    addIfMissing('soccer',
      'Ángel Di María 2022-23 Donruss Elite FIFA Pink Disco #14 — 01/25',
      'di-maria-2022-donruss-elite-pink-disco-1-25',
      'Ángel Di María — 2022-23 Panini Donruss Elite FIFA #14, PINK DISCO parallel serial numbered 01/25 — the FIRST COPY off the press. El Fideo in the Albiceleste on a dazzling pink disco-foil canvas that sparkles from every angle, fresh off his World Cup 2022 heroics. Elite Disco parallels this rare are true casehits. Pack-fresh in a protective case. Ships bubble-wrapped, double-boxed with tracking, from a smoke-free shop.',
      4500, 'CRG-DIMARIA-22-ELITE-PINK-DISCO-1-25', '/images/di-maria-2022-donruss-elite-pink-disco-1-25.jpg', 'Numbered');

    // New add (Jul 16 2026): Muhammad Ali Kayo hologram ASG 10
    addIfMissing('collectibles',
      'Muhammad Ali 1991 Kayo "The Greatest" Hologram — ASG 10',
      'ali-1991-kayo-hologram-asg-10',
      'Muhammad Ali — 1991 Kayo Boxing "The Greatest" HOLOGRAM card, graded a perfect 10 (Mint or Higher) by All-Star Grading Co. (cert #142255). The most iconic image in boxing history — Ali standing over Sonny Liston — rendered in stunning golden hologram foil that comes alive in the light. A vintage tribute to the three-time heavyweight champion of the world. Ships in the grading slab, bubble-wrapped, double-boxed with tracking, from a smoke-free shop.',
      4000, 'CRG-ALI-91-KAYO-HOLOGRAM-ASG10', '/images/ali-1991-kayo-hologram-asg-10.jpg', 'Graded 10');

    // New add (Jul 16 2026): Emiliano Martinez Select Terrace Prizm 17/49
    addIfMissing('soccer',
      'Emiliano Martínez 2022-23 Select Premier League Terrace Prizm #12 — 17/49',
      'martinez-2022-select-terrace-prizm-17-49',
      'Emiliano Martínez — 2022-23 Panini Select Premier League, Terrace Level Prizm #12, serial numbered 17/49. The World Cup-winning keeper and Aston Villa wall celebrating in the Villa kit on a wild multicolor prizm finish that erupts with color from every angle. Dibu\'s cards keep climbing and parallels this loud numbered under 50 never last. Pack-fresh in a protective case. Ships bubble-wrapped, double-boxed with tracking, from a smoke-free shop.',
      5500, 'CRG-MARTINEZ-22-SELECT-TERRACE-17-49', '/images/martinez-2022-select-terrace-prizm-17-49.jpg', 'Numbered');

    // New add (Jul 16 2026): Nico Paz WC 2026 gold foil sticker ARG 14
    addIfMissing('soccer',
      'Nico Paz 2026 Panini FIFA World Cup Sticker ARG 14 — Gold Foil',
      'nico-paz-2026-panini-wc-sticker-gold-arg14',
      'Nico Paz — 2026 Panini FIFA World Cup sticker ARG 14, GOLD FOIL parallel. Argentina\'s rising star in the Albiceleste on a gleaming gold textured foil, from the official Panini World Cup 2026 sticker collection. Paz hype is only heating up as the tournament arrives — gold foils of the Albiceleste are the first ones collectors chase. Pack-fresh in a protective one-touch. Ships bubble-wrapped, double-boxed with tracking, from a smoke-free shop.',
      4000, 'CRG-PAZ-26-WC-STICKER-GOLD-ARG14', '/images/nico-paz-2026-panini-wc-sticker-gold-arg14.jpg', 'Gold Foil');

    // New add (Jul 16 2026): Roberto Ayala Topps AFA pink 19/50
    addIfMissing('soccer',
      'Roberto Ayala 2023 Topps AFA Pink Swirl #50 — 19/50',
      'ayala-2023-topps-afa-pink-19-50',
      'Roberto Ayala — 2023 Topps AFA Argentina team set #50, PINK SWIRL parallel serial numbered 19/50. The legendary Albiceleste captain and cultured centre-back — 115 caps, 63 as captain — on a vivid pink swirl foil with ornate artwork honoring La Selección. From the official Topps AFA product. Pack-fresh in a protective one-touch. Ships bubble-wrapped, double-boxed with tracking, from a smoke-free shop.',
      3500, 'CRG-AYALA-23-TOPPS-AFA-PINK-19-50', '/images/ayala-2023-topps-afa-pink-19-50.jpg', 'Numbered');

    // SOLD on eBay (Jul 15 2026): Di Maria Trinity auto patch 1/20 — remove from storefront
    prepare('UPDATE products SET active = 0, updated_at = datetime(\'now\') WHERE slug = ? AND active = 1')
      .run('di-maria-2022-leaf-trinity-auto-patch-1-20');

    // Removed (Jul 16 2026): Udonis Haslem Tie-Dye 1/25 BGS 9.5 — remove from storefront
    prepare('UPDATE products SET active = 0, updated_at = datetime(\'now\') WHERE slug = ? AND active = 1')
      .run('udonis-haslem-2016-select-swatches-tie-dye-bgs95');

    // Removed (Jul 16 2026): Mahomes Dynasty MVP custom — remove from storefront
    prepare('UPDATE products SET active = 0, updated_at = datetime(\'now\') WHERE slug = ? AND active = 1')
      .run('mahomes-2024-dynasty-mvp-custom');

    // Removed (Jul 16 2026): Rafael Nadal NetPro rookie PSA 10 — remove from storefront
    prepare('UPDATE products SET active = 0, updated_at = datetime(\'now\') WHERE slug = ? AND active = 1')
      .run('nadal-2003-netpro-70-rookie-psa10');

    // Edit (Jul 16 2026): Messi Anime Nation — drop "#ANB-30" from title/description per Denny
    prepare('UPDATE products SET name = ?, description = ?, updated_at = datetime(\'now\') WHERE slug = ?')
      .run(
        'Lionel Messi 2023 Leaf Metal Anime Nation "Leo the Lion" /373 PSA 10',
        'Lionel Messi 2023 Leaf Metal Anime Nation — "Leo the Lion", serial numbered 45/373, graded PSA 10 Gem Mint (cert #76705063). Stunning anime artwork by Japanese manga/caricature artist Shion Minabe: Messi in the Albiceleste alongside a roaring lion on a color-shifting metal foil canvas. Leaf Web Exclusive with a tiny print run. PSA 10 GEM MINT in the original slab.',
        'messi-2023-leaf-anime-nation-anb30-psa10');

    // Removed (Jul 18 2026): Messi Anime Nation "Leo the Lion", Lamine Yamal Monopoly Prizm,
    // Pokémon 151 Ultra-Premium Collection — remove from storefront
    prepare('UPDATE products SET active = 0, updated_at = datetime(\'now\') WHERE slug = ? AND active = 1')
      .run('messi-2023-leaf-anime-nation-anb30-psa10');
    prepare('UPDATE products SET active = 0, updated_at = datetime(\'now\') WHERE slug = ? AND active = 1')
      .run('lamine-yamal-2026-panini-monopoly-prizm-wc26');
    prepare('UPDATE products SET active = 0, updated_at = datetime(\'now\') WHERE slug = ? AND active = 1')
      .run('pokemon-sv151-ultra-premium-collection-sealed');

    // Removed (Jul 18 2026): batch of sold cards per Denny's X'd screenshots
    for (const soldSlug of [
      'messi-2019-chronicles-pitch-kings-psa10',
      'magic-johnson-leaf-signature-decade-80s-auto-7-10',
      'mantle-2010-topps-1964-allstar-patch-mcp16',
      'mahomes-2024-select-premier-shock-249',
      'magic-kareem-2022-optic-legendary-tandems-red-ice',
      'magic-2023-optic-phazes-24-holo',
      'venom-1994-fleer-suspended-animation-4',
      'tapu-bulu-gx-hidden-fates-sv91-psa10',
    ]) {
      prepare('UPDATE products SET active = 0, updated_at = datetime(\'now\') WHERE slug = ? AND active = 1')
        .run(soldSlug);
    }

    // New adds (Jul 19 2026): PSA 10 Pokémon trio — Mega Charizard X ex, Rayquaza VMAX, Charizard ex
    addIfMissing('pokemon',
      'Mega Charizard X ex 2025 Phantasmal Flames #109/094 Ultra Rare PSA 10',
      'mega-charizard-x-ex-pfl-109-psa10',
      'Mega Charizard X ex — 2025 Pokémon Mega Evolution: Phantasmal Flames, Ultra Rare #109/094, graded PSA 10 GEM MINT (cert #146834547). The king is back in Mega form: Mega Charizard X tearing across a dark full-art canvas from the hottest new era of the TCG. A secret-rare Charizard in flawless gem mint — these do not sit around. Ships in the PSA slab, bubble-wrapped, double-boxed with tracking, fully insured, from a smoke-free shop.',
      20000, 'CRG-MEGA-CHARIZARD-X-EX-PFL109-PSA10', '/images/mega-charizard-x-ex-pfl-109-psa10.jpg', 'PSA 10');
    addIfMissing('pokemon',
      'Rayquaza VMAX 2021 Evolving Skies #111/203 Full Art PSA 10',
      'rayquaza-vmax-evolving-skies-111-psa10',
      'Rayquaza VMAX — 2021 Pokémon Sword & Shield: Evolving Skies, Full Art #111/203, graded PSA 10 GEM MINT (cert #93418850). One of the most iconic modern Pokémon cards, period. The sky-high legend from the most chased set of the SWSH era, in flawless gem mint. Evolving Skies hits keep climbing and the Rayquaza VMAX full art is THE card everyone wants. Ships in the PSA slab, bubble-wrapped, double-boxed with tracking, fully insured, from a smoke-free shop.',
      22000, 'CRG-RAYQUAZA-VMAX-EVS111-PSA10', '/images/rayquaza-vmax-evolving-skies-111-psa10.jpg', 'PSA 10');
    addIfMissing('pokemon',
      'Charizard ex 2024 Paldean Fates Tin Promo #SVP-074 PSA 10',
      'charizard-ex-svp-074-paldean-fates-psa10',
      'Charizard ex — 2024 Pokémon Scarlet & Violet Black Star Promo #SVP-074, the Paldean Fates Tin shiny Charizard, graded PSA 10 GEM MINT (cert #124615880). The black shiny Charizard in crystalline art — one of the most popular promos of the entire Scarlet & Violet era. Gem mint, flawless in hand. Ships in the PSA slab, bubble-wrapped, double-boxed with tracking, from a smoke-free shop.',
      21000, 'CRG-CHARIZARD-EX-SVP074-PSA10', '/images/charizard-ex-svp-074-paldean-fates-psa10.jpg', 'PSA 10');

    // New adds (Jul 19 2026, batch 2): Mega Kangaskhan ex + One Piece Luffy
    addIfMissing('pokemon',
      'Mega Kangaskhan ex 2025 Mega Evolution #164/182 Ultra Rare PSA 10',
      'mega-kangaskhan-ex-meg-164-psa10',
      'Mega Kangaskhan ex — 2025 Pokémon Mega Evolution, Ultra Rare #164/182, graded PSA 10 GEM MINT (cert #144566647). Mama and baby throwing hands in stunning full-art from the newest era of the TCG. Flawless gem mint copy of a fan-favorite Mega. Ships in the PSA slab, bubble-wrapped, double-boxed with tracking, from a smoke-free shop.',
      7000, 'CRG-MEGA-KANGASKHAN-EX-MEG164-PSA10', '/images/mega-kangaskhan-ex-meg-164-psa10.jpg', 'PSA 10');
    addIfMissing('collectibles',
      'Monkey D. Luffy 2025 One Piece OP13 #118 Alt-Art PSA 10',
      'luffy-op13-118-psa10',
      'Monkey D. Luffy — 2025 One Piece Card Game OP13 EN #118, graded PSA 10 GEM MINT (cert #155324312). The future Pirate King unleashing a haymaker in gorgeous alt-art — One Piece cards have been on an absolute tear and Luffy is THE face of the game. Gem mint, flawless in hand. Ships in the PSA slab, bubble-wrapped, double-boxed with tracking, fully insured, from a smoke-free shop.',
      16000, 'CRG-LUFFY-OP13-118-PSA10', '/images/luffy-op13-118-psa10.jpg', 'PSA 10');

    // New add (Jul 19 2026): Jolteon ex Prismatic Surprise Box exclusive
    addIfMissing('pokemon',
      'Jolteon ex 2025 Prismatic Evolutions Surprise Box #030 Stamped PSA 10',
      'jolteon-ex-pre-030-surprise-box-psa10',
      'Jolteon ex — 2025 Pokémon Scarlet & Violet: Prismatic Evolutions #030/131, Surprise Box Exclusive stamp, graded PSA 10 GEM MINT (cert #142472458). The lightning Eeveelution from the most hyped set in years, with the exclusive Prismatic Evolutions stamp you can only pull from the Surprise Box. Gem mint, flawless in hand. Ships in the PSA slab, bubble-wrapped, double-boxed with tracking, from a smoke-free shop.',
      6000, 'CRG-JOLTEON-EX-PRE030-PSA10', '/images/jolteon-ex-pre-030-surprise-box-psa10.jpg', 'PSA 10');

    // Price change (Jul 19 2026): Charizard ex SVP Paldean Fates → $210 per Denny
    prepare('UPDATE products SET price = 21000, updated_at = datetime(\'now\') WHERE slug = ? AND price <> 21000')
      .run('charizard-ex-svp-074-paldean-fates-psa10');

    // Removed (Jul 20 2026): Jolteon ex Surprise Box — remove from storefront per Denny
    prepare('UPDATE products SET active = 0, updated_at = datetime(\'now\') WHERE slug = ? AND active = 1')
      .run('jolteon-ex-pre-030-surprise-box-psa10');

    // Price change (Jul 20 2026): Luffy OP13 → $160 per Denny
    prepare('UPDATE products SET price = 16000, updated_at = datetime(\'now\') WHERE slug = ? AND price <> 16000')
      .run('luffy-op13-118-psa10');

    // New adds (Jul 20 2026): Celebrations Zekrom/Reshiram + First Partner Bulbasaur/Charmander
    addIfMissing('pokemon',
      'Zekrom 2021 Celebrations Classic Collection #114 Full Art PSA 10',
      'zekrom-celebrations-114-psa10',
      'Zekrom — 2021 Pokémon Celebrations Classic Collection #114/114 (Black & White), Full Art, graded PSA 10 GEM MINT (cert #123123304). The legendary black dragon in shimmering full-art from the beloved 25th Anniversary Classic Collection — a faithful reprint of the iconic BW full art with the gold 25 stamp. Gem mint, flawless in hand. Ships in the PSA slab, bubble-wrapped, double-boxed with tracking, from a smoke-free shop.',
      15000, 'CRG-ZEKROM-CEL114-PSA10', '/images/zekrom-celebrations-114-psa10.jpg', 'PSA 10');
    addIfMissing('pokemon',
      'Reshiram 2021 Celebrations Classic Collection #113 Full Art PSA 10',
      'reshiram-celebrations-113-psa10',
      'Reshiram — 2021 Pokémon Celebrations Classic Collection #113/114 (Black & White), Full Art, graded PSA 10 GEM MINT (cert #138517440). The legendary white dragon blazing across sparkling full-art from the 25th Anniversary Classic Collection, gold 25 stamp and all. Pair it with Zekrom for the Tao duo. Gem mint, flawless in hand. Ships in the PSA slab, bubble-wrapped, double-boxed with tracking, from a smoke-free shop.',
      16000, 'CRG-RESHIRAM-CEL113-PSA10', '/images/reshiram-celebrations-113-psa10.jpg', 'PSA 10');
    addIfMissing('pokemon',
      'Bulbasaur 2026 First Partner Illustration Collection #037 PSA 10',
      'bulbasaur-mep-037-first-partner-psa10',
      'Bulbasaur — 2026 Pokémon MEP Black Star Promo #037, First Partner Illustration Collection Series 1, graded PSA 10 GEM MINT (cert #161754450). Gorgeous illustration-rare-style art of the OG grass starter loaded with Kanto easter eggs, with the anniversary Pikachu stamp. Gem mint, flawless in hand. Ships in the PSA slab, bubble-wrapped, double-boxed with tracking, from a smoke-free shop.',
      19000, 'CRG-BULBASAUR-MEP037-PSA10', '/images/bulbasaur-mep-037-first-partner-psa10.jpg', 'PSA 10');
    addIfMissing('pokemon',
      'Charmander 2026 First Partner Illustration Collection #038 PSA 10',
      'charmander-mep-038-first-partner-psa10',
      'Charmander — 2026 Pokémon MEP Black Star Promo #038, First Partner Illustration Collection Series 1, graded PSA 10 GEM MINT (cert #161754452). The fire starter that launched a thousand collections, in stunning full-art packed with nostalgia and the anniversary Pikachu stamp. The chase card of the First Partner set. Gem mint, flawless in hand. Ships in the PSA slab, bubble-wrapped, double-boxed with tracking, fully insured, from a smoke-free shop.',
      26000, 'CRG-CHARMANDER-MEP038-PSA10', '/images/charmander-mep-038-first-partner-psa10.jpg', 'PSA 10');

    // One Piece section (Jul 20 2026): new category + move Luffy into it (idempotent, every boot)
    if (!prepare('SELECT id FROM categories WHERE slug = ?').get('one-piece')) {
      prepare('INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)')
        .run('One Piece', 'one-piece', 'One Piece Card Game grails — graded singles and alt-arts', 6);
    }
    prepare(`UPDATE products SET category_id = (SELECT id FROM categories WHERE slug = 'one-piece'), updated_at = datetime('now')
             WHERE slug = ? AND category_id <> (SELECT id FROM categories WHERE slug = 'one-piece')`)
      .run('luffy-op13-118-psa10');

    // New add (Jul 22 2026): One Piece Luffy-Tarou OP11 Special Alt-Art PSA 10
    addIfMissing('one-piece',
      'Luffy-Tarou 2025 One Piece OP11 #005 Special Alt-Art PSA 10',
      'luffy-tarou-op11-005-psa10',
      'Luffy-Tarou — 2025 One Piece Card Game OP11 EN #005, Special Alternate Art (OP11-005), graded PSA 10 GEM MINT (cert #130837550). Luffy in his Wano "Luffytaro" kimono, blade raised across a breathtaking manga-cover alt-art — one of the most gorgeous and sought-after Special Arts in the entire One Piece TCG. One Piece has been on an absolute tear and a gem mint SP Luffy is a true grail. Flawless in hand. Ships in the PSA slab, bubble-wrapped, double-boxed with tracking, fully insured, from a smoke-free shop.',
      73000, 'CRG-LUFFY-TAROU-OP11-005-PSA10', '/images/luffy-tarou-op11-005-psa10.jpg', 'PSA 10');

    // New add (Jul 22 2026): Darth Vader Kakawow Phantom Star Wars Disney 100 Nebula Split TAG 10
    addIfMissing('collectibles',
      'Darth Vader 2023 Kakawow Phantom Star Wars Disney 100 Nebula Split #d/666 TAG 10',
      'darth-vader-kakawow-phantom-nebula-split-tag10',
      'Darth Vader — 2023 Kakawow Phantom Star Wars Disney 100, Nebula Split #PS-NXY-06, serial numbered 006/666, graded TAG GEM MINT 10 (cert #G4988321). The Sith Lord rendered on a stunning holographic nebula backdrop from the premium Kakawow Phantom set celebrating Disney 100 — one of the most eye-catching Star Wars cards out there, limited to just 666 copies. Flawless gem mint in hand. Ships in the graded slab, bubble-wrapped, double-boxed with tracking, from a smoke-free shop.',
      11000, 'CRG-DARTH-VADER-KAKAWOW-PHANTOM-NEBULA-TAG10', '/images/darth-vader-kakawow-phantom-nebula-split-tag10.jpg', 'TAG 10');

    // New add (Jul 22 2026): Mega Zygarde ex Premium Collection (sealed box)
    addIfMissing('pokemon',
      'Pokémon Mega Zygarde ex Premium Collection — Factory Sealed',
      'mega-zygarde-ex-premium-collection',
      'Pokémon TCG Mega Zygarde ex Premium Collection Box — brand new and factory sealed. Includes a foil Mega Zygarde ex promo card, an oversized lenticular card, a foil promo card, a reusable sticker, and 8 Pokémon TCG booster packs. A gorgeous centerpiece collection featuring the Mega-Evolved form of Zygarde — perfect for collectors and rippers alike. Sealed in hand, ready to ship. Ships bubble-wrapped and boxed with tracking, from a smoke-free shop.',
      7000, 'CRG-MEGA-ZYGARDE-EX-PREMIUM-COLLECTION', '/images/mega-zygarde-ex-premium-collection.jpg', 'Sealed');

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
