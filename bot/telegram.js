const { Telegraf, Markup, session } = require('telegraf');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const path = require('path');
const { users, scheduleSave } = require('../lib/store');
const { JobQueue } = require('../lib/jobQueue');
const { generatePdf } = require('./pdf');
const { PACKAGES, DOCUMENT_PRICES, PRICE_LABELS } = require('../routes/payments-shared');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
bot.use(session());

const MIN_TOPUP_USD = 35;
const MAX_TOPUP_USD = 10000;
const TOPUP_CURRENCIES = [
  { label: 'BTC', value: 'btc' },
  { label: 'ETH', value: 'eth' },
  { label: 'USDT TRC20', value: 'usdttrc20' },
  { label: 'USDT ERC20', value: 'usdterc20' },
  { label: 'LTC', value: 'ltc' }
];

const generationQueue = new JobQueue({
  concurrency: parseInt(process.env.PDF_CONCURRENCY, 10) || 1,
  name: 'telegram-generation'
});

function initSession(ctx) {
  if (!ctx.session) ctx.session = {};
  return ctx.session;
}

function getOrCreateTgUser(ctx) {
  const telegramId = ctx.from.id;
  const key = `tg:${telegramId}`;
  let user = users.get(key);
  if (!user) {
    const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ');
    user = {
      email: key,
      password: '',
      credits: 0,
      balanceUsd: 0,
      lastPurchase: null,
      package: null,
      telegramId,
      telegramName: name,
      createdAt: new Date().toISOString()
    };
    users.set(key, user);
    scheduleSave();
  }
  return user;
}

function fmt(n) {
  return Number(n).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatUsd(n) {
  const value = Number(n || 0);
  const isWhole = Number.isInteger(value);
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: isWhole ? 0 : 2,
    maximumFractionDigits: 2
  })}`;
}

function getBalance(user) {
  if (user.balanceUsd === undefined || user.balanceUsd === null) {
    user.balanceUsd = Number(user.credits || 0) * DOCUMENT_PRICES.paystub;
  }
  return Number(user.balanceUsd || 0);
}

function setBalance(user, amount) {
  user.balanceUsd = Math.max(0, Math.round(Number(amount || 0) * 100) / 100);
}

function botAuthHeaders() {
  const token = jwt.sign(
    { email: 'telegram-bot@replicas.live', service: 'telegram' },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );
  return { Authorization: `Bearer ${token}` };
}

function spendBalance(user, amount, lastPurchase) {
  setBalance(user, getBalance(user) - amount);
  if (lastPurchase) user.lastPurchase = lastPurchase;
  scheduleSave();
}

function hasBalance(user, amount) {
  return getBalance(user) >= amount;
}

function notEnoughBalanceMessage(user, label, amount) {
  return `❌ Not enough balance. ${label} costs *${formatUsd(amount)}*. Your balance is *${formatUsd(getBalance(user))}*.`;
}

function topupCurrencyKeyboard() {
  return Markup.inlineKeyboard(TOPUP_CURRENCIES.map((currency) => [
    Markup.button.callback(currency.label, `paycur:${currency.value}`)
  ]));
}

function topupCurrencyLabel(value) {
  return TOPUP_CURRENCIES.find((currency) => currency.value === value)?.label || String(value || '').toUpperCase();
}

function getPublicAppUrl() {
  const url = process.env.APP_URL || process.env.RENDER_BASE_URL || (
    process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : ''
  );
  const clean = String(url || '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(clean)) {
    throw new Error('APP_URL is not set to a public HTTP(S) URL. Payment IPN callbacks cannot be created.');
  }
  return clean;
}

function setPendingTopup(ctx, data) {
  const user = getOrCreateTgUser(ctx);
  user.pendingTopup = {
    amount: Math.round(Number(data.amount || 0) * 100) / 100,
    packageId: data.packageId || null,
    label: data.label || null,
    createdAt: new Date().toISOString()
  };
  scheduleSave();

  const sess = initSession(ctx);
  sess.flow = 'topup_currency';
  sess.step = 'currency';
  sess.data = { ...user.pendingTopup };
}

function getPendingTopup(ctx) {
  const sess = initSession(ctx);
  if (sess.flow === 'topup_currency' && sess.data?.amount) return sess.data;

  const user = getOrCreateTgUser(ctx);
  if (user.pendingTopup?.amount) {
    sess.flow = 'topup_currency';
    sess.step = 'currency';
    sess.data = { ...user.pendingTopup };
    return sess.data;
  }

  return null;
}

function clearPendingTopup(ctx) {
  const sess = initSession(ctx);
  sess.flow = null;
  sess.step = null;
  sess.data = {};

  const user = getOrCreateTgUser(ctx);
  if (user.pendingTopup) {
    delete user.pendingTopup;
    scheduleSave();
  }
}

async function createTopupPayment(ctx, amount, payCurrency, packageId = null, label = null) {
  const cents = Math.round(Number(amount) * 100);
  const orderId = packageId
    ? `tg-${ctx.from.id}-${packageId}-${Date.now()}`
    : `tg-${ctx.from.id}-custom-${cents}-${Date.now()}`;
  const appUrl = getPublicAppUrl();

  const response = await axios.post(
    'https://api.nowpayments.io/v1/payment',
    {
      price_amount: amount,
      price_currency: 'usd',
      pay_currency: payCurrency,
      order_id: orderId,
      order_description: `${label || 'Custom Balance Top Up'} for Telegram user ${ctx.from.id}`,
      ipn_callback_url: `${appUrl}/api/payments/ipn`
    },
    { headers: { 'x-api-key': process.env.NOWPAYMENTS_API_KEY, 'Content-Type': 'application/json' } }
  );

  return response.data;
}

function formatTopupPaymentText(payment, amount, payCurrency) {
  const address = payment.pay_address || payment.payin_address || payment.address;
  const payAmount = payment.pay_amount || payment.amount;
  const paymentId = payment.payment_id || payment.id || 'pending';
  if (!address || !payAmount) throw new Error('NOWPayments response did not include payment address or amount.');

  return {
    address,
    text:
      `💳 *Payment Request Created*\n\n` +
      `Top up amount: *${formatUsd(amount)} USD*\n` +
      `Send exactly: \`${payAmount}\` ${topupCurrencyLabel(payCurrency)}\n\n` +
      `Wallet address:\n\`${address}\`\n\n` +
      `Payment ID: \`${paymentId}\`\n\n` +
      `Your balance updates automatically after the payment is confirmed.`
  };
}

