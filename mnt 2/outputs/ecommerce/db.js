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
      100000, 'CRG-MEGA-GRENINJA-EX-CRI116-PSA10', '/images/mega-greninja-ex-cri-116-sir-psa10.jpg', 'PSA 10');
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
