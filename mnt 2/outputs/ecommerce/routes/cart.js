/**
 * routes/cart.js — Session-based shopping cart
 */

const router = require('express').Router();
const db     = require('../db');

function getCart(req) {
  if (!req.session.cart) req.session.cart = { items: [] };
  return req.session.cart;
}

function calcCartTotals(items) {
  const subtotal = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
  const settings = db.helpers.getSettings();
  const taxRate  = parseFloat(settings.tax_rate || 0) / 100;
  const threshold = parseInt(settings.free_shipping_threshold || 0);
  const flatShip  = parseInt(settings.shipping_flat || 0);
  const shipping  = (threshold > 0 && subtotal >= threshold) || flatShip === 0 ? 0 : flatShip;
  const tax = Math.round(subtotal * taxRate);
  const total = subtotal + shipping + tax;
  return { subtotal, shipping, tax, total, item_count: items.reduce((s, i) => s + i.quantity, 0) };
}

// GET /api/cart
router.get('/', (req, res) => {
  const cart = getCart(req);
  const totals = calcCartTotals(cart.items);
  res.json({
    items: cart.items.map(i => ({
      ...i,
      price_formatted:    `$${db.helpers.formatPrice(i.price)}`,
      subtotal_formatted: `$${db.helpers.formatPrice(i.price * i.quantity)}`,
    })),
    ...totals,
    subtotal_formatted: `$${db.helpers.formatPrice(totals.subtotal)}`,
    shipping_formatted: `$${db.helpers.formatPrice(totals.shipping)}`,
    tax_formatted:      `$${db.helpers.formatPrice(totals.tax)}`,
    total_formatted:    `$${db.helpers.formatPrice(totals.total)}`,
  });
});

// POST /api/cart/add
router.post('/add', (req, res) => {
  const { product_id, quantity = 1 } = req.body;
  if (!product_id) return res.status(400).json({ error: 'product_id required' });

  const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(product_id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  if (product.stock <= 0) return res.status(400).json({ error: `${product.name} is sold out` });

  const qty = Math.max(1, parseInt(quantity));
  const cart = getCart(req);
  const existing = cart.items.find(i => i.product_id === product.id);

  if (existing) {
    const newQty = existing.quantity + qty;
    if (newQty > product.stock) {
      return res.status(400).json({ error: `Only ${product.stock} in stock` });
    }
    existing.quantity = newQty;
  } else {
    if (qty > product.stock) {
      return res.status(400).json({ error: `Only ${product.stock} in stock` });
    }
    cart.items.push({
      product_id:  product.id,
      name:        product.name,
      price:       product.price,
      image_url:   product.image_url,
      slug:        product.slug,
      quantity:    qty,
    });
  }

  req.session.cart = cart;
  const totals = calcCartTotals(cart.items);
  res.json({ success: true, item_count: totals.item_count, message: `${product.name} added to cart` });
});

// PATCH /api/cart/update
router.patch('/update', (req, res) => {
  const { product_id, quantity } = req.body;
  if (!product_id) return res.status(400).json({ error: 'product_id required' });

  const cart = getCart(req);
  const qty = parseInt(quantity);

  if (qty <= 0) {
    cart.items = cart.items.filter(i => i.product_id !== product_id);
  } else {
    const item = cart.items.find(i => i.product_id === product_id);
    if (!item) return res.status(404).json({ error: 'Item not in cart' });
    // Stock check
    const product = db.prepare('SELECT stock FROM products WHERE id = ?').get(product_id);
    if (product && product.stock > 0 && qty > product.stock) {
      return res.status(400).json({ error: `Only ${product.stock} in stock` });
    }
    item.quantity = qty;
  }

  req.session.cart = cart;
  const totals = calcCartTotals(cart.items);
  res.json({ success: true, ...totals,
    subtotal_formatted: `$${db.helpers.formatPrice(totals.subtotal)}`,
    total_formatted:    `$${db.helpers.formatPrice(totals.total)}`,
  });
});

// DELETE /api/cart/remove/:product_id
router.delete('/remove/:product_id', (req, res) => {
  const pid = parseInt(req.params.product_id);
  const cart = getCart(req);
  cart.items = cart.items.filter(i => i.product_id !== pid);
  req.session.cart = cart;
  const totals = calcCartTotals(cart.items);
  res.json({ success: true, ...totals });
});

// DELETE /api/cart/clear
router.delete('/clear', (req, res) => {
  req.session.cart = { items: [] };
  res.json({ success: true });
});

module.exports = router;