async function sendTopupPayment(ctx, payment, amount, payCurrency) {
  const { address, text } = formatTopupPaymentText(payment, amount, payCurrency);
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=640x640&data=${encodeURIComponent(address)}`;

  try {
    await ctx.replyWithPhoto(
      qrUrl,
      {
        caption: text,
        parse_mode: 'Markdown',
        ...mainMenu()
      }
    );
  } catch (err) {
    console.error('Top-up QR send error:', err.message);
    await ctx.reply(
      `${text}\n\nQR image could not be sent, but the wallet address above is valid.`,
      {
        parse_mode: 'Markdown',
        ...mainMenu()
      }
    );
  }
}

function bankId(bankName) {
  const map = { TD: 'td', BMO: 'bmo', Simplii: 'simplii', Scotiabank: 'scotia', CIBC: 'cibc', RBC: 'rbc' };
  return map[bankName] || String(bankName || '').toLowerCase();
}

function bankStatementDocType(bankName) {
  const map = { TD: 'statement', BMO: 'bmoStatement', Simplii: 'simpliiStatement', Scotiabank: 'scotiaStatement', CIBC: 'cibcStatement', RBC: 'rbcStatement' };
  return map[bankName] || 'statement';
}

function mainMenu() {
  return Markup.keyboard([
    ['📄 Generate Document', '💳 Add Balance'],
    ['📂 Samples', '👤 My Account'],
    ['❓ Help']
  ]).resize();
}

function queueGeneration(ctx, sess, jobName, worker) {
  const position = generationQueue.size + generationQueue.running + 1;
  const queuedAt = Date.now();
  const data = JSON.parse(JSON.stringify(sess.data || {}));
  sess.flow = null;
  sess.step = null;
  sess.data = {};

  ctx.reply(
    position > 1
      ? `Queued ${jobName}. Position: ${position}. I'll send it here when it is ready.`
      : `Queued ${jobName}. I'll send it here when it is ready.`,
    mainMenu()
  ).catch((err) => console.error('Queue notice error:', err.message));

  console.log(`[generation-queue] queued "${jobName}" position=${position} running=${generationQueue.running} pending=${generationQueue.size}`);

  generationQueue.add(async () => {
    const startedAt = Date.now();
    console.log(`[generation-queue] started "${jobName}" waitMs=${startedAt - queuedAt} running=${generationQueue.running} pending=${generationQueue.size}`);
    try {
      return await worker(data);
    } finally {
      console.log(`[generation-queue] finished "${jobName}" runMs=${Date.now() - startedAt}`);
    }
  })
    .catch((err) => {
      console.error(`${jobName} queued job error:`, err.stack || err.message);
      return ctx.reply('⚠️ Generation failed. Please try again.', mainMenu()).catch(() => {});
    });
}

function parseIsoDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T12:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addDays(dateText, days) {
  const date = parseIsoDate(dateText);
  if (!date) return dateText;
  date.setDate(date.getDate() + days);
  return date.toISOString().split('T')[0];
}

function monthsInclusive(startDateText, endDateText) {
  const start = parseIsoDate(startDateText);
  const end = parseIsoDate(endDateText);
  if (!start || !end || end < start) return null;
  return (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) + 1;
}

function provinceFromAddress(address, fallback = 'ON') {
  const match = String(address || '').toUpperCase().match(/\b(AB|BC|ON|QC|SK|MB|NS|NB|NL|PE)\b/);
  return match ? match[1] : fallback;
}

