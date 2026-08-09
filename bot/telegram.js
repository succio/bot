const { Telegraf, Markup, session } = require('telegraf');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { users, scheduleSave } = require('../lib/store');
const { JobQueue } = require('../lib/jobQueue');
const { generatePdf } = require('./pdf');
const { PACKAGES } = require('../routes/payments-shared');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
bot.use(session());

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

function botAuthHeaders() {
  const token = jwt.sign(
    { email: 'telegram-bot@replicas.live', service: 'telegram' },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );
  return { Authorization: `Bearer ${token}` };
}

function spendCredit(user, amount = 1) {
  user.credits = Math.max(0, Number(user.credits || 0) - amount);
  scheduleSave();
}

function bankId(bankName) {
  const map = { TD: 'td', Scotiabank: 'scotia', CIBC: 'cibc', RBC: 'rbc' };
  return map[bankName] || String(bankName || '').toLowerCase();
}

function bankStatementDocType(bankName) {
  const map = { TD: 'statement', Scotiabank: 'scotiaStatement', CIBC: 'cibcStatement', RBC: 'rbcStatement' };
  return map[bankName] || 'statement';
}

function mainMenu() {
  return Markup.keyboard([
    ['📄 Generate Document', '💳 Buy Credits'],
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

const BANKS = ['TD', 'Scotiabank', 'CIBC', 'RBC'];
const PROVINCES = ['AB', 'BC', 'ON', 'QC', 'SK', 'MB', 'NS', 'NB', 'NL', 'PE'];
const MONTHS_MAP = { '1 Month ($35)': 1, '3 Months ($100)': 3, '6 Months ($200)': 6 };

// ─── /start ───────────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  const user = getOrCreateTgUser(ctx);
  const name = ctx.from.first_name || 'there';
  await ctx.reply(
    `👋 Welcome to *replicas.live*, ${name}!\n\n` +
    `I generate Canadian financial documents — bank statements, paystubs, NOA, T4 slips, void cheques — and send the PDF right here.\n\n` +
    `You have *${user.credits} credit(s)* remaining.\n\n` +
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
    `💰 Credits: *${user.credits}*\n` +
    `📦 Package: ${user.package || 'None'}`,
    { parse_mode: 'Markdown' }
  );
});

// ─── Help ─────────────────────────────────────────────────────────────────────
bot.hears(['❓ Help', '/help'], async (ctx) => {
  await ctx.reply(
    `*How it works:*\n\n` +
    `1️⃣ Buy credits (1 credit = 1 document)\n` +
    `2️⃣ Press *Generate Document*\n` +
    `3️⃣ Answer the questions\n` +
    `4️⃣ Receive your PDF instantly\n\n` +
    `*Document types:*\n` +
    `🏦 Bank Statement (TD, Scotiabank, CIBC, RBC)\n` +
    `💼 Paystub (payroll statement)\n` +
    `📋 NOA (Notice of Assessment)\n` +
    `📑 T4 Slip\n` +
    `🔲 Void Cheque\n\n` +
    `*Pricing:*\n` +
    `• 1 Month Statement — $35\n` +
    `• 3 Month Statement — $100\n` +
    `• 6 Month Statement — $200\n` +
    `• Additional Document — $35\n\n` +
    `Support: Contact us via the web app at replicas.live`,
    { parse_mode: 'Markdown' }
  );
});

// ─── Buy Credits ──────────────────────────────────────────────────────────────
bot.hears(['💳 Buy Credits', '/buy'], async (ctx) => {
  await ctx.reply(
    `*Choose a package:*`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('1 Month Statement — $35 (1 credit)', 'buy:month1')],
        [Markup.button.callback('3 Month Statement — $100 (3 credits)', 'buy:month3')],
        [Markup.button.callback('6 Month Statement — $200 (6 credits)', 'buy:month6')],
        [Markup.button.callback('Additional Document — $35 (1 credit)', 'buy:addondoc')],
      ])
    }
  );
});

