const { Telegraf, Markup, session } = require('telegraf');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { users, scheduleSave } = require('../lib/store');
const { JobQueue } = require('../lib/jobQueue');
const { generatePdf } = require('./pdf');
const { PACKAGES, DOCUMENT_PRICES, PRICE_LABELS } = require('../routes/payments-shared');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
bot.use(session());

const MIN_TOPUP_USD = 35;
const MAX_TOPUP_USD = 10000;

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

async function createTopupInvoice(ctx, amount, packageId = null, label = null) {
  const me = await bot.telegram.getMe();
  const cents = Math.round(Number(amount) * 100);
  const orderId = packageId
    ? `tg-${ctx.from.id}-${packageId}-${Date.now()}`
    : `tg-${ctx.from.id}-custom-${cents}-${Date.now()}`;

  const response = await axios.post(
    'https://api.nowpayments.io/v1/invoice',
    {
      price_amount: amount,
      price_currency: 'usd',
      order_id: orderId,
      order_description: `${label || 'Custom Balance Top Up'} for Telegram user ${ctx.from.id}`,
      ipn_callback_url: `${process.env.APP_URL}/api/payments/ipn`,
      success_url: `https://t.me/${me.username}`,
      cancel_url: `https://t.me/${me.username}`,
    },
    { headers: { 'x-api-key': process.env.NOWPAYMENTS_API_KEY, 'Content-Type': 'application/json' } }
  );

  return response.data.invoice_url;
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
    ['👤 My Account', '❓ Help']
  ]).resize();
}