function transactionAreaFromAddress(address) {
  const upper = String(address || '').toUpperCase();
  const knownAreas = [
    'TORONTO', 'CALGARY', 'OTTAWA', 'NEPEAN', 'VANCOUVER', 'BURNABY',
    'EDMONTON', 'MONTREAL', 'LAVAL', 'WINNIPEG', 'REGINA', 'SASKATOON',
    'HALIFAX', 'MONCTON', 'FREDERICTON', 'CHARLOTTETOWN', 'ST JOHNS'
  ];
  const found = knownAreas.find((area) => upper.includes(area));
  if (found) return found;

  const match = upper.match(/\b([A-Z][A-Z .'-]+?)\s+(AB|BC|ON|QC|SK|MB|NS|NB|NL|PE)\b/);
  return match ? match[1].trim().replace(/\s+/g, ' ') : '';
}

function statementPayrollDescription(employer) {
  const clean = String(employer || 'EMPLOYER')
    .toUpperCase()
    .replace(/[^A-Z0-9& .'-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${clean || 'EMPLOYER'} PAYROLL DEPOSIT`;
}

function maskSinLast4(last4) {
  const digits = String(last4 || '').replace(/\D/g, '').slice(-4).padStart(4, '0');
  return `XXX XX${digits[0]} ${digits.slice(1)}`;
}

function normalizeSin(text) {
  const digits = String(text || '').replace(/\D/g, '');
  if (digits.length === 9) return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
  return String(text || '').trim();
}

function noaLocationFromAddress(address) {
  const lines = String(address || '')
    .split(/\n|,/)
    .map((line) => line.trim())
    .filter(Boolean);
  return (lines[lines.length - 1] || '').toUpperCase();
}

function formatCanadianPostalCode(text) {
  return String(text || '')
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/^([ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z])(\d[ABCEGHJ-NPRSTV-Z]\d)$/, '$1 $2');
}

function formatNoaAddress(address) {
  const raw = String(address || '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const joined = (raw.length ? raw.join(', ') : String(address || ''))
    .toUpperCase()
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();

  const postalMatch = joined.match(/\b([ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z])\s*(\d[ABCEGHJ-NPRSTV-Z]\d)\b/);
  if (!postalMatch) return joined.replace(/, /g, '\n');

  const postal = formatCanadianPostalCode(`${postalMatch[1]}${postalMatch[2]}`);
  const beforePostal = joined.slice(0, postalMatch.index).replace(/[,\s]+$/g, '').trim();
  const provinceMatch = beforePostal.match(/\b(AB|BC|ON|QC|SK|MB|NS|NB|NL|PE|NT|NU|YT)\b\s*$/);
  if (!provinceMatch) return joined.replace(postalMatch[0], postal).replace(/, /g, '\n');

  const province = provinceMatch[1];
  const beforeProvince = beforePostal.slice(0, provinceMatch.index).replace(/[,\s]+$/g, '').trim();
  let street = '';
  let city = '';

  const commaParts = beforeProvince.split(',').map((part) => part.trim()).filter(Boolean);
  if (commaParts.length >= 2) {
    city = commaParts.pop();
    street = commaParts.join(' ');
  } else if (raw.length >= 2) {
    const lastLine = raw[raw.length - 1].toUpperCase();
    city = lastLine
      .replace(new RegExp(`\\b${province}\\b.*$`), '')
      .trim();
    street = raw.slice(0, -1).join(' ').toUpperCase().replace(/\s+/g, ' ').trim();
  } else {
    const suffixPattern = /\b(STREET|ST|AVENUE|AVE|ROAD|RD|DRIVE|DR|CRESCENT|CRES|COURT|CRT|CT|LANE|LN|BOULEVARD|BLVD|WAY|PLACE|PL|TERRACE|TER|TRAIL|TRL|CIRCLE|CIR|PARKWAY|PKWY)\b\.?/g;
    let match;
    let lastSuffix = null;
    while ((match = suffixPattern.exec(beforeProvince)) !== null) lastSuffix = match;
    if (lastSuffix) {
      const cut = lastSuffix.index + lastSuffix[0].length;
      street = beforeProvince.slice(0, cut).trim();
      city = beforeProvince.slice(cut).trim();
    }
  }

  if (!street || !city) {
    const parts = beforeProvince.split(/\s+/);
    city = parts.slice(-1).join(' ');
    street = parts.slice(0, -1).join(' ');
  }

  return [
    street.replace(/\s+/g, ' ').trim(),
    `${city.replace(/\s+/g, ' ').trim()} ${province} ${postal}`
  ].filter(Boolean).join('\n');
}

function formatStatementAddress(address, options = {}) {
  let value = String(address || '');
  if (options.dropLeadingCode) value = value.replace(/^\s*\d{3,6}\s*(?:\r?\n|,)\s*/, '');
  return formatNoaAddress(value)
    .toUpperCase()
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

function randomDigits(length) {
  let value = '';
  for (let i = 0; i < length; i += 1) value += Math.floor(Math.random() * 10);
  return value;
}

function randomT4EmployerAccount() {
  return `${randomDigits(9)}RP${randomDigits(4)}`;
}

function randomT4EmploymentCode() {
  return String(Math.floor(10 + Math.random() * 90));
}

function formatT4EmployeeName(firstName, lastName) {
  return [lastName, firstName]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ')
    .toUpperCase();
}

const STATEMENT_BANKS = ['TD', 'BMO', 'Simplii', 'Scotiabank', 'CIBC', 'RBC'];
const VOID_BANKS = ['TD', 'BMO', 'Scotiabank', 'CIBC', 'RBC'];
const STATEMENT_MAX_ROWS = {
  td: 50,
  bmo: 25,
  simplii: 21,
  scotia: 34,
  cibc: 30,
  rbc: 40
};
const PAYSTUB_STYLES = {
  'Style 1: classic-blue': 'classic-blue',
  'Style 2: northern-mint': 'northern-mint',
  'Style 3: prairie-sand': 'prairie-sand',
};
const PROVINCES = ['AB', 'BC', 'ON', 'QC', 'SK', 'MB', 'NS', 'NB', 'NL', 'PE'];
const SAMPLES = {
  bmoStatement: {
    label: 'BMO Statement',
    category: 'bank',
    filename: 'BMO_Statement_Sample.pdf',
    path: path.join(__dirname, 'samples', 'bmo-statement.pdf')
  },
  cibcStatement: {
    label: 'CIBC Statement',
    category: 'bank',
    filename: 'CIBC_Statement_Sample.pdf',
    path: path.join(__dirname, 'samples', 'cibc-statement.pdf')
  },
  rbcStatement: {
    label: 'RBC Statement',
    category: 'bank',
    filename: 'RBC_Statement_Sample.pdf',
    path: path.join(__dirname, 'samples', 'rbc-statement.pdf')
  },
  scotiaStatement: {
    label: 'Scotia Statement',
    category: 'bank',
    filename: 'Scotia_Statement_Sample.pdf',
    path: path.join(__dirname, 'samples', 'scotia-statement.pdf')
  },
  simpliiStatement: {
    label: 'Simplii Statement',
    category: 'bank',
    filename: 'Simplii_Statement_Sample.pdf',
    path: path.join(__dirname, 'samples', 'simplii-statement.pdf')
  },
  tdStatement: {
    label: 'TD Statement',
    category: 'bank',
    filename: 'TD_Statement_Sample.pdf',
    path: path.join(__dirname, 'samples', 'td-statement.pdf')
  },
  bmoVoidCheque: {
    label: 'BMO Void Cheque',
    category: 'void',
    filename: 'BMO_VoidCheque_Sample.pdf',
    path: path.join(__dirname, 'samples', 'bmo-void-cheque.pdf')
  },
  cibcVoidCheque: {
    label: 'CIBC Void Cheque',
    category: 'void',
    filename: 'CIBC_VoidCheque_Sample.pdf',
    path: path.join(__dirname, 'samples', 'cibc-void-cheque.pdf')
  },
  scotiaVoidCheque: {
    label: 'Scotia Void Cheque',
    category: 'void',
    filename: 'Scotia_VoidCheque_Sample.pdf',
    path: path.join(__dirname, 'samples', 'scotia-void-cheque.pdf')
  },
  tdVoidCheque: {
    label: 'TD Void Cheque',
    category: 'void',
    filename: 'TD_VoidCheque_Sample.pdf',
    path: path.join(__dirname, 'samples', 'td-void-cheque.pdf')
  },
  noa2025: {
    label: 'NOA 2025',
    category: 'noa',
    filename: 'NOA_2025_Sample.pdf',
    path: path.join(__dirname, 'samples', 'noa-2025.pdf')
  },
  paystubStyle1: {
    label: 'Paystub Style 1',
    category: 'paystub',
    filename: 'Paystub_Style_1_Sample.pdf',
    path: path.join(__dirname, 'samples', 'paystub-style-1.pdf')
  },
  paystubStyle2: {
    label: 'Paystub Style 2',
    category: 'paystub',
    filename: 'Paystub_Style_2_Sample.pdf',
    path: path.join(__dirname, 'samples', 'paystub-style-2.pdf')
  },
  paystubStyle3: {
    label: 'Paystub Style 3',
    category: 'paystub',
    filename: 'Paystub_Style_3_Sample.pdf',
    path: path.join(__dirname, 'samples', 'paystub-style-3.pdf')
  },
  t42025: {
    label: 'T4 2025',
    category: 't4',
    filename: 'T4_2025_Sample.pdf',
    path: path.join(__dirname, 'samples', 't4-2025.pdf')
  }
};

const SAMPLE_CATEGORIES = {
  bank: { label: 'Bank Statement', icon: '🏦' },
  paystub: { label: 'Paystub', icon: '💼' },
  t4: { label: 'T4 Slip', icon: '📑' },
  noa: { label: 'NOA', icon: '📋' },
  void: { label: 'Void Cheque', icon: '🔲' }
};

function sampleCategoryKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🏦 Bank Statement', 'samplecat:bank')],
    [Markup.button.callback('💼 Paystub', 'samplecat:paystub')],
    [Markup.button.callback('📑 T4 Slip', 'samplecat:t4')],
    [Markup.button.callback('📋 NOA', 'samplecat:noa')],
    [Markup.button.callback('🔲 Void Cheque', 'samplecat:void')]
  ]);
}

function samplesKeyboard(category) {
  const rows = Object.entries(SAMPLES)
    .filter(([, sample]) => sample.category === category)
    .map(([key, sample]) => [Markup.button.callback(sample.label, `sample:${key}`)]);

  rows.push([Markup.button.callback('Back to sample types', 'samplecat:root')]);
  return Markup.inlineKeyboard(rows);
}

function statementMaxRows(bankName) {
  return STATEMENT_MAX_ROWS[bankId(bankName)] || 50;
}

// ─── /start ───────────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  const user = getOrCreateTgUser(ctx);
  const name = ctx.from.first_name || 'there';
  await ctx.reply(
    `👋 Welcome *${name}*, this is Succio's bot\n\n` +
    `I generate Canadian financial documents — bank statements, paystubs, NOA, T4 slips, void cheques — and send the PDF right here.\n\n` +
    `Your balance is *${formatUsd(getBalance(user))}*.\n\n` +
    `contact support: @succiov3\n\n` +
    `Use the menu below to get started:`,
    {
      parse_mode: 'Markdown',
      ...mainMenu()
    }
  );
});

// ─── /account & My Account ────────────────────────────────────────────────────
bot.hears(['👤 My Account', '/account'], async (ctx) => {
  const user = getOrCreateTgUser(ctx);
  await ctx.reply(
    `*Your Account*\n\n` +
    `🆔 ID: \`${ctx.from.id}\`\n` +
    `💰 Balance: *${formatUsd(getBalance(user))}*\n` +
    `🧾 Last Purchase: ${user.lastPurchase || 'None'}`,
    { parse_mode: 'Markdown' }
  );
});

// ─── Samples ─────────────────────────────────────────────────────────────────
bot.hears(['📂 Samples', '/samples'], async (ctx) => {
  await ctx.reply(
    `Choose a sample type:`,
    sampleCategoryKeyboard()
  );
});

bot.action(/^samplecat:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const category = ctx.match[1];
  if (category === 'root') {
    return ctx.reply('Choose a sample type:', sampleCategoryKeyboard());
  }

  const meta = SAMPLE_CATEGORIES[category];
  if (!meta) return ctx.reply('Sample type not found.', sampleCategoryKeyboard());

  const hasSamples = Object.values(SAMPLES).some((sample) => sample.category === category);
  if (!hasSamples) {
    return ctx.reply(
      `${meta.icon} ${meta.label} samples are coming soon.`,
      samplesKeyboard(category)
    );
  }

  return ctx.reply(`Choose a ${meta.label} sample:`, samplesKeyboard(category));
});