bot.action(/^buy:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const packageId = ctx.match[1];
  const pkg = PACKAGES[packageId];
  if (!pkg) return ctx.reply('Unknown package.');

  const user = getOrCreateTgUser(ctx);

  try {
    const response = await axios.post(
      'https://api.nowpayments.io/v1/invoice',
      {
        price_amount: pkg.price,
        price_currency: 'usd',
        order_id: `tg-${ctx.from.id}-${packageId}-${Date.now()}`,
        order_description: `${pkg.name} for Telegram user ${ctx.from.id}`,
        ipn_callback_url: `${process.env.APP_URL}/api/payments/ipn`,
        success_url: 'https://t.me/' + (await bot.telegram.getMe()).username,
        cancel_url: 'https://t.me/' + (await bot.telegram.getMe()).username,
      },
      { headers: { 'x-api-key': process.env.NOWPAYMENTS_API_KEY, 'Content-Type': 'application/json' } }
    );

    const invoiceUrl = response.data.invoice_url;
    await ctx.reply(
      `💳 *${pkg.name}* — $${pkg.price} USD\n\n` +
      `Click the link below to pay with crypto. Once confirmed, *${pkg.credits} credit(s)* will be added to your account automatically.\n\n` +
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
  if (user.credits < 1) {
    return ctx.reply(
      `❌ You have no credits. Press *Buy Credits* to purchase a package.`,
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
      ['🏦 Bank Statement', '📋 NOA'],
      ['📑 T4 Slip', '🔲 Void Cheque'],
      ['💼 Paystub'],
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
  if (sess.flow !== 'generate') return;

  const text = ctx.message.text.trim();
  const d = sess.data;

  if (text === '❌ Cancel') {
    sess.flow = null;
    return ctx.reply('Cancelled.', mainMenu());
  }

  // Step: doc type
  if (sess.step === 'doctype') {
    const map = {
      '🏦 Bank Statement': 'bank',
      '📋 NOA': 'noa',
      '📑 T4 Slip': 't4',
      '🔲 Void Cheque': 'void',
      '💼 Paystub': 'paystub'
    };
    if (!map[text]) return ctx.reply('Please choose a document type from the menu.');
    d.docType = map[text];

    if (d.docType === 'paystub') {
      sess.step = 'paystub_name';
      return ctx.reply('Employee full name:', Markup.keyboard([['❌ Cancel']]).resize());
    }

    if (d.docType === 'bank') {
      sess.step = 'bank_name';
      return ctx.reply('Which bank?', Markup.keyboard([...BANKS.map(b => [b]), ['❌ Cancel']]).resize());
    }
    if (d.docType === 'void') {
      sess.step = 'void_bank';
      return ctx.reply('Which bank for the void cheque?', Markup.keyboard([...BANKS.map(b => [b]), ['❌ Cancel']]).resize());
    }
    if (d.docType === 'noa') {
      sess.step = 'noa_name';
      return ctx.reply('Full name on the NOA:', Markup.keyboard([['❌ Cancel']]).resize());
    }
    if (d.docType === 't4') {
      sess.step = 't4_name';
      return ctx.reply('Employee full name:', Markup.keyboard([['❌ Cancel']]).resize());
    }
  }

  // ── Bank Statement flow ──
  if (d.docType === 'bank') {
    if (sess.step === 'bank_name') {
      if (!BANKS.includes(text)) return ctx.reply('Please choose a bank from the menu.');
      d.bank = text;
      sess.step = 'bank_months';
      return ctx.reply('How many months?', Markup.keyboard([
        ['1 Month ($35)', '3 Months ($100)'],
        ['6 Months ($200)'],
        ['❌ Cancel']
      ]).resize());
    }
    if (sess.step === 'bank_months') {
      if (!MONTHS_MAP[text]) return ctx.reply('Please choose a valid option.');
      d.months = MONTHS_MAP[text];
      sess.step = 'bank_acct_name';
      return ctx.reply('Account holder name:', Markup.keyboard([['❌ Cancel']]).resize());
    }
    if (sess.step === 'bank_acct_name') {
      d.acctName = text;
      sess.step = 'bank_acct_number';
      return ctx.reply('Account number (last 4 digits shown, e.g. ****1234):');
    }
    if (sess.step === 'bank_acct_number') {
      d.acctNumber = text;
      sess.step = 'bank_balance';
      return ctx.reply('Starting balance (e.g. 4500.00):');
    }
    if (sess.step === 'bank_balance') {
      const val = parseFloat(text.replace(/[^0-9.]/g, ''));
      if (isNaN(val)) return ctx.reply('Please enter a valid number (e.g. 4500.00):');
      d.balance = val;
      sess.step = 'bank_income';
      return ctx.reply('Monthly income/deposits (e.g. 3200.00):');
    }
    if (sess.step === 'bank_income') {
      const val = parseFloat(text.replace(/[^0-9.]/g, ''));
      if (isNaN(val)) return ctx.reply('Please enter a valid number:');
      d.income = val;
      sess.step = 'bank_year';
      return ctx.reply('Starting year (e.g. 2024):');
    }
    if (sess.step === 'bank_year') {
      const yr = parseInt(text);
      if (isNaN(yr) || yr < 2000 || yr > 2030) return ctx.reply('Please enter a valid year (e.g. 2024):');
      d.year = yr;
      sess.step = 'bank_month';
      return ctx.reply('Starting month number (1–12):');
    }
    if (sess.step === 'bank_month') {
      const mo = parseInt(text);
      if (isNaN(mo) || mo < 1 || mo > 12) return ctx.reply('Please enter a month number between 1 and 12:');
      d.month = mo;
      return queueGeneration(ctx, sess, `${d.months}-month ${d.bank} statement`, (data) => finalizeBankStatement(ctx, data));
    }
  }

  // ── NOA flow ──
  if (d.docType === 'noa') {
    if (sess.step === 'noa_name') { d.name = text; sess.step = 'noa_sin'; return ctx.reply('SIN (e.g. XXX XX0 000):'); }
    if (sess.step === 'noa_sin') { d.sin = text; sess.step = 'noa_year'; return ctx.reply('Tax year (e.g. 2024):'); }
    if (sess.step === 'noa_year') { d.taxYear = text; sess.step = 'noa_income'; return ctx.reply('Annual income (e.g. 85000):'); }
    if (sess.step === 'noa_income') {
      const val = parseFloat(text.replace(/[^0-9.]/g, ''));
      if (isNaN(val)) return ctx.reply('Please enter a valid number:');
      d.income = val;
      sess.step = 'noa_balance';
      return ctx.reply('Balance owing amount (e.g. 4200.00):');
    }
    if (sess.step === 'noa_balance') {
      const val = parseFloat(text.replace(/[^0-9.]/g, ''));
      if (isNaN(val)) return ctx.reply('Please enter a valid number:');
      d.balance = val;
      sess.step = 'noa_crdr';
      return ctx.reply('Is this a balance owing or a refund?', Markup.keyboard([
        ['Balance Owing (DR)', 'Refund (CR)'], ['❌ Cancel']
      ]).resize());
    }
    if (sess.step === 'noa_crdr') {
      if (!['Balance Owing (DR)', 'Refund (CR)'].includes(text)) return ctx.reply('Please choose from the menu.');
      d.crdr = text.includes('DR') ? 'DR' : 'CR';
      return queueGeneration(ctx, sess, 'NOA', (data) => finalizeNOA(ctx, data));
    }
  }

  // ── T4 flow ──
  if (d.docType === 't4') {
    if (sess.step === 't4_name') { d.name = text; sess.step = 't4_sin'; return ctx.reply('SIN (e.g. XXX XX0 000):'); }
    if (sess.step === 't4_sin') { d.sin = text; sess.step = 't4_year'; return ctx.reply('Tax year (e.g. 2024):'); }
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
      sess.step = 'paystub_province';
      return ctx.reply('Province (choose one):', Markup.keyboard([
        ['ON', 'BC', 'AB'],
        ['QC', 'SK', 'MB'],
        ['NS', 'NB', 'NL'],
        ['❌ Cancel']
      ]).resize());
    }
    if (sess.step === 'paystub_province') {
      if (!PROVINCES.includes(text)) return ctx.reply('Please choose a province from the menu.');
      d.province = text;
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
      if (!BANKS.includes(text)) return ctx.reply('Please choose a bank from the menu.');
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
  if (user.credits < d.months) {
    return ctx.reply(`❌ Not enough credits. This package needs *${d.months}* credit(s).`, { parse_mode: 'Markdown' });
  }

  await ctx.reply(`⏳ Generating your ${d.months}-month ${d.bank} statement... this takes a few seconds.`,
    mainMenu());

  try {
    const appUrl = process.env.APP_URL || 'http://localhost:5000';
    const details = [
      `Account holder: ${d.acctName}`,
      `Account number: ${d.acctNumber}`,
      `Opening balance: $${Number(d.balance).toFixed(2)}`,
      `Monthly payroll/deposits: $${Number(d.income).toFixed(2)}`,
      'Province: ON',
      'Number of Transactions: 50'
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
      spendCredit(user, 1);

      await ctx.replyWithDocument(
        { source: pdfBuf, filename: `${d.bank}_Statement_${label.replace(/\s+/g, '_')}.pdf` },
        { caption: `✅ *${label}* — ${d.bank} Statement\n💰 Credits remaining: ${user.credits}`, parse_mode: 'Markdown' }
      );
    }
  } catch (err) {
    console.error('Bank gen error:', err.message);
    await ctx.reply('⚠️ Generation failed. Please try again.');
  }
}

async function finalizeNOA(ctx, d) {
  const user = getOrCreateTgUser(ctx);
  if (user.credits < 1) return ctx.reply('❌ Not enough credits.');

  await ctx.reply('⏳ Generating your NOA...',
    mainMenu());

  try {
    const presetData = {
      documentType: 'noaStatement',
      noaStatement: {
        name: d.name,
        sin: d.sin,
        taxYear: d.taxYear,
        annualIncome: d.income,
        taxDeducted: 0,
        balanceOverride: d.balance,
        balanceOverrideCrdr: d.crdr,
        commissioner: 'Bob Hamilton',
        dateIssued: new Date().toLocaleDateString('en-CA', { month: 'short', day: '2-digit', year: 'numeric' }),
        address: '',
        location: '',
        refNumber: Math.floor(Math.random() * 9000000 + 1000000).toString(),
        refCode: Math.random().toString(36).slice(2, 10).toUpperCase(),
        accountNumber: '000000000',
        explanation: `Based on our assessment of your ${d.taxYear} income tax return, you have a ${d.crdr === 'DR' ? 'balance owing' : 'refund'} of $${fmt(d.balance)}.`,
        summaryRows: []
      }
    };

    const pdfBuf = await generatePdf(presetData);
    spendCredit(user, 1);

    await ctx.replyWithDocument(
      { source: pdfBuf, filename: `NOA_${d.taxYear}_${d.name.replace(/\s+/g, '_')}.pdf` },
      { caption: `✅ NOA ${d.taxYear} — ${d.name}\n💰 Credits remaining: ${user.credits}`, parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('NOA gen error:', err.message);
    await ctx.reply('⚠️ Generation failed. Please try again.');
  }
}

async function finalizeT4(ctx, d) {
  const user = getOrCreateTgUser(ctx);
  if (user.credits < 1) return ctx.reply('❌ Not enough credits.');

  await ctx.reply('⏳ Generating your T4...',
    mainMenu());

  try {
    const presetData = {
      documentType: 't4Slip',
      t4Slip: {
        year: d.taxYear,
        employerAccount: '',
        sin: d.sin,
        employerName: d.employer,
        employeeAddress: d.name,
        '10': 'ON',
        '14': fmt(d.income),
        '22': fmt(d.income * 0.18),
        '16': fmt(Math.min(d.income * 0.0595, 3867.50)),
        '17': '',
        '18': fmt(Math.min(d.income * 0.0166, 1049.12)),
        '24': fmt(d.income),
        '26': fmt(d.income),
        '55': '',
        '56': ''
      }
    };

    const pdfBuf = await generatePdf(presetData);
    spendCredit(user, 1);

    await ctx.replyWithDocument(
      { source: pdfBuf, filename: `T4_${d.taxYear}_${d.name.replace(/\s+/g, '_')}.pdf` },
      { caption: `✅ T4 ${d.taxYear} — ${d.name}\n💰 Credits remaining: ${user.credits}`, parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('T4 gen error:', err.message);
    await ctx.reply('⚠️ Generation failed. Please try again.');
  }
}

async function finalizeVoid(ctx, d) {
  const user = getOrCreateTgUser(ctx);
  if (user.credits < 1) return ctx.reply('❌ Not enough credits.');

  await ctx.reply('⏳ Generating your void cheque...',
    mainMenu());

  try {
    const bankKey = d.bank === 'TD' ? 'tdVoidCheck'
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
    spendCredit(user, 1);

    await ctx.replyWithDocument(
      { source: pdfBuf, filename: `${d.bank}_VoidCheque_${d.name.replace(/\s+/g, '_')}.pdf` },
      { caption: `✅ ${d.bank} Void Cheque — ${d.name}\n💰 Credits remaining: ${user.credits}`, parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('Void gen error:', err.message);
    await ctx.reply('⚠️ Generation failed. Please try again.');
  }
}

async function finalizePaystub(ctx, d) {
  const user = getOrCreateTgUser(ctx);
  if (user.credits < 1) return ctx.reply('❌ Not enough credits.');

  await ctx.reply('⏳ Generating your paystub...',
    mainMenu());

  try {
    const monthlyGross = d.income / 12;
    const hours = 160; // standard monthly hours
    const hourlyRate = parseFloat((monthlyGross / hours).toFixed(4));

    // Period-end is last day of pay-date month
    const pd = new Date(d.payDate);
    const periodEnd = new Date(pd.getFullYear(), pd.getMonth() + 1, 0);
    const periodEndStr = periodEnd.toISOString().split('T')[0];

    const presetData = {
      documentType: 'payroll',
      companyName: d.employer.toUpperCase(),
      brandText: d.employer.split(' ')[0].toUpperCase(),
      brandColor: '#1a3a6b',
      payrollLogoDataUrl: '',
      designTemplate: 'classic-blue',
      periodEnding: periodEndStr,
      payDate: d.payDate,
      province: d.province,
      frequency: 'monthly',
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
    spendCredit(user, 1);

    const safeName = d.name.replace(/\s+/g, '_');
    await ctx.replyWithDocument(
      { source: pdfBuf, filename: `Paystub_${d.payDate}_${safeName}.pdf` },
      { caption: `✅ Paystub — ${d.name} (${d.payDate})\n💰 Credits remaining: ${user.credits}`, parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('Paystub gen error:', err.message);
    await ctx.reply('⚠️ Generation failed. Please try again.');
  }
}

// ─── Admin: add credits via bot ───────────────────────────────────────────────
bot.command('addcredits', async (ctx) => {
  const adminTgId = process.env.ADMIN_TELEGRAM_ID;
  if (!adminTgId || String(ctx.from.id) !== String(adminTgId)) {
    return ctx.reply('❌ Unauthorized.');
  }
  const parts = ctx.message.text.split(' ');
  if (parts.length < 3) return ctx.reply('Usage: /addcredits <telegram_id> <amount>');
  const targetId = parts[1];
  const amount = parseInt(parts[2]);
  if (isNaN(amount)) return ctx.reply('Invalid amount.');
  const key = `tg:${targetId}`;
  const user = users.get(key);
  if (!user) return ctx.reply(`No user found with Telegram ID ${targetId}.`);
  user.credits += amount;
  scheduleSave();
  await ctx.reply(`✅ Added ${amount} credit(s) to user ${targetId}. New balance: ${user.credits}`);
  try {
    await bot.telegram.sendMessage(targetId, `🎉 ${amount} credit(s) have been added to your account!\n💰 New balance: *${user.credits} credits*`, { parse_mode: 'Markdown' });
  } catch (e) {}
});

module.exports = { bot };
