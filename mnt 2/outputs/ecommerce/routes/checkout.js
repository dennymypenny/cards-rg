/**
 * routes/checkout.js — Stripe Checkout integration
 */

const router = require('express').Router();
const db     = require('../db');

// Lazy-init Stripe so the server still starts without a key configured
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw Object.assign(new Error('STRIPE_SECRET_KEY not set in .env'), { statusCode: 503 });
  }
  return require('stripe')(process.env.STRIPE_SECRET_KEY);
}

// ── POST /api/checkout/session ─────────────────────────────────────────────
// Creates a Stripe Checkout session from the current cart
router.post('/session', async (req, res, next) => {
  try {
    const stripe = getStripe();
    const cart   = req.session.cart;

    if (!cart || !cart.items || cart.items.length === 0) {
      return res.status(400).json({ error: 'Your cart is empty' });
    }

    const storeUrl  = process.env.STORE_URL || 'http://localhost:3000';
    const settings  = db.helpers.getSettings();
    const storeName = settings.store_name || 'My Store';
    const taxRate   = parseFloat(settings.tax_rate || 0) / 100;
    const threshold = parseInt(settings.free_shipping_threshold || 0);
    const subtotal  = cart.items.reduce((s, i) => s + i.price * i.quantity, 0);
    let   flatShip  = parseInt(settings.shipping_flat || 0);
    if (threshold > 0 && subtotal >= threshold) flatShip = 0; // free shipping over threshold

    // Build Stripe line items (images must be absolute URLs)
    const absImage = (u) => !u ? null : (u.startsWith('http') ? u : storeUrl.replace(/\/$/, '') + u);
    const lineItems = cart.items.map(item => {
      const img = absImage(item.image_url);
      return {
        price_data: {
          currency:     'usd',
          unit_amount:  item.price,   // already in cents
          product_data: {
            name:   item.name,
            ...(img && img.startsWith('https://') ? { images: [img] } : {}),
          },
        },
        quantity: item.quantity,
      };
    });

    // Shipping options
    const shippingOptions = flatShip === 0
      ? [{ shipping_rate_data: { type: 'fixed_amount', fixed_amount: { amount: 0, currency: 'usd' }, display_name: 'Free Shipping' } }]
      : [
          { shipping_rate_data: { type: 'fixed_amount', fixed_amount: { amount: flatShip, currency: 'usd' }, display_name: 'Standard Shipping' } },
          { shipping_rate_data: { type: 'fixed_amount', fixed_amount: { amount: 0, currency: 'usd' }, display_name: 'Free Pickup (at store)' } },
        ];

    const session = await stripe.checkout.sessions.create({
      mode:                  'payment',
      line_items:            lineItems,
      shipping_address_collection: { allowed_countries: ['US', 'CA', 'GB', 'AU', 'MX'] },
      shipping_options:      shippingOptions,
      ...(taxRate > 0 ? { automatic_tax: { enabled: true } } : {}),
      billing_address_collection: 'auto',
      phone_number_collection: { enabled: true },
      allow_promotion_codes: true,
      success_url: `${storeUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${storeUrl}/cart`,
      metadata: {
        cart_items: JSON.stringify(cart.items.map(i => ({
          product_id: i.product_id,
          name: i.name,
          price: i.price,
          quantity: i.quantity,
        }))),
      },
    });

    res.json({ url: session.url, session_id: session.id });

  } catch (err) {
    next(err);
  }
});

// ── POST /api/checkout/webhook ─────────────────────────────────────────────
// Stripe sends events here (raw body applied in server.js). Optional:
// orders are also fulfilled from the success page if no webhook is set up.
router.post('/webhook', async (req, res) => {
  const stripe = getStripe();
  const sig    = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    await fulfillOrder(event.data.object);
  }

  res.json({ received: true });
});