bot.action(/^sample:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const sample = SAMPLES[ctx.match[1]];
  if (!sample) return ctx.reply('Sample not found.', mainMenu());

  try {
    await ctx.replyWithDocument(
      { source: sample.path, filename: sample.filename },
      { caption: sample.label, ...mainMenu() }
    );
  } catch (err) {
    console.error('Sample send error:', err.message);
    await ctx.reply('⚠️ Could not send that sample. Please try again.', mainMenu());
  }
});

// ─── Help ─────────────────────────────────────────────────────────────────────
bot.hears(['❓ Help', '/help'], async (ctx) => {
  await ctx.reply(
    `*How it works:*\n\n` +
    `1️⃣ Add USD balance to your account\n` +
    `2️⃣ Press *Generate Document*\n` +
    `3️⃣ Answer the questions\n` +
    `4️⃣ Receive your PDF in Telegram\n\n` +
    `*Document types:*\n` +
    `🏦 Bank Statement (TD, BMO, Simplii, Scotiabank, CIBC, RBC)\n` +
    `💼 Paystub (payroll statement)\n` +
    `📋 NOA (Notice of Assessment)\n` +
    `📑 T4 Slip\n` +
    `🔲 Void Cheque\n\n` +
    `*Pricing:*\n` +
    `• ${PRICE_LABELS.bank} — ${formatUsd(DOCUMENT_PRICES.bank)}\n` +
    `• ${PRICE_LABELS.paystub} — ${formatUsd(DOCUMENT_PRICES.paystub)}\n` +
    `• ${PRICE_LABELS.t4} — ${formatUsd(DOCUMENT_PRICES.t4)}\n` +
    `• ${PRICE_LABELS.noa} — ${formatUsd(DOCUMENT_PRICES.noa)}\n` +
    `• ${PRICE_LABELS.void} — ${formatUsd(DOCUMENT_PRICES.void)}\n\n` +
    `Contact Support: @succiov3`,
    { parse_mode: 'Markdown' }
  );
});

// ─── Add Balance ─────────────────────────────────────────────────────────────
bot.hears(['💳 Add Balance', '💳 Buy Credits', '/buy'], async (ctx) => {
  await ctx.reply(
    `*Choose an amount to add:*`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('Add $40 USD', 'buy:balance40')],
        [Markup.button.callback('Add $100 USD', 'buy:balance100')],
        [Markup.button.callback('Add $200 USD', 'buy:balance200')],
        [Markup.button.callback('Add $400 USD', 'buy:balance400')],
        [Markup.button.callback('Custom amount', 'buy:custom')],
      ])
    }
  );
});

bot.action(/^buy:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const packageId = ctx.match[1];
  if (packageId === 'custom') {
    const sess = initSession(ctx);
    sess.flow = 'topup';
    sess.step = 'amount';
    return ctx.reply(
      `Enter the amount you want to top up in USD (e.g 300)\n\nMinimum amount: ${formatUsd(MIN_TOPUP_USD)}\nMaximum amount: ${formatUsd(MAX_TOPUP_USD)}`,
      Markup.keyboard([['❌ Cancel']]).resize()
    );
  }

  const pkg = PACKAGES[packageId];
  if (!pkg) return ctx.reply('Unknown package.');

  setPendingTopup(ctx, {
    amount: Number(pkg.amount || pkg.price),
    packageId,
    label: pkg.name
  });
  const pending = getPendingTopup(ctx);

  return ctx.reply(
    `Choose payment currency for *${formatUsd(pending.amount)} USD*:`,
    { parse_mode: 'Markdown', ...topupCurrencyKeyboard() }
  );
});

bot.action(/^paycur:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const pending = getPendingTopup(ctx);
  if (!pending?.amount) {
    return ctx.reply('Please press Add Balance and choose an amount first.', mainMenu());
  }

  const payCurrency = ctx.match[1];
  const allowed = TOPUP_CURRENCIES.some((currency) => currency.value === payCurrency);
  if (!allowed) return ctx.reply('Please choose one of the listed payment currencies.');

  const { amount, packageId, label } = pending;

  try {
    const payment = await createTopupPayment(ctx, amount, payCurrency, packageId, label);
    await sendTopupPayment(ctx, payment, amount, payCurrency);
    clearPendingTopup(ctx);
    return;
  } catch (err) {
    console.error('Bot direct payment error:', err.response?.data || err.message);
    return ctx.reply('⚠️ Could not create payment details. Please try again later.', mainMenu());
  }
});

// ─── Generate Document ────────────────────────────────────────────────────────
bot.hears(['📄 Generate Document', '/generate'], async (ctx) => {
  const user = getOrCreateTgUser(ctx);
  if (getBalance(user) < Math.min(...Object.values(DOCUMENT_PRICES))) {
    return ctx.reply(
      `❌ Your balance is *${formatUsd(getBalance(user))}*. Press *Add Balance* before generating.`,
      { parse_mode: 'Markdown' }
    );
  }
  const sess = initSession(ctx);
  sess.flow = 'generate';
  sess.step = 'doctype';
  sess.data = {};

  await ctx.reply(
    `What type of document do you need?`,
    Markup.keyboard([
      [`🏦 Bank Statement - ${formatUsd(DOCUMENT_PRICES.bank)}`, `📋 NOA - ${formatUsd(DOCUMENT_PRICES.noa)}`],
      [`📑 T4 Slip - ${formatUsd(DOCUMENT_PRICES.t4)}`, `🔲 Void Cheque - ${formatUsd(DOCUMENT_PRICES.void)}`],
      [`💼 Paystub - ${formatUsd(DOCUMENT_PRICES.paystub)}`],
      ['❌ Cancel']
    ]).resize()
  );
});

bot.hears('❌ Cancel', async (ctx) => {
  const sess = initSession(ctx);
  sess.flow = null;
  sess.step = null;
  sess.data = {};
  const user = getOrCreateTgUser(ctx);
  if (user.pendingTopup) {
    delete user.pendingTopup;
    scheduleSave();
  }
  await ctx.reply('Cancelled.', mainMenu());
});