function queueGeneration(ctx, sess, jobName, worker) {
  const position = generationQueue.size + generationQueue.running + 1;
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

  generationQueue.add(() => worker(data))
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

const STATEMENT_BANKS = ['TD', 'BMO', 'Simplii', 'Scotiabank', 'CIBC', 'RBC'];
const VOID_BANKS = ['TD', 'BMO', 'Scotiabank', 'CIBC', 'RBC'];
const PAYSTUB_STYLES = {
  'Style 1: classic-blue': 'classic-blue',
  'Style 2: northern-mint': 'northern-mint',
  'Style 3: prairie-sand': 'prairie-sand',
};
const PROVINCES = ['AB', 'BC', 'ON', 'QC', 'SK', 'MB', 'NS', 'NB', 'NL', 'PE'];

// ─── /start ───────────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  const user = getOrCreateTgUser(ctx);
  const name = ctx.from.first_name || 'there';
  await ctx.reply(
    `👋 Welcome to *replicas.live*, ${name}!\n\n` +
    `I generate Canadian financial documents — bank statements, paystubs, NOA, T4 slips, void cheques — and send the PDF right here.\n\n` +
    `Your balance is *${formatUsd(getBalance(user))}*.\n\n` +
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
    `Support: Contact us via the web app at replicas.live`,
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

  try {
    const invoiceUrl = await createTopupInvoice(ctx, pkg.price, packageId, pkg.name);
    await ctx.reply(
      `💳 *${pkg.name}* — $${pkg.price} USD\n\n` +
      `Click the link below to pay with crypto. Once confirmed, *${formatUsd(pkg.amount || pkg.price)} USD* will be added to your account automatically.\n\n` +
      `🔗 [Pay Now](${invoiceUrl})`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('Bot invoice error:', err.response?.data || err.message);
    await ctx.reply('⚠️ Could not create payment link. Please try again later.');
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
    return ctx.reply('Cancelled.', mainMenu());
  }

  if (sess.flow === 'topup') {
    const amount = parseFloat(text.replace(/[^0-9.]/g, ''));
    if (isNaN(amount)) return ctx.reply('Please enter a valid USD amount (e.g 300):');
    if (amount < MIN_TOPUP_USD) return ctx.reply(`Minimum amount is ${formatUsd(MIN_TOPUP_USD)}. Enter a higher amount:`);
    if (amount > MAX_TOPUP_USD) return ctx.reply(`Maximum amount is ${formatUsd(MAX_TOPUP_USD)}. Enter a lower amount:`);

    sess.flow = null;
    sess.step = null;
    sess.data = {};

    try {
      const invoiceUrl = await createTopupInvoice(ctx, amount, null, `Custom ${formatUsd(amount)} Balance Top Up`);
      return ctx.reply(
        `💳 *Custom Top Up* — ${formatUsd(amount)} USD\n\n` +
        `Click the link below to pay with crypto. Once confirmed, *${formatUsd(amount)} USD* will be added to your account automatically.\n\n` +
        `🔗 [Pay Now](${invoiceUrl})`,
        { parse_mode: 'Markdown', ...mainMenu() }
      );
    } catch (err) {
      console.error('Bot custom invoice error:', err.response?.data || err.message);
      return ctx.reply('⚠️ Could not create payment link. Please try again later.', mainMenu());
    }
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
      sess.step = 't4_name';
      return ctx.reply('Employee name:', Markup.keyboard([['❌ Cancel']]).resize());
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
      sess.step = 'bank_income';
      return ctx.reply('Biweekly income/deposits (e.g 3200):');
    }
    if (sess.step === 'bank_income') {
      const val = parseFloat(text.replace(/[^0-9.]/g, ''));
      if (isNaN(val)) return ctx.reply('Please enter a valid number:');
      d.income = val;
      sess.step = 'bank_employer';
      return ctx.reply('Employer name:');
    }
    if (sess.step === 'bank_employer') {
      d.employer = text;
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
    if (sess.step === 't4_name') { d.name = text; sess.step = 't4_address'; return ctx.reply('Employee address:'); }
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
    const txCount = bank === 'simplii' ? 21 : bank === 'bmo' ? 25 : bank === 'cibc' ? 30 : bank === 'scotia' ? 34 : bank === 'rbc' ? 40 : 50;
    const details = [
      `Account holder: ${d.acctName}`,
      `Address: ${d.address}`,
      `Account number: ${d.acctNumber}`,
      `Branch no: ${d.branchNumber}`,
      `Statement start date: ${d.startDate}`,
      `Statement end date: ${d.endDate}`,
      `Opening balance: $5000.00`,
      `Biweekly payroll/deposits: $${Number(d.income).toFixed(2)}`,
      `Employer name: ${d.employer}`,
      `Payroll deposit description: ${statementPayrollDescription(d.employer)}`,
      `Local transaction area: ${transactionAreaFromAddress(d.address) || 'based on address'}`,
      'Transaction description rule: Use local merchant descriptions based on the address provided. Toronto addresses must use Toronto-based grocery, utility, coffee shop, transit, restaurant, pharmacy, and local-service transactions. Calgary addresses must use Calgary-based grocery, utility, coffee shop, transit, restaurant, pharmacy, and local-service transactions.',
      `Province: ${provinceFromAddress(d.address)}`,
      `Number of Transactions: ${txCount}`
    ].join('\n');
    const resp = await axios.post(`${appUrl}/api/generate/bank-package`, {
      bank: bankId(d.bank),
      months: d.months,
      startYear: d.year,
      startMonth: d.month,
      details
    }, { headers: { 'Content-Type': 'application/json', ...botAuthHeaders() } });

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
    const employeeName = String(d.name || '').toUpperCase().trim();
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
        '22': fmt(d.income * 0.18),
        '16': fmt(Math.min(d.income * 0.0595, 3867.50)),
        '17': '',
        '18': fmt(Math.min(d.income * 0.0166, 1049.12)),
        '29': randomT4EmploymentCode(),
        '24': fmt(d.income),
        '26': fmt(d.income),
        '44': '0.00',
        '46': '0.00',
        '52': '0.00',
        '55': '',
        '56': ''
      }
    };

    const pdfBuf = await generatePdf(presetData);
    spendBalance(user, price, 'T4 Slip');

    await ctx.replyWithDocument(
      { source: pdfBuf, filename: `T4_${d.taxYear}_${d.name.replace(/\s+/g, '_')}.pdf` },
      { caption: `✅ T4 ${d.taxYear} — ${d.name}\n💰 Balance: ${formatUsd(getBalance(user))}`, parse_mode: 'Markdown' }
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
      brandText: d.employer.split(' ')[0].toUpperCase(),
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
