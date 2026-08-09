require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const authMiddleware = require('./middleware/authMiddleware');
const authRoutes = require('./routes/auth');
const paymentRoutes = require('./routes/payments');
const creditRoutes = require('./routes/credits');
const generateRoutes = require('./routes/generate');

const REQUIRED_ENV = ['JWT_SECRET'];
const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

if (!process.env.NOWPAYMENTS_API_KEY) {
  console.warn('Warning: NOWPAYMENTS_API_KEY is not set. Invoice creation will fail.');
}
if (!process.env.NOWPAYMENTS_IPN_SECRET) {
  console.warn('Warning: NOWPAYMENTS_IPN_SECRET is not set. IPN verification will reject all webhooks.');
}

const app = express();
app.set('trust proxy', 1);
const PORT = parseInt(process.env.PORT, 10) || 5000;

if (!process.env.APP_URL) {
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN
    || process.env.REPLIT_DEV_DOMAIN
    || (process.env.REPLIT_DOMAINS || '').split(',')[0];
  process.env.APP_URL = domain ? `https://${domain}` : `http://localhost:${PORT}`;
}

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(cookieParser());
app.use('/api/payments/ipn', express.raw({ type: 'application/json' }));
app.use(express.json());

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-cache');
  }
}));

app.use('/api/auth', authRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/credits', creditRoutes);
app.use('/api/generate', generateRoutes);

app.get('/api/check-session', authMiddleware, (req, res) => {
  res.json({ authenticated: true, email: req.user.email });
});

let telegramBot = null;
let telegramWebhookPath = null;
if (process.env.TELEGRAM_BOT_TOKEN) {
  try {
    ({ bot: telegramBot } = require('./bot/telegram'));
    const webhookSecret = crypto
      .createHash('sha256')
      .update(process.env.TELEGRAM_BOT_TOKEN)
      .digest('hex')
      .slice(0, 32);
    telegramWebhookPath = process.env.TELEGRAM_WEBHOOK_PATH || `/telegram/webhook/${webhookSecret}`;
    app.use(telegramBot.webhookCallback(telegramWebhookPath));
  } catch (err) {
    console.error('Failed to load Telegram bot:', err.stack || err.message);
  }
}

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found.' });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error.' });
});

async function seedAdmin() {
  const email = (process.env.ADMIN_EMAIL || 'admin@restudio.com').toLowerCase();
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  const { getUser, createUser } = require('./routes/auth');
  const { scheduleSave } = require('./lib/store');
  if (getUser(email)) {
    console.log(`Admin account exists: ${email}`);
    return;
  }
  const salt = await bcrypt.genSalt(10);
  const hashed = await bcrypt.hash(password, salt);
  const user = createUser(email, hashed);
  user.credits = 100;
  user.package = 'Admin';
  scheduleSave();
  console.log(`Admin account created: ${email} (100 tokens)`);
}

async function seedUsers() {
  const { getUser, createUser } = require('./routes/auth');
  const { scheduleSave } = require('./lib/store');
  const preseeded = [
    { email: 'levelupceo25@icloud.com', password: 'KNSCeMDtPd9h', credits: 10, package: 'Starter' },
    { email: 'richardlamontagne9@outlook.com', password: '4KwcNDxRdM', credits: 1, package: 'Additional Document' },
    { email: 'avery683@gmail.com', password: 'thUuXmCywwmU', credits: 5, package: 'Starter' },
    { email: 'gennojenny75@gmail.com', password: 'HFg8L7dNYHuz', credits: 10, package: 'Pro' },
  ];
  for (const u of preseeded) {
    let user = getUser(u.email);
    if (!user) {
      const salt = await bcrypt.genSalt(10);
      const hashed = await bcrypt.hash(u.password, salt);
      user = createUser(u.email, hashed);
      console.log(`Seeded account created: ${u.email} (${u.credits} tokens, ${u.package})`);
    } else {
      console.log(`Seeded account updated: ${u.email} (${u.credits} tokens, ${u.package})`);
    }
    user.credits = u.credits;
    user.package = u.package;
  }
  scheduleSave();
}

async function seedTelegramUsers() {
  const { users, scheduleSave } = require('./lib/store');
  const tgSeeded = [
    { telegramId: '6873264932', credits: 20, package: 'Tester', name: 'Customer' },
  ];
  for (const u of tgSeeded) {
    const key = `tg:${u.telegramId}`;
    if (!users.has(key)) {
      users.set(key, {
        email: key,
        password: '',
        credits: u.credits,
        package: u.package,
        telegramId: u.telegramId,
        telegramName: u.name,
        createdAt: new Date().toISOString()
      });
      console.log(`Seeded Telegram user: ${u.telegramId} (${u.credits} credits)`);
    } else {
      const existing = users.get(key);
      existing.credits = u.credits;
      existing.package = u.package;
      console.log(`Seeded Telegram user: ${u.telegramId} (${u.credits} credits)`);
    }
  }
  scheduleSave();
}

async function startTelegramBot() {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.warn('Warning: TELEGRAM_BOT_TOKEN not set. Telegram bot will not start.');
    return;
  }
  if (!telegramBot) {
    console.error('Telegram bot did not load. Check the earlier startup error.');
    return;
  }

  const appUrl = process.env.APP_URL || '';
  const useWebhook = process.env.TELEGRAM_USE_LONG_POLLING !== 'true' && /^https:\/\//i.test(appUrl);

  try {
    if (useWebhook) {
      const webhookUrl = `${appUrl.replace(/\/+$/, '')}${telegramWebhookPath}`;
      await telegramBot.telegram.setWebhook(webhookUrl, { drop_pending_updates: false });
      const me = await telegramBot.telegram.getMe();
      console.log(`Telegram bot started with webhook: @${me.username}`);
      console.log(`Telegram webhook URL: ${webhookUrl}`);
      return;
    }

    await telegramBot.telegram.deleteWebhook({ drop_pending_updates: false });
    telegramBot.launch().catch(err => console.error('Bot polling error:', err.message));
    telegramBot.telegram.getMe()
      .then((me) => console.log(`Telegram bot started with polling: @${me.username}`))
      .catch(() => console.log('Telegram bot started with polling.'));
    process.once('SIGINT', () => telegramBot.stop('SIGINT'));
    process.once('SIGTERM', () => telegramBot.stop('SIGTERM'));
  } catch (err) {
    console.error('Failed to start Telegram bot:', err.stack || err.message);
  }
}

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`replicas.live server running on port ${PORT}`);
  await seedAdmin();
  await seedUsers();
  await seedTelegramUsers();
  console.log(`APP_URL set to: ${process.env.APP_URL}`);
  await startTelegramBot();
});