// ─── Conversation handler ─────────────────────────────────────────────────────
bot.on('text', async (ctx) => {
  const sess = initSession(ctx);
  const text = ctx.message.text.trim();

  if (text === '❌ Cancel') {
    sess.flow = null;
    sess.step = null;
    sess.data = {};
    const user = getOrCreateTgUser(ctx);
    if (user.pendingTopup) {
      delete user.pendingTopup;
      scheduleSave();
    }
    return ctx.reply('Cancelled.', mainMenu());
  }

  if (sess.flow === 'topup') {
    const amount = parseFloat(text.replace(/[^0-9.]/g, ''));
    if (isNaN(amount)) return ctx.reply('Please enter a valid USD amount (e.g 300):');
    if (amount < MIN_TOPUP_USD) return ctx.reply(`Minimum amount is ${formatUsd(MIN_TOPUP_USD)}. Enter a higher amount:`);
    if (amount > MAX_TOPUP_USD) return ctx.reply(`Maximum amount is ${formatUsd(MAX_TOPUP_USD)}. Enter a lower amount:`);

    setPendingTopup(ctx, {
      amount,
      packageId: null,
      label: `Custom ${formatUsd(amount)} Balance Top Up`
    });

    return ctx.reply(
      `Choose payment currency for *${formatUsd(amount)} USD*:`,
      { parse_mode: 'Markdown', ...topupCurrencyKeyboard() }
    );
  }

  if (sess.flow !== 'generate') return;

  const d = sess.data;

  // Step: doc type
  if (sess.step === 'doctype') {
    const map = {
      '🏦 Bank Statement': 'bank',
      [`🏦 Bank Statement - ${formatUsd(DOCUMENT_PRICES.bank)}`]: 'bank',
      '📋 NOA': 'noa',
      [`📋 NOA - ${formatUsd(DOCUMENT_PRICES.noa)}`]: 'noa',
      '📑 T4 Slip': 't4',
      [`📑 T4 Slip - ${formatUsd(DOCUMENT_PRICES.t4)}`]: 't4',
      '🔲 Void Cheque': 'void',
      [`🔲 Void Cheque - ${formatUsd(DOCUMENT_PRICES.void)}`]: 'void',
      '💼 Paystub': 'paystub',
      [`💼 Paystub - ${formatUsd(DOCUMENT_PRICES.paystub)}`]: 'paystub'
    };
    if (!map[text]) return ctx.reply('Please choose a document type from the menu.');
    d.docType = map[text];

    if (d.docType === 'paystub') {
      sess.step = 'paystub_name';
      return ctx.reply('Employee full name:', Markup.keyboard([['❌ Cancel']]).resize());
    }

    if (d.docType === 'bank') {
      sess.step = 'bank_name';
      return ctx.reply('Which bank?', Markup.keyboard([...STATEMENT_BANKS.map(b => [b]), ['❌ Cancel']]).resize());
    }
    if (d.docType === 'void') {
      sess.step = 'void_bank';
      return ctx.reply('Which bank for the void cheque?', Markup.keyboard([...VOID_BANKS.map(b => [b]), ['❌ Cancel']]).resize());
    }
    if (d.docType === 'noa') {
      sess.step = 'noa_name';
      return ctx.reply('Holder name:', Markup.keyboard([['❌ Cancel']]).resize());
    }
    if (d.docType === 't4') {
      sess.step = 't4_first_name';
      return ctx.reply('First name:', Markup.keyboard([['❌ Cancel']]).resize());
    }
  }

  // ── Bank Statement flow ──
  if (d.docType === 'bank') {
    if (sess.step === 'bank_name') {
      if (!STATEMENT_BANKS.includes(text)) return ctx.reply('Please choose a bank from the menu.');
      d.bank = text;
      sess.step = 'bank_acct_name';
      return ctx.reply('Account holder name:', Markup.keyboard([['❌ Cancel']]).resize());
    }
    if (sess.step === 'bank_acct_name') {
      d.acctName = text;
      sess.step = 'bank_address';
      return ctx.reply('Account holder address:');
    }
    if (sess.step === 'bank_address') {
      d.address = text;
      sess.step = 'bank_acct_number';
      return ctx.reply('Account no:');
    }
    if (sess.step === 'bank_acct_number') {
      d.acctNumber = text;
      sess.step = 'bank_branch_number';
      return ctx.reply('Branch no:');
    }
    if (sess.step === 'bank_branch_number') {
      d.branchNumber = text;
      sess.step = 'bank_branch_address';
      return ctx.reply('Branch address (street, city/province/postal - no branch number):');
    }
    if (sess.step === 'bank_branch_address') {
      d.branchAddress = text;
      sess.step = 'bank_start_date';
      return ctx.reply('Start Date (YYYY-MM-DD):');
    }
    if (sess.step === 'bank_start_date') {
      if (!parseIsoDate(text)) return ctx.reply('Please use YYYY-MM-DD format (e.g. 2025-01-01):');
      d.startDate = text;
      sess.step = 'bank_end_date';
      return ctx.reply('End Date (YYYY-MM-DD):');
    }
    if (sess.step === 'bank_end_date') {
      if (!parseIsoDate(text)) return ctx.reply('Please use YYYY-MM-DD format (e.g. 2025-01-31):');
      const months = monthsInclusive(d.startDate, text);
      if (!months) return ctx.reply('End Date must be after Start Date.');
      if (months > 6) return ctx.reply('Please keep statement packages to 6 months or less.');
      d.endDate = text;
      d.months = months;
      d.year = parseIsoDate(d.startDate).getFullYear();
      d.month = parseIsoDate(d.startDate).getMonth() + 1;
      sess.step = 'bank_opening_balance';
      return ctx.reply('Opening balance amount (e.g. 5000):');
    }
    if (sess.step === 'bank_opening_balance') {
      const val = parseFloat(text.replace(/[^0-9.]/g, ''));
      if (isNaN(val) || val < 0) return ctx.reply('Please enter a valid opening balance amount (e.g. 5000):');
      d.openingBalance = Math.round(val * 100) / 100;
      sess.step = 'bank_income_frequency';
      return ctx.reply('Income deposit frequency:', Markup.keyboard([
        ['Biweekly', 'Monthly'],
        ['❌ Cancel']
      ]).resize());
    }
    if (sess.step === 'bank_income_frequency') {
      if (!['Biweekly', 'Monthly'].includes(text)) return ctx.reply('Please choose Biweekly or Monthly.');
      d.incomeFrequency = text.toLowerCase();
      sess.step = 'bank_income';
      return ctx.reply(`${text} income/deposits (e.g ${d.incomeFrequency === 'monthly' ? '6400' : '3200'}):`);
    }
    if (sess.step === 'bank_income') {
      const val = parseFloat(text.replace(/[^0-9.]/g, ''));
      if (isNaN(val)) return ctx.reply('Please enter a valid number:');
      d.income = val;
      sess.step = 'bank_payroll_dates';
      if (d.incomeFrequency === 'monthly') {
        return ctx.reply('Payroll deposit date (day or full date, e.g. 1 or 2026-07-01):');
      }
      return ctx.reply('Payroll deposit dates (comma-separated days or full dates, e.g. 1, 15 or 2026-07-01, 2026-07-15):');
    }
    if (sess.step === 'bank_payroll_dates') {
      const days = text
        .split(/[,\n]+/)
        .map((part) => {
          const iso = part.match(/\b\d{4}-\d{2}-(\d{2})\b/);
          if (iso) return parseInt(iso[1], 10);
          return parseInt(part.replace(/\D/g, ''), 10);
        })
        .filter((day) => Number.isInteger(day));
      const uniqueDays = [...new Set(days)].sort((a, b) => a - b);
      if (!uniqueDays.length || uniqueDays.some((day) => day < 1 || day > 31)) {
        return ctx.reply('Please enter valid day numbers or full dates, like: 1, 15 or 2026-07-01, 2026-07-15');
      }
      if (d.incomeFrequency === 'monthly' && uniqueDays.length > 1) {
        return ctx.reply('Monthly income should have one payroll deposit date. Enter one day or full date:');
      }
      d.payrollDays = uniqueDays;
      sess.step = 'bank_employer';
      return ctx.reply('Employer name:');
    }
    if (sess.step === 'bank_employer') {
      d.employer = text;
      const maxRows = statementMaxRows(d.bank);
      sess.step = 'bank_transaction_rows';
      return ctx.reply(`Total transaction rows (max: ${maxRows} for ${d.bank} statements):`);
    }
    if (sess.step === 'bank_transaction_rows') {
      const maxRows = statementMaxRows(d.bank);
      const val = parseInt(text.replace(/[^0-9]/g, ''), 10);
      if (!Number.isInteger(val) || val < 1) return ctx.reply(`Please enter a valid row count from 1 to ${maxRows}:`);
      if (val > maxRows) return ctx.reply(`${d.bank} statements support a maximum of ${maxRows} transaction rows. Enter ${maxRows} or less:`);
      d.txCount = val;
      return queueGeneration(ctx, sess, `${d.months}-month ${d.bank} statement`, (data) => finalizeBankStatement(ctx, data));
    }
  }

  // ── NOA flow ──
  if (d.docType === 'noa') {
    if (sess.step === 'noa_name') { d.name = text; sess.step = 'noa_address'; return ctx.reply('Holder address:'); }
    if (sess.step === 'noa_address') { d.address = text; sess.step = 'noa_sin'; return ctx.reply('LAST 4 SIN (e.g. 1234):'); }
    if (sess.step === 'noa_sin') {
      const last4 = text.replace(/\D/g, '');
      if (last4.length !== 4) return ctx.reply('Please enter exactly 4 digits.');
      d.sin = maskSinLast4(last4);
      sess.step = 'noa_year';
      return ctx.reply('Tax year (e.g. 2024):');
    }
    if (sess.step === 'noa_year') { d.taxYear = text; sess.step = 'noa_income'; return ctx.reply('Annual income (e.g. 85000):'); }
    if (sess.step === 'noa_income') {
      const val = parseFloat(text.replace(/[^0-9.]/g, ''));
      if (isNaN(val)) return ctx.reply('Please enter a valid number:');
      d.income = val;
      sess.step = 'noa_tax_deducted';
      return ctx.reply('Income tax deducted (e.g. 33043.00):');
    }
    if (sess.step === 'noa_tax_deducted') {
      const val = parseFloat(text.replace(/[^0-9.]/g, ''));
      if (isNaN(val)) return ctx.reply('Please enter a valid number:');
      d.taxDeducted = val;
      return queueGeneration(ctx, sess, 'NOA', (data) => finalizeNOA(ctx, data));
    }
  }

  // ── T4 flow ──
  if (d.docType === 't4') {
    if (sess.step === 't4_first_name') { d.firstName = text; sess.step = 't4_last_name'; return ctx.reply('Last name:'); }
    if (sess.step === 't4_last_name') { d.lastName = text; d.name = formatT4EmployeeName(d.firstName, d.lastName); sess.step = 't4_address'; return ctx.reply('Employee address:'); }
    if (sess.step === 't4_address') { d.address = text; sess.step = 't4_sin'; return ctx.reply('SIN (e.g. XXX XXX XXX):'); }
    if (sess.step === 't4_sin') { d.sin = normalizeSin(text); sess.step = 't4_year'; return ctx.reply('Tax year (e.g. 2024):'); }
    if (sess.step === 't4_year') { d.taxYear = text; sess.step = 't4_employer'; return ctx.reply('Employer name:'); }
    if (sess.step === 't4_employer') { d.employer = text; sess.step = 't4_income'; return ctx.reply('Employment income (box 14, e.g. 72000):'); }
    if (sess.step === 't4_income') {
      const val = parseFloat(text.replace(/[^0-9.]/g, ''));
      if (isNaN(val)) return ctx.reply('Please enter a valid number:');
      d.income = val;
      return queueGeneration(ctx, sess, 'T4', (data) => finalizeT4(ctx, data));
    }
  }

  // ── Paystub flow ──
  if (d.docType === 'paystub') {
    if (sess.step === 'paystub_name') { d.name = text; sess.step = 'paystub_employer'; return ctx.reply('Employer / company name:'); }
    if (sess.step === 'paystub_employer') { d.employer = text; sess.step = 'paystub_address'; return ctx.reply('Employee address (one line, e.g. 123 Main St, Toronto ON):'); }
    if (sess.step === 'paystub_address') { d.address = text; sess.step = 'paystub_position'; return ctx.reply('Job title / position (e.g. Project Manager):'); }
    if (sess.step === 'paystub_position') { d.position = text; sess.step = 'paystub_income'; return ctx.reply('Annual salary (e.g. 72000):'); }
    if (sess.step === 'paystub_income') {
      const val = parseFloat(text.replace(/[^0-9.]/g, ''));
      if (isNaN(val) || val <= 0) return ctx.reply('Please enter a valid number (e.g. 72000):');
      d.income = val;
      sess.step = 'paystub_frequency';
      return ctx.reply('Monthly or Biweekly Paystub?', Markup.keyboard([
        ['Monthly', 'Biweekly'],
        ['❌ Cancel']
      ]).resize());
    }
    if (sess.step === 'paystub_frequency') {
      if (!['Monthly', 'Biweekly'].includes(text)) return ctx.reply('Please choose Monthly or Biweekly.');
      d.frequency = text.toLowerCase();
      d.province = provinceFromAddress(d.address);
      sess.step = 'paystub_style';
      return ctx.reply('Choose paystub style:', Markup.keyboard([
        ...Object.keys(PAYSTUB_STYLES).map((label) => [label]),
        ['❌ Cancel']
      ]).resize());
    }
    if (sess.step === 'paystub_style') {
      if (!PAYSTUB_STYLES[text]) return ctx.reply('Please choose Style 1, Style 2, or Style 3.');
      d.designTemplate = PAYSTUB_STYLES[text];
      sess.step = 'paystub_paydate';
      return ctx.reply('Pay date (YYYY-MM-DD, e.g. 2025-01-31):', Markup.keyboard([['❌ Cancel']]).resize());
    }
    if (sess.step === 'paystub_paydate') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return ctx.reply('Please use YYYY-MM-DD format (e.g. 2025-01-31):');
      d.payDate = text;
      return queueGeneration(ctx, sess, 'paystub', (data) => finalizePaystub(ctx, data));
    }
  }

  // ── Void Cheque flow ──
  if (d.docType === 'void') {
    if (sess.step === 'void_bank') {
      if (!VOID_BANKS.includes(text)) return ctx.reply('Please choose a bank from the menu.');
      d.bank = text;
      sess.step = 'void_name';
      return ctx.reply('Account holder name:', Markup.keyboard([['❌ Cancel']]).resize());
    }
    if (sess.step === 'void_name') { d.name = text; sess.step = 'void_address'; return ctx.reply('Address (one line):'); }
    if (sess.step === 'void_address') { d.address = text; sess.step = 'void_transit'; return ctx.reply('Transit number (5 digits):'); }
    if (sess.step === 'void_transit') { d.transit = text; sess.step = 'void_institution'; return ctx.reply('Institution number (3 digits):'); }
    if (sess.step === 'void_institution') { d.institution = text; sess.step = 'void_account'; return ctx.reply('Account number:'); }
    if (sess.step === 'void_account') {
      d.account = text;
      return queueGeneration(ctx, sess, `${d.bank} void cheque`, (data) => finalizeVoid(ctx, data));
    }
  }
});

