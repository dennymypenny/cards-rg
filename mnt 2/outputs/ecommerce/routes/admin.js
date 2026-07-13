/**
 * routes/admin.js — Admin auth + management API
 */

const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const db      = require('../db');

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  if (req.session?.adminId) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── AUTH ──────────────────────────────────────────────────────────────────────

// POST /api/admin/login
router.post('/login', (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'PIN required' });

  const storedPin = process.env.ADMIN_PASSWORD || '1134';
  if (password !== storedPin) {
    return res.status(401).json({ error: 'Wrong PIN' });
  }

  req.session.adminId   = 1;
  req.session.adminName = 'Admin';
  res.json({ success: true, name: 'Admin' });
});

// POST /api/admin/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// GET /api/admin/me
router.get('/me', requireAdmin, (req, res) => {
  res.json({ id: req.session.adminId, name: req.session.adminName });
});

// ── DASHBOARD STATS ───────────────────────────────────────────────────────────

router.get('/stats', requireAdmin, (req, res) => {
  const revenue    = db.prepare(`SELECT COALESCE(SUM(total),0) as v FROM orders WHERE status != 'cancelled'`).get().v;
  const orderCount = db.prepare(`SELECT COUNT(*) as v FROM orders`).get().v;
  const newOrders  = db.prepare(`SELECT COUNT(*) as v FROM orders WHERE status = 'paid'`).get().v;
  const products   = db.prepare(`SELECT COUNT(*) as v FROM products WHERE active = 1`).get().v;
  const lowStock   = db.prepare(`SELECT COUNT(*) as v FROM products WHERE stock <= 5 AND stock > 0`).get().v;
  const outOfStock = db.prepare(`SELECT COUNT(*) as v FROM products WHERE stock = 0`).get().v;

  const recentOrders = db.prepare(`
    SELECT * FROM orders ORDER BY created_at DESC LIMIT 8
  `).all();

  const salesByDay = db.prepare(`
    SELECT date(created_at) as date, SUM(total) as revenue, COUNT(*) as orders
    FROM orders WHERE status != 'cancelled'
      AND created_at >= date('now', '-29 days')
    GROUP BY date(created_at)
    ORDER BY date
  `).all();

  res.json({
    revenue,  revenue_formatted: `$${db.helpers.formatPrice(revenue)}`,
    orderCount, newOrders, products, lowStock, outOfStock,
    recentOrders: recentOrders.map(o => ({
      ...o,
      total_formatted: `$${db.helpers.formatPrice(o.total)}`
    })),
    salesByDay,
  });
});

// ── ORDERS ────────────────────────────────────────────────────────────────────

router.get('/orders', requireAdmin, (req, res) => {
  const { status, search, limit = 50, offset = 0 } = req.query;
  let sql = 'SELECT * FROM orders WHERE 1=1';
  const params = [];

  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (search) {
    sql += ' AND (customer_name LIKE ? OR customer_email LIKE ? OR order_number LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));

  const orders = db.prepare(sql).all(...params);
  const total  = db.prepare('SELECT COUNT(*) as c FROM orders').get().c;

  res.json({
    orders: orders.map(o => ({ ...o, total_formatted: `$${db.helpers.formatPrice(o.total)}` })),
    total,
  });
});

router.get('/orders/:id', requireAdmin, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
  res.json({
    order: {
      ...order, items,
      subtotal_formatted: `$${db.helpers.formatPrice(order.subtotal)}`,
      shipping_formatted: `$${db.helpers.formatPrice(order.shipping)}`,
      tax_formatted:      `$${db.helpers.formatPrice(order.tax)}`,
      total_formatted:    `$${db.helpers.formatPrice(order.total)}`,
    }
  });
});