async function fulfillOrder(session) {
  try {
    // Check if already processed
    const existing = db.prepare('SELECT id FROM orders WHERE stripe_session = ?').get(session.id);
    if (existing) return;

    const cartItems = JSON.parse(session.metadata?.cart_items || '[]');
    if (!cartItems.length) return;

    const subtotal = cartItems.reduce((s, i) => s + i.price * i.quantity, 0);
    const shipping = session.total_details?.amount_shipping || 0;
    const tax      = session.total_details?.amount_tax      || 0;
    const total    = session.amount_total || (subtotal + shipping + tax);

    const address = session.shipping_details?.address;
    const shippingAddr = address
      ? `${address.line1}${address.line2 ? ', ' + address.line2 : ''}, ${address.city}, ${address.state} ${address.postal_code}, ${address.country}`
      : null;

    const orderNumber = db.helpers.generateOrderNumber();

    const insertOrder = db.prepare(`
      INSERT INTO orders
        (order_number, stripe_session, stripe_payment, status, customer_name, customer_email,
         customer_phone, shipping_address, subtotal, shipping, tax, total)
      VALUES (?, ?, ?, 'paid', ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = insertOrder.run(
      orderNumber,
      session.id,
      session.payment_intent,
      session.customer_details?.name  || 'Customer',
      session.customer_details?.email || '',
      session.customer_details?.phone || null,
      shippingAddr,
      subtotal, shipping, tax, total
    );

    const orderId = result.lastInsertRowid;

    // Insert order items & decrement stock
    const insertItem = db.prepare(`
      INSERT INTO order_items (order_id, product_id, name, price, quantity, subtotal)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const decrementStock = db.prepare(`
      UPDATE products SET stock = MAX(0, stock - ?) WHERE id = ?
    `);

    const insertAll = db.transaction(() => {
      for (const item of cartItems) {
        insertItem.run(orderId, item.product_id, item.name, item.price, item.quantity, item.price * item.quantity);
        if (item.product_id) decrementStock.run(item.quantity, item.product_id);
      }
    });
    insertAll();

    console.log(`✅ Order ${orderNumber} created for ${session.customer_details?.email}`);
  } catch (err) {
    console.error('Error fulfilling order:', err);
  }
}

// ── GET /api/checkout/order ─────────────────────────────────────────────────
// Called from success page to show order details
router.get('/order', async (req, res, next) => {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ error: 'session_id required' });

    // Try DB first
    let order = db.prepare(`
      SELECT o.*, GROUP_CONCAT(oi.name || ' x' || oi.quantity, ' | ') as items_summary
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE o.stripe_session = ?
      GROUP BY o.id
    `).get(session_id);

    if (order) {
      const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
      return res.json({
        order: {
          ...order,
          items,
          subtotal_formatted: `$${db.helpers.formatPrice(order.subtotal)}`,
          shipping_formatted: `$${db.helpers.formatPrice(order.shipping)}`,
          tax_formatted:      `$${db.helpers.formatPrice(order.tax)}`,
          total_formatted:    `$${db.helpers.formatPrice(order.total)}`,
        }
      });
    }

    // Fallback: fetch from Stripe (webhook may be delayed or not configured)
    const stripe  = getStripe();
    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ['line_items', 'payment_intent']
    });

    // Fulfill directly if paid — makes the webhook optional (fulfillOrder is idempotent)
    if (session.payment_status === 'paid') {
      await fulfillOrder(session);
      if (req.session) req.session.cart = { items: [] }; // clear server cart

      const fulfilled = db.prepare('SELECT * FROM orders WHERE stripe_session = ?').get(session.id);
      if (fulfilled) {
        const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(fulfilled.id);
        return res.json({
          order: {
            ...fulfilled,
            items,
            subtotal_formatted: `$${db.helpers.formatPrice(fulfilled.subtotal)}`,
            shipping_formatted: `$${db.helpers.formatPrice(fulfilled.shipping)}`,
            tax_formatted:      `$${db.helpers.formatPrice(fulfilled.tax)}`,
            total_formatted:    `$${db.helpers.formatPrice(fulfilled.total)}`,
          }
        });
      }
    }

    res.json({
      order: {
        order_number:       'Processing…',
        status:             session.payment_status === 'paid' ? 'paid' : 'pending',
        customer_name:      session.customer_details?.name  || '',
        customer_email:     session.customer_details?.email || '',
        total_formatted:    `$${db.helpers.formatPrice(session.amount_total || 0)}`,
        items: (session.line_items?.data || []).map(li => ({
          name:     li.description,
          quantity: li.quantity,
          price:    li.amount_total,
          subtotal: li.amount_total,
        }))
      }
    });

  } catch (err) {
    next(err);
  }
});

module.exports = router;
