const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const authMiddleware = require('../middleware/authMiddleware');
const { users, scheduleSave } = require('../lib/store');
const { PACKAGES } = require('./payments-shared');
const router = express.Router();

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
        order_description: `replicas.live ${pkg.name} - ${pkg.credits} tokens`,
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

    if (payload.payment_status === 'finished') {
      const orderId = payload.order_id || '';

      // Telegram payment: tg-<telegramId>-<packageId>-<timestamp>
      if (orderId.startsWith('tg-')) {
        const tgParts = orderId.split('-');
        const telegramId = tgParts[1];
        const packageId = tgParts[2];
        const pkg = PACKAGES[packageId];
        const key = `tg:${telegramId}`;
        const user = users.get(key);
        console.log(`IPN Telegram: orderId=${orderId}, telegramId=${telegramId}, packageId=${packageId}, userFound=${!!user}, pkgFound=${!!pkg}`);
        if (user && pkg) {
          user.credits += pkg.credits;
          user.package = pkg.name;
          scheduleSave();
          console.log(`Added ${pkg.credits} credits (${pkg.name}) to TG user ${telegramId}. Total: ${user.credits}`);
          try {
            const { bot } = require('../bot/telegram');
            bot.telegram.sendMessage(
              telegramId,
              `✅ Payment confirmed!\n\n*${pkg.credits} credit(s)* have been added to your account.\n💰 New balance: *${user.credits} credits*\n\nPress *📄 Generate Document* to get started!`,
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
            if (paidAmount < pkg.price) {
              console.warn(`IPN: Paid amount ${paidAmount} < pkg price ${pkg.price}. Email: ${email}`);
            } else {
              user.credits += pkg.credits;
              user.package = pkg.name;
              scheduleSave();
              console.log(`Added ${pkg.credits} credits (${pkg.name}) to ${email}. Total: ${user.credits}`);
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