// ─── Finalizers ───────────────────────────────────────────────────────────────

async function finalizeBankStatement(ctx, d) {
  const user = getOrCreateTgUser(ctx);
  const unitPrice = DOCUMENT_PRICES.bank;
  const totalPrice = unitPrice * d.months;
  if (!hasBalance(user, totalPrice)) {
    return ctx.reply(
      `❌ Not enough balance. ${PRICE_LABELS.bank} costs *${formatUsd(unitPrice)}* per month. This request needs *${formatUsd(totalPrice)}*. Your balance is *${formatUsd(getBalance(user))}*.`,
      { parse_mode: 'Markdown' }
    );
  }

  await ctx.reply(`⏳ Generating your ${d.months}-month ${d.bank} statement... this takes a few seconds.`,
    mainMenu());

  try {
    const port = parseInt(process.env.PORT, 10) || 5000;
    const appUrl = process.env.RENDER_BASE_URL || `http://127.0.0.1:${port}`;
    const bank = bankId(d.bank);
    const txCount = Math.min(Number(d.txCount) || statementMaxRows(d.bank), statementMaxRows(d.bank));
    const accountAddress = bank === 'td' ? formatStatementAddress(d.address) : d.address;
    const branchAddress = bank === 'td' ? formatStatementAddress(d.branchAddress, { dropLeadingCode: true }) : d.branchAddress;
    const details = [
      `Account holder: ${d.acctName}`,
      `Address: ${accountAddress}`,
      `Account number: ${d.acctNumber}`,
      `Branch no: ${d.branchNumber}`,
      `Branch address: ${branchAddress}`,
      `Statement start date: ${d.startDate}`,
      `Statement end date: ${d.endDate}`,
      `Opening balance: $${Number(d.openingBalance || 0).toFixed(2)}`,
      `Payroll deposit frequency: ${d.incomeFrequency || 'biweekly'}`,
      `${d.incomeFrequency === 'monthly' ? 'Monthly' : 'Biweekly'} payroll/deposits: $${Number(d.income).toFixed(2)}`,
      `Payroll deposit days: ${(d.payrollDays || [1, 15]).join(', ')}`,
      `Employer name: ${d.employer}`,
      `Payroll deposit description: ${statementPayrollDescription(d.employer)}`,
      `Local transaction area: ${transactionAreaFromAddress(d.address) || 'based on address'}`,
      'Transaction description rule: Use local merchant descriptions based on the address provided. Toronto addresses must use Toronto-based grocery, utility, coffee shop, transit, restaurant, pharmacy, and local-service transactions. Calgary addresses must use Calgary-based grocery, utility, coffee shop, transit, restaurant, pharmacy, and local-service transactions.',
      `Province: ${provinceFromAddress(d.address)}`,
      `Number of Transactions: ${txCount}`
    ].join('\n');
    const bankPackageStartedAt = Date.now();
    const resp = await axios.post(`${appUrl}/api/generate/bank-package`, {
      bank: bankId(d.bank),
      months: d.months,
      startYear: d.year,
      startMonth: d.month,
      details
    }, { headers: { 'Content-Type': 'application/json', ...botAuthHeaders() } });
    console.log(`[bank-package] ${d.bank} months=${d.months} txCount=${txCount} durationMs=${Date.now() - bankPackageStartedAt}`);

    const presets = resp.data.presets || [];
    if (!presets.length) throw new Error('No presets returned');

    for (let i = 0; i < presets.length; i++) {
      const preset = presets[i];
      const label = preset._monthLabel || `Month ${i + 1}`;
      const docType = bankStatementDocType(d.bank);
      const presetData = { ...preset, documentType: docType };

      const pdfBuf = await generatePdf(presetData);
      spendBalance(user, unitPrice, `${d.bank} Statement`);

      await ctx.replyWithDocument(
        { source: pdfBuf, filename: `${d.bank}_Statement_${label.replace(/\s+/g, '_')}.pdf` },
        { caption: `✅ *${label}* — ${d.bank} Statement\n💰 Balance: ${formatUsd(getBalance(user))}`, parse_mode: 'Markdown' }
      );
    }
  } catch (err) {
    console.error('Bank gen error:', err.message);
    await ctx.reply('⚠️ Generation failed. Please try again.');
  }
}