router.patch('/orders/:id/status', requireAdmin, (req, res) => {
  const { status } = req.body;
  const allowed = ['pending','paid','processing','shipped','delivered','cancelled','refunded'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  db.prepare(`UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(status, req.params.id);
  res.json({ success: true });
});

// ── PRODUCTS ──────────────────────────────────────────────────────────────────

router.get('/products', requireAdmin, (req, res) => {
  const { search, category, limit = 50, offset = 0 } = req.query;
  let sql = `
    SELECT p.*, c.name as category_name FROM products p
    LEFT JOIN categories c ON p.category_id = c.id WHERE 1=1
  `;
  const params = [];
  if (search)   { sql += ' AND (p.name LIKE ? OR p.sku LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  if (category) { sql += ' AND c.slug = ?'; params.push(category); }
  sql += ' ORDER BY p.created_at DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));

  const products = db.prepare(sql).all(...params);
  const total    = db.prepare('SELECT COUNT(*) as c FROM products').get().c;

  res.json({
    products: products.map(p => ({
      ...p,
      price_formatted: `$${db.helpers.formatPrice(p.price)}`,
    })),
    total,
  });
});

router.post('/products', requireAdmin, (req, res) => {
  const { category_id, name, description, price, compare_price, stock, sku, badge, active, image_url } = req.body;
  if (!name || !price) return res.status(400).json({ error: 'name and price are required' });

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now();

  const result = db.prepare(`
    INSERT INTO products (category_id, name, slug, description, price, compare_price, stock, sku, badge, active, image_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    category_id || null, name, slug, description || null,
    Math.round(parseFloat(price) * 100),
    compare_price ? Math.round(parseFloat(compare_price) * 100) : null,
    parseInt(stock) || 0, sku || null, badge || null,
    active === false ? 0 : 1,
    image_url || null
  );

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ success: true, product });
});

router.put('/products/:id', requireAdmin, (req, res) => {
  const { category_id, name, description, price, compare_price, stock, sku, badge, active, image_url } = req.body;

  db.prepare(`
    UPDATE products SET
      category_id = ?, name = ?, description = ?, price = ?, compare_price = ?,
      stock = ?, sku = ?, badge = ?, active = ?, image_url = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    category_id || null, name, description || null,
    Math.round(parseFloat(price) * 100),
    compare_price ? Math.round(parseFloat(compare_price) * 100) : null,
    parseInt(stock) || 0, sku || null, badge || null,
    active === false || active === 0 ? 0 : 1,
    image_url || null,
    req.params.id
  );

  res.json({ success: true });
});

router.delete('/products/:id', requireAdmin, (req, res) => {
  db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── QUICK PRICE CHANGE (from /hub) ────────────────────────────────────────────
// PATCH /api/admin/products/:id/price  { price: 1700 }   (price in DOLLARS)
//
// 1. Updates the live DB instantly (site reflects it immediately).
// 2. Writes the override to price-overrides.json so db.init() re-applies it
//    on every boot — Render's disk is ephemeral, so without this the price
//    would silently revert on the next deploy.
// 3. If GITHUB_TOKEN is set (Render env var, needs repo write access), commits
//    the overrides file to GitHub so the change is permanent and triggers a
//    Render deploy on its own.
router.patch('/products/:id/price', requireAdmin, async (req, res) => {
  const fs   = require('fs');
  const path = require('path');

  const cents = Math.round(parseFloat(req.body?.price) * 100);
  if (!Number.isFinite(cents) || cents < 100 || cents > 100000000) {
    return res.status(400).json({ error: 'Please enter a valid price.' });
  }

  const product = db.prepare('SELECT id, slug, name, price FROM products WHERE id = ?')
                    .get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  db.prepare(`UPDATE products SET price = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(cents, product.id);

  // Persist locally so a same-instance restart keeps it
  const ovPath = path.join(__dirname, '..', 'price-overrides.json');
  let overrides = {};
  try { overrides = JSON.parse(fs.readFileSync(ovPath, 'utf8')) || {}; } catch (e) { /* fresh file */ }
  overrides[product.slug] = cents;
  const ovJson = JSON.stringify(overrides, null, 2) + '\n';
  try { fs.writeFileSync(ovPath, ovJson); } catch (e) { console.warn('[admin] could not write price-overrides.json:', e.message); }

  // Commit to GitHub so the change survives redeploys (and auto-deploys)
  let committed = false, commitError = null;
  if (process.env.GITHUB_TOKEN) {
    try {
      const repo     = process.env.GITHUB_REPO || 'dennymypenny/cards-rg';
      const filePath = 'mnt 2/outputs/ecommerce/price-overrides.json';
      const apiUrl   = `https://api.github.com/repos/${repo}/contents/` +
                       filePath.split('/').map(encodeURIComponent).join('/');
      const headers  = {
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
        'Accept':        'application/vnd.github+json',
        'User-Agent':    'cardsrg-hub',
      };
      const cur = await fetch(apiUrl, { headers, signal: AbortSignal.timeout(8000) });
      const sha = cur.ok ? (await cur.json()).sha : undefined;
      const put = await fetch(apiUrl, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `Hub price change: ${product.name} → $${(cents / 100).toFixed(2)}`,
          content: Buffer.from(ovJson).toString('base64'),
          ...(sha ? { sha } : {}),
        }),
        signal: AbortSignal.timeout(8000),
      });
      committed = put.ok;
      if (!put.ok) commitError = `GitHub API ${put.status}`;
    } catch (e) {
      commitError = e.message;
    }
  } else {
    commitError = 'GITHUB_TOKEN not set';
  }

  console.log(`[admin] price change: ${product.slug} $${(product.price / 100).toFixed(2)} → $${(cents / 100).toFixed(2)} (committed: ${committed})`);
  res.json({
    ok: true,
    price: cents,
    price_formatted: `$${db.helpers.formatPrice(cents)}`,
    committed,
    commitError,
  });
});

