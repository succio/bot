const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const authMiddleware = require('../middleware/authMiddleware');
const { users, scheduleSave } = require('../lib/store');
const { PACKAGES } = require('./payments-shared');
const router = express.Router();

function formatUsd(n) {
  const value = Number(n || 0);
  const isWhole = Number.isInteger(value);
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: isWhole ? 0 : 2,
    maximumFractionDigits: 2
  })}`;
}

function addUsdBalance(user, amount, label) {
  const current = Number(user.balanceUsd || 0);
  user.balanceUsd = Math.round((current + Number(amount || 0)) * 100) / 100;
  user.package = label;
}

function getOrCreateTelegramPaymentUser(telegramId) {
  const key = `tg:${telegramId}`;
  let user = users.get(key);
  if (!user) {
    user = {
      email: key,
      password: '',
      credits: 0,
      balanceUsd: 0,
      lastPurchase: null,
      package: null,
      telegramId,
      telegramName: null,
      createdAt: new Date().toISOString()
    };
    users.set(key, user);
    console.log(`IPN Telegram: created missing TG user ${telegramId} from payment callback.`);
  }
  return user;
}

function isPaymentComplete(status) {
  return ['finished', 'confirmed'].includes(String(status || '').toLowerCase());
}

function processedPaymentKey(payload) {
  return String(payload.payment_id || payload.invoice_id || payload.order_id || '').trim();
}

function hasProcessedPayment(user, key) {
  if (!key) return false;
  return Array.isArray(user.processedPaymentIds) && user.processedPaymentIds.includes(key);
}

function markPaymentProcessed(user, key) {
  if (!key) return;
  if (!Array.isArray(user.processedPaymentIds)) user.processedPaymentIds = [];
  if (!user.processedPaymentIds.includes(key)) {
    user.processedPaymentIds.push(key);
    user.processedPaymentIds = user.processedPaymentIds.slice(-100);
  }
}

router.get('/packages', (req, res) => {
  res.json({ packages: PACKAGES });
});

router.get('/currencies', async (req, res) => {
  try {
    const response = await axios.get('https://api.nowpayments.io/v1/currencies', {
      headers: { 'x-api-key': process.env.NOWPAYMENTS_API_KEY }
    });
    res.json(response.data);
  } catch (err) {
    console.error('Fetch currencies error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch currencies.' });
  }
});

router.post('/create-payment', authMiddleware, async (req, res) => {
  try {
    const { packageId, pay_currency } = req.body;
    if (!packageId || !PACKAGES[packageId]) {
      return res.status(400).json({ error: 'Valid package selection is required.' });
    }
    if (!pay_currency) {
      return res.status(400).json({ error: 'Payment currency is required.' });
    }
    const pkg = PACKAGES[packageId];
    const response = await axios.post(
      'https://api.nowpayments.io/v1/payment',
      {
        price_amount: pkg.price,
        price_currency: pkg.currency,
        pay_currency: pay_currency,
        order_id: `replicas_${packageId}_${req.user.email}_${Date.now()}`,
        order_description: `replicas.live ${pkg.name} - ${formatUsd(pkg.amount || pkg.price)} USD balance`,
        ipn_callback_url: `${req.protocol}://${req.get('host')}/api/payments/ipn`
      },
      { headers: { 'x-api-key': process.env.NOWPAYMENTS_API_KEY, 'Content-Type': 'application/json' } }
    );
    res.json({ message: 'Payment created successfully.', payment: response.data });
  } catch (err) {
    console.error('Create payment error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create payment.' });
  }
});

function verifyIpnSignature(rawBody, receivedSignature) {
  const secret = process.env.NOWPAYMENTS_IPN_SECRET;
  if (!secret) { console.error('NOWPAYMENTS_IPN_SECRET is not set.'); return false; }
  const payload = JSON.parse(rawBody);
  const filteredPayload = {};
  const sortedKeys = Object.keys(payload).filter(k => k !== 'signature').sort();
  for (const key of sortedKeys) filteredPayload[key] = payload[key];
  const hmac = crypto.createHmac('sha512', secret).update(JSON.stringify(filteredPayload)).digest('hex');
  return hmac === receivedSignature;
}

