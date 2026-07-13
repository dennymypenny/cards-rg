/**
 * server.js — Main Express application
 */

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

async function start() {
  // ── INIT DATABASE (must happen before routes handle requests) ───────────────
  const db = require('./db');
  await db.init();

  // ── MIDDLEWARE ──────────────────────────────────────────────────────────────

  // Raw body needed for Stripe webhook — must come BEFORE express.json()
  app.use('/api/checkout/webhook', express.raw({ type: 'application/json' }));

  // Trust Railway's reverse proxy so secure cookies work over HTTPS
  app.set('trust proxy', 1);

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
      }
    }
  }));

  // Session — using session-file-store (pure JS, no native compilation)
  const FileStore = require('session-file-store')(session);
  const sessionsDir = path.join(__dirname, 'data', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });

  app.use(session({
    store: new FileStore({
      path: sessionsDir,
      ttl: 7 * 24 * 60 * 60,  // 7 days in seconds
      retries: 1,
      logFn: () => {}          // suppress verbose file-store logs
    }),
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge:   7 * 24 * 60 * 60 * 1000, // 7 days in ms
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production'
    }
  }));

  // ── ROUTES ──────────────────────────────────────────────────────────────────

  app.use('/api/products',  require('./routes/products'));
  app.use('/api/cart',      require('./routes/cart'));
  app.use('/api/checkout',  require('./routes/checkout'));
  app.use('/api/orders',    require('./routes/orders'));
  app.use('/api/admin',     require('./routes/admin'));
  app.use('/api/notify',    require('./routes/notify').router);
  app.use('/api/offers',    require('./routes/offers'));
  app.use('/api/subscribe', require('./routes/subscribers'));

  // ── SPA FALLBACK ────────────────────────────────────────────────────────────

  // Denny's personal admin hub (before the wildcard so it isn't caught by it)
  app.get('/hub', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'hub.html'));
  });

  // Public shareable inventory list — send cardsrg.com/list to anyone
  app.get('/list', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'list.html'));
  });

  app.get('*', (req, res) => {
    if (req.path.startsWith('/admin')) {
      return res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // ── ERROR HANDLER ───────────────────────────────────────────────────────────

  app.use((err, req, res, next) => {
    console.error(err.stack);
    const status  = err.statusCode || 500;
    const message = process.env.NODE_ENV === 'production'
      ? 'Something went wrong'
      : err.message;
    res.status(status).json({ error: message });
  });

  // ── START ───────────────────────────────────────────────────────────────────

  app.listen(PORT, () => {
    console.log(`\n🛒  Store running at http://localhost:${PORT}`);
    console.log(`🔐  Admin dashboard: http://localhost:${PORT}/admin`);
    console.log(`\n📋  Admin email:    ${process.env.ADMIN_EMAIL || 'admin@yourstore.com'}`);
    console.log(`📋  Admin password: (see .env or default 'changeme123')\n`);
  });
}

start().catch(err => {
  console.error('❌ Failed to start server:', err);
  process.exit(1);
});

module.exports = app;
