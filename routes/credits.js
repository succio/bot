const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');
const { users, scheduleSave } = require('../lib/store');
const router = express.Router();

const noCache = (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
};

router.get('/me', noCache, authMiddleware, (req, res) => {
  try {
    const user = users.get(req.user.email.toLowerCase());
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    res.json({
      email: user.email,
      credits: user.credits,
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

    if (user.credits <= 0) {
      return res.status(403).json({ error: 'Insufficient credits.' });
    }

    user.credits -= 1;
    scheduleSave();

    res.json({
      message: 'Credit used successfully.',
      remainingCredits: user.credits
    });
  } catch (err) {
    console.error('Use credit error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

router.post('/admin/set', noCache, (req, res) => {
  const { secret, email, credits, pkg } = req.body;
  if (secret !== process.env.JWT_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const key = email.toLowerCase();
  const user = users.get(key);
  if (!user) {
    return res.status(404).json({ error: 'User not found: ' + key });
  }
  if (credits !== undefined) user.credits = Number(credits);
  if (pkg !== undefined) user.package = pkg;
  scheduleSave();
  console.log(`Admin set: ${key} → ${user.credits} credits, ${user.package}`);
  res.json({ email: user.email, credits: user.credits, package: user.package });
});

module.exports = router;