router.post('/ipn', (req, res) => {
  try {
    const signature = req.headers['x-nowpayments-sig'];
    if (!signature) {
      console.warn('IPN received without signature.');
      return res.status(400).json({ error: 'Missing signature.' });
    }
    const rawBody = req.body.toString('utf8');
    if (!verifyIpnSignature(rawBody, signature)) {
      console.warn('IPN signature verification failed.');
      return res.status(403).json({ error: 'Invalid signature.' });
    }
    const payload = JSON.parse(rawBody);
    console.log('IPN received:', JSON.stringify(payload));

    if (isPaymentComplete(payload.payment_status)) {
      const orderId = payload.order_id || '';

      // Telegram payment: tg-<telegramId>-<packageId>-<timestamp>
      if (orderId.startsWith('tg-')) {
        const tgParts = orderId.split('-');
        const telegramId = tgParts[1];
        const packageId = tgParts[2];
        const isCustomTopup = packageId === 'custom';
        const customAmount = isCustomTopup ? Number(tgParts[3] || 0) / 100 : null;
        const pkg = isCustomTopup
          ? { name: `Custom ${formatUsd(customAmount)} Balance Top Up`, price: customAmount, amount: customAmount }
          : PACKAGES[packageId];
        const user = getOrCreateTelegramPaymentUser(telegramId);
        console.log(`IPN Telegram: orderId=${orderId}, telegramId=${telegramId}, packageId=${packageId}, userFound=${!!user}, pkgFound=${!!pkg}`);
        if (user && pkg && Number(pkg.amount || pkg.price || 0) > 0) {
          const addAmount = Number(pkg.amount || pkg.price || 0);
          const paidAmount = Number(payload.price_amount || 0);
          const paymentKey = processedPaymentKey(payload);
          if (hasProcessedPayment(user, paymentKey)) {
            console.log(`IPN Telegram: payment already processed (${paymentKey}).`);
            return res.status(200).json({ message: 'IPN already processed.' });
          }
          if (paidAmount && paidAmount + 0.01 < addAmount) {
            console.warn(`IPN Telegram: Paid amount ${paidAmount} < expected ${addAmount}. TG: ${telegramId}`);
            return res.status(200).json({ message: 'IPN received, amount below expected.' });
          }
          addUsdBalance(user, addAmount, pkg.name);
          markPaymentProcessed(user, paymentKey);
          scheduleSave();
          console.log(`Added ${formatUsd(addAmount)} (${pkg.name}) to TG user ${telegramId}. Total: ${formatUsd(user.balanceUsd)}`);
          try {
            const { bot } = require('../bot/telegram');
            bot.telegram.sendMessage(
              telegramId,
              `✅ Payment confirmed!\n\n*${formatUsd(addAmount)} USD* has been added to your account.\n💰 Balance: *${formatUsd(user.balanceUsd)}*\n\nPress *📄 Generate Document* to get started!`,
              { parse_mode: 'Markdown' }
            ).catch(e => console.error('TG notify error:', e.message));
          } catch (e) {
            console.error('Could not notify TG user:', e.message);
          }
        } else {
          console.warn(`IPN Telegram: User or package not found. TG: ${telegramId}, Package: ${packageId}`);
        }
      } else {
        // Web app payment: replicas_<packageId>_<email>_<timestamp>
        const parts = orderId.split('_');
        if (parts.length >= 4 && (parts[0] === 'replicas' || parts[0] === 'restudio')) {
          const packageId = parts[1];
          const email = parts.slice(2, -1).join('_');
          const pkg = PACKAGES[packageId];
          const user = users.get(email.toLowerCase());
          if (user && pkg) {
            const paidAmount = parseFloat(payload.price_amount);
            const paymentKey = processedPaymentKey(payload);
            if (hasProcessedPayment(user, paymentKey)) {
              console.log(`IPN: payment already processed (${paymentKey}).`);
              return res.status(200).json({ message: 'IPN already processed.' });
            }
            if (paidAmount < pkg.price) {
              console.warn(`IPN: Paid amount ${paidAmount} < pkg price ${pkg.price}. Email: ${email}`);
            } else {
              const addAmount = Number(pkg.amount || pkg.price || 0);
              addUsdBalance(user, addAmount, pkg.name);
              markPaymentProcessed(user, paymentKey);
              scheduleSave();
              console.log(`Added ${formatUsd(addAmount)} (${pkg.name}) to ${email}. Total: ${formatUsd(user.balanceUsd)}`);
            }
          } else {
            console.warn(`IPN: User or package not found. Email: ${email}, Package: ${packageId}`);
          }
        }
      }
    }

    res.status(200).json({ message: 'IPN processed.' });
  } catch (err) {
    console.error('IPN processing error:', err.message);
    res.status(500).json({ error: 'IPN processing failed.' });
  }
});

module.exports = router;
