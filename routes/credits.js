const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const { users, scheduleSave } = require('../lib/store');
const { DOCUMENT_PRICES } = require('./payments-shared');
const router = express.Router();

const noCache = (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
};

function getBalance(user) {
  if (user.balanceUsd === undefined || user.balanceUsd === null) {
    user.balanceUsd = Number(user.credits || 0) * DOCUMENT_PRICES.paystub;
  }
  return Number(user.balanceUsd || 0);
}

function setBalance(user, amount) {
  user.balanceUsd = Math.max(0, Math.round(Number(amount || 0) * 100) / 100);
}

router.get('/me', noCache, authMiddleware, (req, res) => {
  try {
    const user = users.get(req.user.email.toLowerCase());
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    res.json({
      email: user.email,
      credits: user.credits,
      balanceUsd: getBalance(user),
      package: user.package || null
    });
  } catch (err) {
    console.error('Get profile error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

router.post('/use-credit', authMiddleware, (req, res) => {
  try {
    const user = users.get(req.user.email.toLowerCase());

    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const amount = Number(req.body?.amount || DOCUMENT_PRICES.paystub);
    if (getBalance(user) < amount) {
      return res.status(403).json({ error: 'Insufficient balance.' });
    }

    setBalance(user, getBalance(user) - amount);
    scheduleSave();

    res.json({
      message: 'Balance used successfully.',
      remainingCredits: user.credits,
      remainingBalance: user.balanceUsd,
      balanceUsd: user.balanceUsd
    });
  } catch (err) {
    console.error('Use credit error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

router.post('/admin/set', noCache, (req, res) => {
  const { secret, email, credits, balanceUsd, pkg } = req.body;
  if (secret !== process.env.JWT_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const key = email.toLowerCase();
  const user = users.get(key);
  if (!user) {
    return res.status(404).json({ error: 'User not found: ' + key });
  }
  if (credits !== undefined) user.credits = Number(credits);
  if (balanceUsd !== undefined) user.balanceUsd = Number(balanceUsd);
  if (pkg !== undefined) user.package = pkg;
  scheduleSave();
  console.log(`Admin set: ${key} → $${getBalance(user)} balance, ${user.package}`);
  res.json({ email: user.email, credits: user.credits, balanceUsd: getBalance(user), package: user.package });
});

module.exports = router;