async function finalizeNOA(ctx, d) {
  const user = getOrCreateTgUser(ctx);
  const price = DOCUMENT_PRICES.noa;
  if (!hasBalance(user, price)) {
    return ctx.reply(notEnoughBalanceMessage(user, PRICE_LABELS.noa, price), { parse_mode: 'Markdown' });
  }

  await ctx.reply('⏳ Generating your NOA...',
    mainMenu());

  try {
    const formattedAddress = formatNoaAddress(d.address);
    const presetData = {
      documentType: 'noaStatement',
      noaStatement: {
        name: d.name.toUpperCase(),
        address: formattedAddress,
        location: noaLocationFromAddress(formattedAddress),
        sin: d.sin,
        taxYear: d.taxYear,
        annualIncome: d.income,
        taxDeducted: d.taxDeducted,
        balanceOverride: null,
        balanceOverrideCrdr: 'DR',
        commissioner: 'Bob Hamilton',
        dateIssued: new Date().toLocaleDateString('en-CA', { month: 'short', day: '2-digit', year: 'numeric' }),
        refNumber: Math.floor(Math.random() * 9000000 + 1000000).toString(),
        refCode: Math.random().toString(36).slice(2, 10).toUpperCase(),
        accountNumber: '',
        explanation: `We have assessed your return as filed. Your notice of assessment reflects the information you submitted on your ${d.taxYear} income tax return. If you have any questions about your assessment, please call our Individual Tax and Enquiries line at 1-800-959-8281.`,
        summaryRows: []
      }
    };

    const pdfBuf = await generatePdf(presetData);
    spendBalance(user, price, 'NOA');

    await ctx.replyWithDocument(
      { source: pdfBuf, filename: `NOA_${d.taxYear}_${d.name.replace(/\s+/g, '_')}.pdf` },
      { caption: `✅ NOA ${d.taxYear} — ${d.name}\n💰 Balance: ${formatUsd(getBalance(user))}`, parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('NOA gen error:', err.message);
    await ctx.reply('⚠️ Generation failed. Please try again.');
  }
}

async function finalizeT4(ctx, d) {
  const user = getOrCreateTgUser(ctx);
  const price = DOCUMENT_PRICES.t4;
  if (!hasBalance(user, price)) {
    return ctx.reply(notEnoughBalanceMessage(user, PRICE_LABELS.t4, price), { parse_mode: 'Markdown' });
  }

  await ctx.reply('⏳ Generating your T4...',
    mainMenu());

  try {
    const employeeName = formatT4EmployeeName(d.firstName, d.lastName) || String(d.name || '').toUpperCase().trim();
    const employeeAddress = formatNoaAddress(d.address);
    const employerName = String(d.employer || '').toUpperCase().trim();
    const presetData = {
      documentType: 't4Slip',
      t4Slip: {
        year: d.taxYear,
        employerAccount: randomT4EmployerAccount(),
        sin: d.sin,
        employerName,
        employeeAddress: `${employeeName}\n${employeeAddress}`,
        '10': provinceFromAddress(d.address),
        '14': fmt(d.income),
        '22': fmt(d.income * 0.3),
        '16': fmt(Math.min(d.income * 0.0595, 3867.50)),
        '17': '',
        '18': fmt(Math.min(d.income * 0.0166, 1049.12)),
        '20': '668.00',
        '29': randomT4EmploymentCode(),
        '24': fmt(d.income),
        '26': fmt(d.income),
        '44': '0.00',
        '46': '0.00',
        '50': '',
        '52': '0.00',
        '55': '0.00',
        '56': '0.00'
      }
    };

    const pdfBuf = await generatePdf(presetData);
    spendBalance(user, price, 'T4 Slip');

    await ctx.replyWithDocument(
      { source: pdfBuf, filename: `T4_${d.taxYear}_${employeeName.replace(/\s+/g, '_')}.pdf` },
      { caption: `✅ T4 ${d.taxYear} — ${employeeName}\n💰 Balance: ${formatUsd(getBalance(user))}`, parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('T4 gen error:', err.message);
    await ctx.reply('⚠️ Generation failed. Please try again.');
  }
}

async function finalizeVoid(ctx, d) {
  const user = getOrCreateTgUser(ctx);
  const price = DOCUMENT_PRICES.void;
  if (!hasBalance(user, price)) {
    return ctx.reply(notEnoughBalanceMessage(user, PRICE_LABELS.void, price), { parse_mode: 'Markdown' });
  }

  await ctx.reply('⏳ Generating your void cheque...',
    mainMenu());

  try {
    const bankKey = d.bank === 'TD' ? 'tdVoidCheck'
      : d.bank === 'BMO' ? 'bmoVoidCheck'
      : d.bank === 'Scotiabank' ? 'scotiaVoidCheck'
      : d.bank === 'CIBC' ? 'cibcVoidCheck'
      : 'rbcVoidCheck';

    const voidValues = bankKey === 'tdVoidCheck'
      ? {
          customerName: d.name,
          customerAddress: d.address,
          transit: d.transit,
          institution: d.institution,
          account: d.account,
          designation: 'Personal Chequing',
          swiftBic: 'TDOMCATTTOR',
          branchAddress: '',
          customerAccountNumber: d.account
        }
      : bankKey === 'bmoVoidCheck'
        ? {
            name: d.name,
            transit: d.transit,
            institution: d.institution,
            account: d.account
          }
      : bankKey === 'cibcVoidCheck'
        ? {
            name: d.name,
            address: d.address,
            date: new Date().toISOString().slice(0, 10),
            transit: d.transit,
            institution: d.institution,
            account: d.account,
            branchAddress: ''
          }
        : {
            name: d.name,
            address: d.address,
            transit: d.transit,
            institution: d.institution,
            account: d.account
          };

    const presetData = { documentType: bankKey, [bankKey]: voidValues };

    const pdfBuf = await generatePdf(presetData);
    spendBalance(user, price, `${d.bank} Void Cheque`);

    await ctx.replyWithDocument(
      { source: pdfBuf, filename: `${d.bank}_VoidCheque_${d.name.replace(/\s+/g, '_')}.pdf` },
      { caption: `✅ ${d.bank} Void Cheque — ${d.name}\n💰 Balance: ${formatUsd(getBalance(user))}`, parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('Void gen error:', err.message);
    await ctx.reply('⚠️ Generation failed. Please try again.');
  }
}

async function finalizePaystub(ctx, d) {
  const user = getOrCreateTgUser(ctx);
  const price = DOCUMENT_PRICES.paystub;
  if (!hasBalance(user, price)) {
    return ctx.reply(notEnoughBalanceMessage(user, PRICE_LABELS.paystub, price), { parse_mode: 'Markdown' });
  }

  await ctx.reply('⏳ Generating your paystub...',
    mainMenu());

  try {
    const frequency = d.frequency === 'biweekly' ? 'biweekly' : 'monthly';
    const periodGross = frequency === 'biweekly' ? d.income / 26 : d.income / 12;
    const hours = frequency === 'biweekly' ? 80 : 160;
    const hourlyRate = parseFloat((periodGross / hours).toFixed(4));

    const periodEndStr = addDays(d.payDate, -5);

    const presetData = {
      documentType: 'payroll',
      companyName: d.employer.toUpperCase(),
      brandText: d.employer.toUpperCase(),
      brandColor: '#1a3a6b',
      payrollLogoDataUrl: '',
      designTemplate: d.designTemplate || 'classic-blue',
      periodEnding: periodEndStr,
      payDate: d.payDate,
      province: d.province,
      frequency,
      employeeName: d.name.toUpperCase(),
      employeeId: '',
      employeeAddress: d.address,
      earnings: [
        { label: 'Regular', rate: hourlyRate, hours: hours, period: 0, ytd: 0 },
        { label: 'Overtime', rate: 0, hours: 0, period: 0, ytd: 0 },
        { label: 'Statutory', rate: 0, hours: 0, period: 0, ytd: 0 }
      ],
      deductions: [],
      benefits: [{ label: 'Vacation Pay', period: 0, ytd: 0 }],
      vacHours: 0,
      sickHours: 0,
      notes: '*Federal Claim Code 1\n*Provincial Claim Code 1\n*Excluded from CPP taxable wages\n*Excluded from E.I taxable wages'
    };

    const pdfBuf = await generatePdf(presetData);
    spendBalance(user, price, 'Paystub');

    const safeName = d.name.replace(/\s+/g, '_');
    await ctx.replyWithDocument(
      { source: pdfBuf, filename: `Paystub_${d.payDate}_${safeName}.pdf` },
      { caption: `✅ Paystub — ${d.name} (${d.payDate})\n💰 Balance: ${formatUsd(getBalance(user))}`, parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('Paystub gen error:', err.message);
    await ctx.reply('⚠️ Generation failed. Please try again.');
  }
}

async function addBalanceCommand(ctx) {
  const adminTgId = process.env.ADMIN_TELEGRAM_ID;
  if (!adminTgId || String(ctx.from.id) !== String(adminTgId)) {
    return ctx.reply('❌ Unauthorized.');
  }
  const parts = ctx.message.text.split(' ');
  if (parts.length < 3) return ctx.reply('Usage: /addbalance <telegram_id> <usd_amount>');
  const targetId = parts[1];
  const amount = parseFloat(parts[2]);
  if (isNaN(amount)) return ctx.reply('Invalid amount.');
  const key = `tg:${targetId}`;
  const user = users.get(key);
  if (!user) return ctx.reply(`No user found with Telegram ID ${targetId}.`);
  setBalance(user, getBalance(user) + amount);
  scheduleSave();
  await ctx.reply(`✅ Added ${formatUsd(amount)} to user ${targetId}. New balance: ${formatUsd(getBalance(user))}`);
  try {
    await bot.telegram.sendMessage(targetId, `🎉 ${formatUsd(amount)} has been added to your account!\n💰 New balance: *${formatUsd(getBalance(user))}*`, { parse_mode: 'Markdown' });
  } catch (e) {}
}

// ─── Admin: add USD balance via bot ──────────────────────────────────────────
bot.command('addbalance', addBalanceCommand);
bot.command('addcredits', addBalanceCommand);

module.exports = { bot };