// ── NTFY DIAGNOSTIC (from /hub) ───────────────────────────────────────────────
// GET /api/admin/ntfy-test — sends a test push and reports the topic used,
// so we can see exactly where offer/cart alerts are going in production.
router.get('/ntfy-test', requireAdmin, async (req, res) => {
  const topic = process.env.NTFY_TOPIC || 'crg-denny-alerts';
  try {
    const r = await fetch(`https://ntfy.sh/${topic}`, {
      method:  'POST',
      headers: { 'Title': '🔔 CRG Hub Test', 'Tags': 'white_check_mark', 'Content-Type': 'text/plain; charset=utf-8' },
      body:    'Test notification from the CRG Hub — alerts are working!',
      signal:  AbortSignal.timeout(6000),
    });
    res.json({ topic, ok: r.ok, status: r.status });
  } catch (e) {
    res.json({ topic, ok: false, error: e.message });
  }
});

// ── CATEGORIES ────────────────────────────────────────────────────────────────

router.get('/categories', requireAdmin, (req, res) => {
  const cats = db.prepare(`
    SELECT c.*, COUNT(p.id) as product_count
    FROM categories c LEFT JOIN products p ON p.category_id = c.id
    GROUP BY c.id ORDER BY c.sort_order
  `).all();
  res.json({ categories: cats });
});

router.post('/categories', requireAdmin, (req, res) => {
  const { name, description, sort_order = 0 } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  try {
    const result = db.prepare(
      'INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)'
    ).run(name, slug, description || null, sort_order);
    res.status(201).json({ success: true, id: result.lastInsertRowid });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Category slug already exists' });
    throw e;
  }
});

router.put('/categories/:id', requireAdmin, (req, res) => {
  const { name, description, sort_order } = req.body;
  db.prepare('UPDATE categories SET name = ?, description = ?, sort_order = ? WHERE id = ?')
    .run(name, description || null, sort_order || 0, req.params.id);
  res.json({ success: true });
});

router.delete('/categories/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── SETTINGS ──────────────────────────────────────────────────────────────────

router.get('/settings', requireAdmin, (req, res) => {
  res.json({ settings: db.helpers.getSettings() });
});

router.patch('/settings', requireAdmin, (req, res) => {
  const allowed = ['store_name','store_currency','tax_rate','shipping_flat','free_shipping_threshold'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) db.helpers.updateSetting(key, req.body[key]);
  }
  res.json({ success: true, settings: db.helpers.getSettings() });
});

// ── ADMIN PASSWORD CHANGE ─────────────────────────────────────────────────────

router.post('/change-password', requireAdmin, (req, res) => {
  const { current, newPassword } = req.body;
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.session.adminId);
  if (!bcrypt.compareSync(current, admin.password)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  db.prepare('UPDATE admins SET password = ? WHERE id = ?')
    .run(bcrypt.hashSync(newPassword, 12), req.session.adminId);
  res.json({ success: true });
});

module.exports = router;
