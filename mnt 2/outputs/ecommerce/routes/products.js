/**
 * routes/products.js — Public product & category endpoints
 */

const router = require('express').Router();
const db     = require('../db');

// GET /api/products — list all active products (with optional filters)
router.get('/', (req, res) => {
  const { category, search, sort = 'created_at', order = 'desc', limit = 50, offset = 0 } = req.query;

  let sql = `
    SELECT p.*, c.name as category_name, c.slug as category_slug
    FROM products p
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE p.active = 1
  `;
  const params = [];

  if (category) {
    sql += ' AND c.slug = ?';
    params.push(category);
  }

  if (search) {
    sql += ' AND (p.name LIKE ? OR p.description LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }

  const allowedSort = ['created_at', 'price', 'name'];
  const allowedOrder = ['asc', 'desc'];
  const safeSort  = allowedSort.includes(sort)  ? sort  : 'created_at';
  const safeOrder = allowedOrder.includes(order) ? order : 'desc';

  sql += ` ORDER BY p.${safeSort} ${safeOrder} LIMIT ? OFFSET ?`;
  params.push(Number(limit), Number(offset));

  const products = db.prepare(sql).all(...params);

  // Format prices
  const formatted = products.map(p => ({
    ...p,
    price_formatted:         `$${db.helpers.formatPrice(p.price)}`,
    compare_price_formatted: p.compare_price ? `$${db.helpers.formatPrice(p.compare_price)}` : null,
  }));

  res.json({ products: formatted });
});

// GET /api/products/categories — all categories
router.get('/categories', (req, res) => {
  const cats = db.prepare(`
    SELECT c.*, COUNT(p.id) as product_count
    FROM categories c
    LEFT JOIN products p ON p.category_id = c.id AND p.active = 1
    GROUP BY c.id
    ORDER BY c.sort_order
  `).all();
  res.json({ categories: cats });
});

// GET /api/products/export.csv — active inventory as a spreadsheet (linked from /hub)
router.get('/export.csv', (req, res) => {
  const rows = db.prepare(`
    SELECT p.name, c.name AS category, p.price, p.badge, p.sku, p.stock, p.created_at
    FROM products p
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE p.active = 1
    ORDER BY c.sort_order, p.price DESC
  `).all();
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = ['card,category,ask_price_usd,badge,sku,in_stock,listed_at']
    .concat(rows.map(r => [r.name, r.category, (r.price / 100).toFixed(2), r.badge, r.sku, r.stock, r.created_at].map(esc).join(',')))
    .join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="crg-active-inventory.csv"');
  res.send(csv);
});

// GET /api/products/:slug — single product
router.get('/:slug', (req, res) => {
  const product = db.prepare(`
    SELECT p.*, c.name as category_name, c.slug as category_slug
    FROM products p
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE p.slug = ? AND p.active = 1
  `).get(req.params.slug);

  if (!product) return res.status(404).json({ error: 'Product not found' });

  res.json({
    product: {
      ...product,
      price_formatted:         `$${db.helpers.formatPrice(product.price)}`,
      compare_price_formatted: product.compare_price ? `$${db.helpers.formatPrice(product.compare_price)}` : null,
    }
  });
});

module.exports = router;
