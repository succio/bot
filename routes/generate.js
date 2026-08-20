const express = require('express');
const router = express.Router();
const OpenAI = require('openai');
const authMiddleware = require('../middleware/authMiddleware');

const SYSTEM_PROMPT = `You are a document data extraction assistant for a Canadian HR/financial document generator. The user will describe what they want in plain text. Extract the information and return ONLY a valid JSON object — no explanation, no markdown, no code fences.

The user will specify a document type. Return the matching JSON shape below.

=== DOCUMENT TYPE: payroll ===
The user provides a pay amount (monthly or biweekly gross). You calculate all derived fields automatically.

AUTO-CALCULATION RULES — follow each step exactly:

STEP 1 — HOURS & RATE:
  biweekly: hours = 80, rate = round(periodPay / 80, 2)
  monthly:  hours = 160, rate = round(periodPay / 160, 2)

STEP 2 — PERIODS ELAPSED (periodsElapsed):
  monthly:  periodsElapsed = month number of periodEnding (Jan=1, Feb=2, … Dec=12)
  biweekly: use this lookup by month of periodEnding:
    Jan → 2, Feb → 4, Mar → 7, Apr → 8, May → 10, Jun → 11,
    Jul → 13, Aug → 15, Sep → 17, Oct → 19, Nov → 21, Dec → 22
  Example: periodEnding = 2026-04-18 → month = April → periodsElapsed = 8
  Example: periodEnding = 2026-01-31 → month = January → periodsElapsed = 2

STEP 3 — YTD EARNINGS:
  ytdEarnings = periodPay × periodsElapsed

STEP 4 — CPP (2025/2026):
  exemptionPerPeriod = 134.62 (biweekly) or 291.67 (monthly)
  cppPeriod = round(0.0595 × (periodPay - exemptionPerPeriod), 2)
  cppPeriod = min(cppPeriod, 148.75)   ← cap: $3,867.50 / 26 biweekly or / 12 monthly
  cppYtd = round(min(cppPeriod × periodsElapsed, 3867.50), 2)
  (If QC: rate 0.064 instead of 0.0595)

STEP 5 — EI (2025/2026):
  eiPeriod = round(0.0166 × periodPay, 2)
  eiPeriod = min(eiPeriod, 40.35)      ← cap: $1,049.12 / 26 biweekly or / 12 monthly
  eiYtd = round(min(eiPeriod × periodsElapsed, 1049.12), 2)

STEP 6 — ANNUAL GROSS (for tax calculation):
  annualGross = periodPay × (26 if biweekly, 12 if monthly)

STEP 7 — FEDERAL TAX per period:
  Compute annual federal tax on annualGross using these brackets:
    First $57,375 → 15%
    $57,375–$114,750 → 20.5%
    $114,750–$177,882 → 26%
    $177,882–$253,414 → 29%
    Over $253,414 → 33%
  Subtract BPA credit: $2,356
  Subtract CPP deduction credit: cppPeriod × periodsPerYear × 15%
  Subtract EI deduction credit: eiPeriod × periodsPerYear × 15%
  annualFederalTax = max(0, bracketTax - 2356 - cppCredit - eiCredit)
  federalPeriod = round(annualFederalTax / periodsPerYear, 2)
  federalYtd = round(federalPeriod × periodsElapsed, 2)

STEP 8 — PROVINCIAL TAX per period:
  Approximate effective annual rate by province (applied to annualGross):
    ON: 5.05% first $51,446; add 9.15% on $51,446–$102,894; add 11.16% above → effective ~8.5% to 10.5%
    BC: 5.06% first $45,654; 7.70% to $91,310; 10.5% above → effective ~7% to 9.5%
    AB: flat 10%
    QC: 14% first $51,780; 19% to $103,545; 24% above → effective ~16% to 20%
    SK: 10.5% first $49,720; 12.5% above
    MB: 10.8% first $36,842; 12.75% to $79,625; 17.4% above
    NS: 8.79% first $29,590; 14.95% to $59,180; 16.67% above
    NB: 9.40% first $47,715; 14.82% to $95,431; 16.52% above
    NL: 8.70% first $43,198; 14.50% to $86,395; 15.80% above
    PE: 9.65% first $32,656; 13.63% to $64,313; 16.65% above
  Calculate annual provincial tax using the brackets above, then:
  provincialPeriod = round(annualProvincialTax / periodsPerYear, 2)
  provincialYtd = round(provincialPeriod × periodsElapsed, 2)

Return shape:
{
  "documentType": "payroll",
  "companyName": "string — full legal company name",
  "brandText": "string — short name for header (1-2 words)",
  "brandColor": "hex string e.g. #096250",
  "designTemplate": "classic-blue|executive-charcoal|northern-mint|prairie-sand|monochrome-ledger",
  "periodEnding": "YYYY-MM-DD",
  "payDate": "YYYY-MM-DD",
  "province": "AB|BC|ON|QC|SK|MB|NS|NB|NL|PE",
  "frequency": "monthly|biweekly",
  "employeeName": "string — FULL NAME IN CAPS",
  "employeeId": "string",
  "employeeAddress": "string — use \\n for line breaks",
  "earnings": [{"label":"Regular","rate":number,"hours":number,"period":number,"ytd":number}],
  "deductions": [{"label":"Federal Tax","period":number,"ytd":number},{"label":"Provincial Tax","period":number,"ytd":number},{"label":"E.I*","period":number,"ytd":number},{"label":"CPP*","period":number,"ytd":number}],
  "benefits": [{"label":"Vacation Pay","period":0,"ytd":0}],
  "vacHours": number,
  "sickHours": number,
  "notes": "string"
}

=== DOCUMENT TYPE: employment ===
{
  "documentType": "employment",
  "employmentVerification": {
    "date": "YYYY-MM-DD",
    "employeeName": "string",
    "startDate": "YYYY-MM-DD",
    "employeeAddress": "string",
    "companyName": "string",
    "companyAddress": "string",
    "annualIncome": number,
    "position": "string"
  }
}

=== DOCUMENT TYPE: statement (TD Bank) ===
{
  "documentType": "statement",
  "statement": {
    "name": "string — e.g. MR JOHN DOE",
    "address": "string — use \\n for line breaks",
    "branchAddress": "string — use \\n for line breaks",
    "branchNo": "string",
    "accountNo": "string",
    "statementFrom": "string — e.g. OCT 01/25",
    "statementTo": "string — e.g. DEC 31/25",
    "openingBalance": number,
    "accountType": "string — e.g. UNLIMITED",
    "transactions": [
      {"description":"string","debit":number,"credit":number,"date":"string — e.g. OCT01 or NOV15"}
    ]
  }
}

=== DOCUMENT TYPE: scotiaStatement ===
{
  "documentType": "scotiaStatement",
  "scotiaStatement": {
    "name": "string — ALL CAPS, e.g. MR PAUL-EMELYN JEAN-FRANCOIS",
    "address": "string — use \\n for line breaks",
    "branchAddress": "string — use \\n for line breaks",
    "accountNo": "string",
    "accountType": "string — e.g. Your Preferred Package",
    "statementFrom": "string — e.g. Oct 18, 2025",
    "statementTo": "string — e.g. Nov 17, 2025",
    "openingBalance": number,
    "transactions": [
      {"date":"string — e.g. Oct 18","description":"string","detail":"string","withdrawn":number,"deposited":number}
    ]
  }
}

=== DOCUMENT TYPE: cibcStatement ===
{
  "documentType": "cibcStatement",
  "cibcStatement": {
    "name": "string — ALL CAPS",
    "address": "string — use \\n for line breaks",
    "accountNo": "string",
    "branchTransit": "string",
    "statementFrom": "string — e.g. Nov 1",
    "statementTo": "string — e.g. Nov 30, 2024",
    "openingBalance": number,
    "disclaimer": "string",
    "transactions": [
      {"date":"string — e.g. Nov 1","description":"string","detail":"string","withdrawn":number,"deposited":number}
    ]
  }
}

=== DOCUMENT TYPE: rbcStatement ===
{
  "documentType": "rbcStatement",
  "rbcStatement": {
    "name": "string — ALL CAPS",
    "address": "string — use \\n for line breaks",
    "accountNo": "string",
    "accountType": "personal|business",
    "bankBranch": "string — branch name and address, use \\n",
    "statementFrom": "string — e.g. Sep 01, 2024",
    "statementTo": "string — e.g. Sep 30, 2024",
    "openingBalance": number,
    "transactions": [
      {"date":"string — e.g. 01 Sep","description":"string","withdrawn":number,"deposited":number}
    ]
  }
}

=== DOCUMENT TYPE: bmoStatement ===
{
  "documentType": "bmoStatement",
  "bmoStatement": {
    "name": "string — ALL CAPS",
    "address": "string — use \\n for line breaks",
    "branchAddress": "string — use \\n for line breaks",
    "branchName": "string — e.g. BMO Bank of Montreal",
    "transitNo": "string",
    "phone": "string — e.g. 1-800-363-9992",
    "planName": "string — e.g. Performance Chequing",
    "accountNo": "string",
    "accountType": "string — e.g. Primary Chequing Account",
    "periodEnd": "string — e.g. Jul 31, 2026",
    "openingBalance": number,
    "transactions": [
      {"date":"string — e.g. Jul 01","description":"string — use \\n for detail line","deducted":number,"added":number}
    ]
  }
}

=== DOCUMENT TYPE: simpliiStatement ===
{
  "documentType": "simpliiStatement",
  "simpliiStatement": {
    "name": "string — ALL CAPS",
    "address": "string — use \\n for line breaks",
    "accountNo": "string",
    "statementPeriodFrom": "string — e.g. May 01, 2026",
    "statementPeriodTo": "string — e.g. May 31, 2026",
    "statementDate": "string — e.g. May 31, 2026",
    "openingBalance": number,
    "transactions": [
      {"transDate":"string — e.g. May 01","effDate":"string — e.g. May 01","description":"string","fundsOut":number,"fundsIn":number}
    ]
  }
}

=== DOCUMENT TYPE: noaStatement ===
{
  "documentType": "noaStatement",
  "noaStatement": {
    "name": "string — ALL CAPS",
    "address": "string — use \\n for line breaks",
    "location": "string — city/postal",
    "sin": "string — e.g. XXX XX5 016",
    "taxYear": "string — e.g. 2024",
    "dateIssued": "string — e.g. Jun 03, 2025",
    "refNumber": "string — 7 digits",
    "refCode": "string — e.g. ZK25ZG45",
    "accountNumber": "string — 9 digits",
    "annualIncome": number,
    "taxDeducted": number,
    "commissioner": "string",
    "explanation": "string",
    "summaryRows": []
  }
}

=== DOCUMENT TYPE: t4Slip ===
{
  "documentType": "t4Slip",
  "t4Slip": {
    "year": "string — e.g. 2024",
    "employerAccount": "string — e.g. 123456789RP0001",
    "employerName": "string",
    "employeeAddress": "string — first line is employee full name, subsequent lines are address, use \\n",
    "sin": "string — e.g. 123 456 789",
    "10": "string — province code e.g. ON",
    "14": "string — employment income amount",
    "22": "string — income tax deducted",
    "16": "string — CPP contributions",
    "17": "string — QPP contributions (QC only, else empty)",
    "18": "string — EI premiums",
    "24": "string — EI insurable earnings",
    "26": "string — CPP/QPP pensionable earnings",
    "55": "string — PPIP premiums (QC only)",
    "56": "string — PPIP insurable earnings (QC only)"
  }
}

=== DOCUMENT TYPE: bmoVoidCheck ===
{
  "documentType": "bmoVoidCheck",
  "bmoVoidCheck": {
    "name": "string",
    "address": "string — use \\n for line breaks",
    "transit": "string — 5 digits",
    "institution": "string — 3 digits, BMO is 001",
    "account": "string — 7 digits"
  }
}

=== DOCUMENT TYPE: scotiaVoidCheck ===
{
  "documentType": "scotiaVoidCheck",
  "scotiaVoidCheck": {
    "name": "string",
    "address": "string — use \\n for line breaks",
    "transit": "string — 5 digits",
    "institution": "string — 3 digits, Scotia is 002",
    "account": "string — 7 digits"
  }
}

=== DOCUMENT TYPE: rbcVoidCheck ===
{
  "documentType": "rbcVoidCheck",
  "rbcVoidCheck": {
    "name": "string",
    "transit": "string — 5 digits",
    "institution": "string — 3 digits, RBC is 003",
    "account": "string — 7 digits"
  }
}

=== DOCUMENT TYPE: tdVoidCheck ===
{
  "documentType": "tdVoidCheck",
  "tdVoidCheck": {
    "customerName": "string",
    "customerAddress": "string — use \\n for line breaks",
    "transit": "string — 5 digits",
    "institution": "string — 3 digits, TD is 004",
    "account": "string — 7 digits",
    "designation": "string — e.g. Personal Chequing",
    "swiftBic": "string — e.g. TDOMCATTTOR",
    "branchAddress": "string — use \\n",
    "customerAccountNumber": "string"
  }
}

=== DOCUMENT TYPE: cibcVoidCheck ===
{
  "documentType": "cibcVoidCheck",
  "cibcVoidCheck": {
    "name": "string",
    "address": "string — use \\n for line breaks",
    "date": "string — YYYY-MM-DD",
    "transit": "string — 5 digits",
    "institution": "string — 3 digits, CIBC is 010",
    "account": "string — 7 digits",
    "branchAddress": "string — use \\n"
  }
}

=== BANK STATEMENT GENERATION RULES (ALL BANK TYPES) ===

RULE 1 — TRANSACTION COUNT: Generate EXACTLY the number of transactions specified in "Number of Transactions" field. No more, no fewer. If not specified, default to 50.

RULE 2 — TARGET CLOSING BALANCE: When a target closing balance is provided, you MUST hit it:
  closing = opening + sum(all credits/deposits) - sum(all debits/withdrawals)
  Keep ordinary filler withdrawals present and realistic. If the target is higher than the natural closing balance, add one "ATM Deposit" row for the exact difference instead of deleting, zeroing, or shrinking ordinary transaction rows.
  If the target is lower than the natural closing balance, adjust individual debit amounts so the final closing balance matches the target exactly (±$1.00).
  Do the arithmetic before generating — work backwards from the target if needed.
  Never create withdrawal rows that make the running balance negative. Keep every withdrawal at or below the available running balance at that point in the month.

RULE 3 — LOCATION-AWARE MERCHANT NAMES (apply based on "Local transaction area" first, then "Province" field):
  If "Local transaction area" is provided, all ordinary debit/withdrawal merchants must match that city/area.
  Always use detailed merchant descriptions with merchant name + city + province suffix, not vague labels like "Surrey groceries", "coffee shop", "pet store", "restaurant", "pharmacy", "transit", or "rent payment".
  Toronto → use Toronto-based merchants and services: Loblaws, Metro, FreshCo, Shoppers Drug Mart, TTC/PRESTO, Toronto Hydro, Tim Hortons, Starbucks, local restaurants and pharmacies, suffix ONCA.
  Calgary → use Calgary-based merchants and services: Safeway, Co-op Grocery, Real Canadian Superstore, Shoppers Drug Mart, Calgary Transit, ENMAX, ATCO Gas, Tim Hortons, Starbucks, local restaurants and pharmacies, suffix ABCA.
  Surrey → use Surrey-based merchants and services: Loblaws, Save-On-Foods, Safeway, Real Canadian Superstore, Shoppers Drug Mart, London Drugs, Tim Hortons, Starbucks, BC Hydro, Telus, suffix BCCA.
  Never use Ottawa/Nepean merchants for a Toronto address. Never use Edmonton merchants for a Calgary address.
  If no local area is provided, apply the province rules:
  BC → suffix "BCCA", city Burnaby or Vancouver, utility BC Hydro, mobile Telus
  ON → suffix "ONCA", city Ottawa or Nepean, utility Hydro Ottawa, mobile Rogers
  AB → suffix "ABCA", city Calgary or Edmonton, utility ATCO Gas, mobile Shaw
  QC → suffix "QCCA", city Montreal or Laval, utility Hydro-Québec, mobile Vidéotron
  SK → suffix "SKCA", city Regina or Saskatoon, utility SaskPower, mobile SaskTel
  MB → suffix "MBCA", city Winnipeg, utility Manitoba Hydro, mobile Bell MTS
  NS → suffix "NSCA", city Halifax, utility Nova Scotia Power, mobile Eastlink
  NB → suffix "NBCA", city Moncton or Fredericton, utility NB Power
  PE → suffix "PECA", city Charlottetown, utility Maritime Electric
  NL → suffix "NLCA", city St. John's, utility Newfoundland Power
  (Default to ON rules if province not specified)

RULE 4 — CUSTOM TRANSACTION PLACEMENT: The only credit/deposit transactions allowed are custom deposit transactions explicitly provided by the user, plus an "ATM Deposit" row only when needed to hit the requested target closing balance. Place every user-provided custom transaction, deposit or withdrawal, on the EXACT date specified with the EXACT description and amount. Never add random incoming e-transfers, refunds, transfers from friends, cashbacks, reversals, interest credits, or other credit transactions.

RULE 5 — CHRONOLOGICAL ORDER: All requested transactions must be in strict ascending date order.

RULE 6 — REALISTIC VARIETY: Use a natural mix across the month — groceries, gas, retail, utilities, restaurants, ATM withdrawals, and outgoing payments/transfers only. Spread transactions across the full period, not clustered.

RULE 7 — FILLER MERCHANT FORMAT (by bank):
  TD statement: use format "OPOS MERCHANT CITY SUFFIX" or "APOS MERCHANT CITY SUFFIX" for debit card purchases
  Scotia: use short debit transaction types in "description" such as "Purchase", "Online payment to", or "Withdrawal". Put the merchant/reference in "detail" such as "Loblaws Toronto ON". Do NOT use OPOS/APOS in Scotia statements. Do not use "Direct Deposit" or "Interac e-Transfer from" except for the user-provided custom deposit row.
  CIBC/RBC: use clean merchant names with city and suffix

=== DEFAULTS ===
When the user says "same account holder" or does not specify name/address for Scotia statements, use:
  name: "MR PAUL-EMELYN JEAN-FRANCOIS"
  address: "2038 CALTRA CRES\\nNEPEAN ON\\nK2J 6V4"
  branchAddress: "51326\\n3701 STRANDHERD DRIVE\\nNEPEAN ONTARIO K2J 4G8"
  accountNo: "51326 14857 84"
  accountType: "Your Preferred Package"

Custom transactions (Scotia) use the provided custom transaction description in the transaction detail.
Do not create filler deposits for any bank except the single "ATM Deposit" row allowed when needed to hit the requested target closing balance.

All transactions must be in chronological order.
Return ONLY the JSON object. No other text.`;

// ─── Payroll post-processing ──────────────────────────────────────────────────
function r2(n) { return Math.round(n * 100) / 100; }

function periodsElapsed(periodEnding, frequency) {
  const d = new Date(periodEnding + 'T12:00:00');
  if (isNaN(d)) return frequency === 'monthly' ? 1 : 2;
  const month = d.getMonth() + 1; // 1–12
  if (frequency === 'monthly') return month;
  // biweekly: count 14-day periods from Jan 1
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const dayOfYear = Math.floor((d - jan1) / 86400000) + 1;
  return Math.max(1, Math.ceil(dayOfYear / 14));
}

function annualFederalTax(annualGross) {
  const brackets = [
    [57375, 0.15],
    [114750, 0.205],
    [177882, 0.26],
    [253414, 0.29],
    [Infinity, 0.33],
  ];
  let tax = 0, prev = 0;
  for (const [top, rate] of brackets) {
    if (annualGross <= prev) break;
    tax += Math.min(annualGross, top) * rate - prev * rate;
    prev = top;
    if (top === Infinity) break;
  }
  return Math.max(0, tax);
}

function annualProvincialTax(annualGross, province) {
  const brackets = {
    ON: [[51446,0.0505],[102894,0.0915],[220000,0.1116],[Infinity,0.1216]],
    BC: [[45654,0.0506],[91310,0.077],[104835,0.105],[127299,0.1229],[172602,0.147],[240716,0.168],[Infinity,0.205]],
    AB: [[Infinity,0.10]],
    QC: [[51780,0.14],[103545,0.19],[126000,0.24],[Infinity,0.2575]],
    SK: [[49720,0.105],[142058,0.125],[Infinity,0.145]],
    MB: [[36842,0.108],[79625,0.1275],[Infinity,0.174]],
    NS: [[29590,0.0879],[59180,0.1495],[93000,0.1667],[150000,0.175],[Infinity,0.21]],
    NB: [[47715,0.094],[95431,0.1482],[176756,0.1652],[Infinity,0.203]],
    NL: [[43198,0.087],[86395,0.145],[154244,0.158],[215943,0.178],[275870,0.198],[Infinity,0.208]],
    PE: [[32656,0.0965],[64313,0.1363],[105000,0.1665],[Infinity,0.18]],
  };
  const prov = (province || 'ON').toUpperCase();
  const tiers = brackets[prov] || brackets.ON;
  let tax = 0, prev = 0;
  for (const [top, rate] of tiers) {
    if (annualGross <= prev) break;
    tax += (Math.min(annualGross, top) - prev) * rate;
    prev = top;
    if (!isFinite(top)) break;
  }
  return Math.max(0, tax);
}

function fixPayrollCalculations(preset) {
  if (preset.documentType !== 'payroll') return preset;

  const frequency = preset.frequency || 'biweekly';
  const periodsPerYear = frequency === 'monthly' ? 12 : 26;
  const hours = frequency === 'monthly' ? 160 : 80;

  // Get period gross from AI-generated earnings
  const periodGross = preset.earnings && preset.earnings.length
    ? Number(preset.earnings[0].period) || 0
    : 0;

  if (!periodGross) return preset;

  const annualGross = periodGross * periodsPerYear;
  const rate = r2(periodGross / hours);
  const pe = periodsElapsed(preset.periodEnding, frequency);

  // CPP 2025
  const cppExemption = frequency === 'monthly' ? 291.67 : 134.62;
  const cppMaxAnnual = 3867.50;
  const cppPeriod = r2(Math.min(0.0595 * Math.max(0, periodGross - cppExemption), cppMaxAnnual / periodsPerYear));
  const cppYtd = r2(Math.min(cppPeriod * pe, cppMaxAnnual));

  // EI 2025
  const eiMaxAnnual = 1049.12;
  const eiPeriod = r2(Math.min(0.0166 * periodGross, eiMaxAnnual / periodsPerYear));
  const eiYtd = r2(Math.min(eiPeriod * pe, eiMaxAnnual));

  // Federal tax
  const cppAnnual = cppPeriod * periodsPerYear;
  const eiAnnual = eiPeriod * periodsPerYear;
  const bpaCredit = 2356;
  const cppCredit = r2(cppAnnual * 0.15);
  const eiCredit = r2(eiAnnual * 0.15);
  const annualFed = Math.max(0, annualFederalTax(annualGross) - bpaCredit - cppCredit - eiCredit);
  const fedPeriod = r2(annualFed / periodsPerYear);
  const fedYtd = r2(fedPeriod * pe);

  // Provincial tax
  const prov = preset.province || 'ON';
  const annualProv = annualProvincialTax(annualGross, prov);
  const provPeriod = r2(annualProv / periodsPerYear);
  const provYtd = r2(provPeriod * pe);

  // Rebuild earnings with corrected values
  const updatedEarnings = (preset.earnings || []).map((row, i) => {
    if (i === 0) {
      return { ...row, hours, rate, period: periodGross, ytd: r2(periodGross * pe) };
    }
    return row;
  });

  // Rebuild deductions with corrected values
  const deductionMap = {
    'Federal Tax': { period: fedPeriod, ytd: fedYtd },
    'Provincial Tax': { period: provPeriod, ytd: provYtd },
    'E.I*': { period: eiPeriod, ytd: eiYtd },
    'CPP*': { period: cppPeriod, ytd: cppYtd },
  };

  const updatedDeductions = (preset.deductions || [
    { label: 'Federal Tax' },
    { label: 'Provincial Tax' },
    { label: 'E.I*' },
    { label: 'CPP*' },
  ]).map(row => {
    const fix = deductionMap[row.label];
    return fix ? { ...row, ...fix } : row;
  });

  const defaultNotes = '*Federal Claim Code 2\n*Provincial Claim Code 2\n*Excluded from CPP taxable wages\n*Excluded from E.I taxable wages';

  return { ...preset, earnings: updatedEarnings, deductions: updatedDeductions, notes: defaultNotes };
}
// ──────────────────────────────────────────────────────────────────────────────

router.post('/', authMiddleware, async (req, res) => {
  const { prompt, documentType } = req.body;
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 5) {
    return res.status(400).json({ error: 'Prompt is required.' });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: 'AI service is not configured.' });
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const userMessage = documentType
    ? `Document type: ${documentType}\n\n${prompt.trim()}`
    : prompt.trim();

  try {
    const completion = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage }
      ],
      temperature: 0.1,
      max_tokens: 4096,
      response_format: { type: 'json_object' }
    });

    const raw = completion.choices[0].message.content.trim();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return res.status(500).json({ error: 'AI returned malformed JSON. Please try again.' });
    }

    const fixed = fixPayrollCalculations(parsed);
    res.json({ preset: fixed });
  } catch (err) {
    console.error('OpenAI error:', err.message);
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'AI generation failed.' });
  }
});

// ─── Bank Package multi-month generation ──────────────────────────────────────
const BANK_DOC_TYPES = { td: 'statement', bmo: 'bmoStatement', simplii: 'simpliiStatement', scotia: 'scotiaStatement', cibc: 'cibcStatement', rbc: 'rbcStatement' };
const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTH_UPPER = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const MONTH_FULL  = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function daysInMonth(year, month) { return new Date(year, month, 0).getDate(); }

function formatPeriod(bank, year, month) {
  const s = MONTH_SHORT[month - 1];
  const u = MONTH_UPPER[month - 1];
  const d = daysInMonth(year, month);
  const yr2 = String(year).slice(2);
  const nm = month === 12 ? 1 : month + 1;
  const ny = month === 12 ? year + 1 : year;
  const ns = MONTH_SHORT[nm - 1];
  switch (bank) {
    case 'td':    return { from: `${u} 01/${yr2}`, to: `${u} ${d}/${yr2}` };
    case 'scotia':return { from: `${s} 18, ${year}`, to: `${ns} 17, ${ny}` };
    case 'cibc':  return { from: `${s} 1`, to: `${s} ${d}, ${year}` };
    case 'rbc':   return { from: `${s} 01, ${year}`, to: `${s} ${d}, ${year}` };
    case 'bmo':   return { from: `${s} 01, ${year}`, to: `${s} ${d}, ${year}` };
    case 'simplii': return { from: `${s} 01, ${year}`, to: `${s} ${d}, ${year}` };
    default:      return { from: `${s} 01/${yr2}`, to: `${s} ${d}/${yr2}` };
  }
}

function calcClosing(openingBalance, transactions, bank) {
  let bal = openingBalance;
  for (const tx of (transactions || [])) {
    if (bank === 'td') {
      bal += (Number(tx.credit) || 0) - (Number(tx.debit) || 0);
    } else if (bank === 'bmo') {
      bal += (Number(tx.added) || 0) - (Number(tx.deducted) || 0);
    } else if (bank === 'simplii') {
      bal += (Number(tx.fundsIn) || 0) - (Number(tx.fundsOut) || 0);
    } else {
      bal += (Number(tx.deposited) || 0) - (Number(tx.withdrawn) || 0);
    }
  }
  return Math.round(bal * 100) / 100;
}

function txCreditAmount(tx, bank) {
  if (bank === 'td') return Number(tx.credit || 0) || 0;
  if (bank === 'bmo') return Number(tx.added || 0) || 0;
  if (bank === 'simplii') return Number(tx.fundsIn || 0) || 0;
  return Number(tx.deposited || 0) || 0;
}

function txWithdrawalAmount(tx, bank) {
  if (bank === 'td') return Number(tx.debit || 0) || 0;
  if (bank === 'bmo') return Number(tx.deducted || 0) || 0;
  if (bank === 'simplii') return Number(tx.fundsOut || 0) || 0;
  return Number(tx.withdrawn || 0) || 0;
}

function setTxWithdrawalAmount(tx, bank, amount) {
  const value = Math.max(0, Math.round(Number(amount || 0) * 100) / 100);
  if (bank === 'td') return { ...tx, debit: value };
  if (bank === 'bmo') return { ...tx, deducted: value };
  if (bank === 'simplii') return { ...tx, fundsOut: value };
  return { ...tx, withdrawn: value };
}

function hasTransactionAmount(tx, bank) {
  return txCreditAmount(tx, bank) > 0 || txWithdrawalAmount(tx, bank) > 0;
}

function dropEmptyGeneratedTransactions(transactions, bank) {
  return (transactions || []).filter((tx) => tx._customTransaction || hasTransactionAmount(tx, bank));
}

function atmDepositTransaction(bank, date, amount) {
  const value = Math.max(0, Math.round(Number(amount || 0) * 100) / 100);
  if (bank === 'td') return { description: 'ATM Deposit', debit: 0, credit: value, date };
  if (bank === 'bmo') return { date, description: 'ATM Deposit', deducted: 0, added: value };
  if (bank === 'simplii') return { transDate: date, effDate: date, description: 'ATM Deposit', fundsOut: 0, fundsIn: value };
  if (bank === 'scotia') return { date, description: 'ATM Deposit', detail: '', withdrawn: 0, deposited: value };
  return { date, description: 'ATM Deposit', detail: '', withdrawn: 0, deposited: value };
}

function targetClosingBalanceFromDetails(details) {
  const raw = detailValue(details, 'Target closing balance');
  if (!raw) return null;
  const match = raw.match(/-?\$?\s*([\d,]+(?:\.\d+)?)/);
  return match ? Math.round(Number(match[1].replace(/,/g, '')) * 100) / 100 : null;
}

function capGeneratedWithdrawals(transactions, bank, openingBalance) {
  const rows = (transactions || []).map((tx) => ({ ...tx }));
  let balance = Math.max(0, Number(openingBalance) || 0);

  for (let index = 0; index < rows.length; index++) {
    const tx = rows[index];
    const credit = txCreditAmount(tx, bank);
    let withdrawal = txWithdrawalAmount(tx, bank);
    let nextTx = tx;
    const isCustom = Boolean(tx._customTransaction);

    if (credit > 0) {
      balance = Math.round((balance + credit) * 100) / 100;
    }

    if (withdrawal > 0 && isCustom && withdrawal > balance) {
      const neededDeposit = Math.round((withdrawal - balance) * 100) / 100;
      const supportDeposit = atmDepositTransaction(bank, transactionDateText(tx), neededDeposit);
      rows.splice(index, 0, supportDeposit);
      balance = Math.round((balance + neededDeposit) * 100) / 100;
      index += 1;
    }

    if (withdrawal > 0 && !isCustom) {
      const maxWithdrawal = Math.max(0, Math.floor((balance - 1) * 100) / 100);
      if (withdrawal > maxWithdrawal) {
        nextTx = setTxWithdrawalAmount(tx, bank, maxWithdrawal);
        rows[index] = nextTx;
        withdrawal = txWithdrawalAmount(nextTx, bank);
      }
    }

    if (withdrawal > 0) {
      balance = Math.max(0, Math.round((balance - withdrawal) * 100) / 100);
    }

    rows[index] = nextTx;
  }

  return dropEmptyGeneratedTransactions(rows, bank);
}

function rebalanceToTargetClosing(transactions, bank, openingBalance, targetClosing) {
  if (targetClosing === null || targetClosing === undefined || Number.isNaN(Number(targetClosing))) {
    return transactions || [];
  }

  const target = Math.max(0, Math.round(Number(targetClosing) * 100) / 100);
  const rows = (transactions || []).map((tx) => ({ ...tx }));
  let current = calcClosing(openingBalance, rows, bank);
  let delta = Math.round((current - target) * 100) / 100;
  if (Math.abs(delta) <= 0.01) return rows;

  if (delta < 0) {
    const remainder = Math.abs(delta);
    if (remainder > 0.01) {
      const date = transactionDateText(rows[rows.length - 1]) || transactionDateText(rows.find(Boolean)) || '';
      rows.push(atmDepositTransaction(bank, date, remainder));
    }

    return dropEmptyGeneratedTransactions(rows, bank);
  }

  const balancesAfter = [];
  let running = Math.max(0, Number(openingBalance) || 0);
  for (let i = 0; i < rows.length; i++) {
    running = Math.round((running + txCreditAmount(rows[i], bank) - txWithdrawalAmount(rows[i], bank)) * 100) / 100;
    balancesAfter[i] = running;
  }

  for (let i = rows.length - 1; i >= 0 && delta > 0; i--) {
    if (rows[i]._customTransaction) continue;
    const amount = txWithdrawalAmount(rows[i], bank);
    if (amount <= 0) continue;
    const futureMin = Math.min(...balancesAfter.slice(i));
    const add = Math.min(delta, Math.max(0, Math.floor(futureMin * 100) / 100));
    if (add <= 0) continue;
    rows[i] = setTxWithdrawalAmount(rows[i], bank, amount + add);
    delta = Math.round((delta - add) * 100) / 100;
    for (let j = i; j < balancesAfter.length; j++) {
      balancesAfter[j] = Math.round((balancesAfter[j] - add) * 100) / 100;
    }
  }

  return dropEmptyGeneratedTransactions(rows, bank);
}

// Province-aware filler merchant pool
const FILLER_MERCHANTS = {
  BC: ['SHOPPERS DRUG MART BURNABY BCCA','SAVE-ON-FOODS BURNABY BCCA','TIM HORTONS BURNABY BCCA','MCDONALDS VANCOUVER BCCA','LONDON DRUGS BURNABY BCCA','STARBUCKS VANCOUVER BCCA','DOLLARAMA BURNABY BCCA','SUPERSTORE BURNABY BCCA','SUBWAY BURNABY BCCA','BOSTON PIZZA BURNABY BCCA','WINNERS BURNABY BCCA','REXALL BURNABY BCCA','SAFEWAY BURNABY BCCA','PHARMASAVE BURNABY BCCA','A&W VANCOUVER BCCA'],
  ON: ['SHOPPERS DRUG MART OTTAWA ONCA','METRO OTTAWA ONCA','TIM HORTONS NEPEAN ONCA','MCDONALDS OTTAWA ONCA','DOLLARAMA NEPEAN ONCA','SUPERSTORE OTTAWA ONCA','SUBWAY OTTAWA ONCA','BOSTON PIZZA NEPEAN ONCA','WINNERS OTTAWA ONCA','LOBLAWS OTTAWA ONCA','REXALL NEPEAN ONCA','STARBUCKS OTTAWA ONCA','A&W NEPEAN ONCA','FRESHCO OTTAWA ONCA','FARMBOY NEPEAN ONCA'],
  AB: ['SHOPPERS DRUG MART CALGARY ABCA','SAFEWAY CALGARY ABCA','TIM HORTONS EDMONTON ABCA','MCDONALDS CALGARY ABCA','DOLLARAMA EDMONTON ABCA','SUPERSTORE CALGARY ABCA','SUBWAY EDMONTON ABCA','BOSTON PIZZA CALGARY ABCA','WINNERS CALGARY ABCA','CO-OP GROCERY EDMONTON ABCA','REXALL CALGARY ABCA','STARBUCKS CALGARY ABCA','A&W EDMONTON ABCA','SOBEYS EDMONTON ABCA'],
  QC: ['PHARMACIE JEAN COUTU MONTREAL QCCA','IGA MONTREAL QCCA','TIM HORTONS LAVAL QCCA','MCDONALDS MONTREAL QCCA','DOLLARAMA LAVAL QCCA','MAXI MONTREAL QCCA','SUBWAY LAVAL QCCA','ST-HUBERT MONTREAL QCCA','WINNERS MONTREAL QCCA','METRO MONTREAL QCCA','PHARMAPRIX LAVAL QCCA','STARBUCKS MONTREAL QCCA','A&W MONTREAL QCCA'],
  SK: ['SHOPPERS DRUG MART REGINA SKCA','SOBEYS REGINA SKCA','TIM HORTONS SASKATOON SKCA','MCDONALDS REGINA SKCA','DOLLARAMA SASKATOON SKCA','SUPERSTORE REGINA SKCA','SUBWAY SASKATOON SKCA','BOSTON PIZZA REGINA SKCA','WINNERS REGINA SKCA','CO-OP GROCERY SASKATOON SKCA'],
  MB: ['SHOPPERS DRUG MART WINNIPEG MBCA','SAFEWAY WINNIPEG MBCA','TIM HORTONS WINNIPEG MBCA','MCDONALDS WINNIPEG MBCA','DOLLARAMA WINNIPEG MBCA','SUPERSTORE WINNIPEG MBCA','SUBWAY WINNIPEG MBCA','BOSTON PIZZA WINNIPEG MBCA','WINNERS WINNIPEG MBCA','CO-OP GROCERY WINNIPEG MBCA'],
  NS: ['SHOPPERS DRUG MART HALIFAX NSCA','SOBEYS HALIFAX NSCA','TIM HORTONS HALIFAX NSCA','MCDONALDS HALIFAX NSCA','DOLLARAMA HALIFAX NSCA','SUPERSTORE HALIFAX NSCA','SUBWAY HALIFAX NSCA','BOSTON PIZZA HALIFAX NSCA'],
  NB: ['SHOPPERS DRUG MART MONCTON NBCA','SOBEYS FREDERICTON NBCA','TIM HORTONS MONCTON NBCA','MCDONALDS FREDERICTON NBCA','DOLLARAMA MONCTON NBCA','SUPERSTORE FREDERICTON NBCA'],
  NL: ['SHOPPERS DRUG MART ST JOHNS NLCA','SOBEYS ST JOHNS NLCA','TIM HORTONS ST JOHNS NLCA','MCDONALDS ST JOHNS NLCA','DOLLARAMA ST JOHNS NLCA'],
  PE: ['SHOPPERS DRUG MART CHARLOTTETOWN PECA','SOBEYS CHARLOTTETOWN PECA','TIM HORTONS CHARLOTTETOWN PECA','MCDONALDS CHARLOTTETOWN PECA'],
};

const LOCAL_FILLER_MERCHANTS = {
  TORONTO: [
    'LOBLAWS TORONTO ONCA', 'METRO TORONTO ONCA', 'FRESHCO TORONTO ONCA',
    'SHOPPERS DRUG MART TORONTO ONCA', 'REXALL TORONTO ONCA',
    'TIM HORTONS TORONTO ONCA', 'STARBUCKS TORONTO ONCA', 'SECOND CUP TORONTO ONCA',
    'TTC PRESTO TORONTO ONCA', 'TORONTO HYDRO TORONTO ONCA',
    'ROGERS TORONTO ONCA', 'DOLLARAMA TORONTO ONCA', 'WINNERS TORONTO ONCA',
    'LCBO TORONTO ONCA', 'PIZZA PIZZA TORONTO ONCA'
  ],
  CALGARY: [
    'SAFEWAY CALGARY ABCA', 'CO-OP GROCERY CALGARY ABCA', 'SUPERSTORE CALGARY ABCA',
    'SHOPPERS DRUG MART CALGARY ABCA', 'REXALL CALGARY ABCA',
    'TIM HORTONS CALGARY ABCA', 'STARBUCKS CALGARY ABCA', 'SECOND CUP CALGARY ABCA',
    'CALGARY TRANSIT CALGARY ABCA', 'ENMAX CALGARY ABCA',
    'ATCO GAS CALGARY ABCA', 'DOLLARAMA CALGARY ABCA', 'WINNERS CALGARY ABCA',
    'SOBEYS CALGARY ABCA', 'BOSTON PIZZA CALGARY ABCA'
  ],
  SURREY: [
    'LOBLAWS SURREY BCCA', 'SAVE-ON-FOODS SURREY BCCA', 'SAFEWAY SURREY BCCA',
    'REAL CANADIAN SUPERSTORE SURREY BCCA', 'SHOPPERS DRUG MART SURREY BCCA',
    'LONDON DRUGS SURREY BCCA', 'TIM HORTONS SURREY BCCA', 'STARBUCKS SURREY BCCA',
    'BC HYDRO SURREY BCCA', 'TELUS SURREY BCCA', 'DOLLARAMA SURREY BCCA',
    'WINNERS SURREY BCCA', 'A&W SURREY BCCA', 'BOSTON PIZZA SURREY BCCA',
    'CO-OP GROCERY SURREY BCCA'
  ],
};
const FILLER_AMOUNTS = [8.47, 12.33, 15.67, 18.99, 22.45, 25.11, 27.89, 31.42, 34.76, 37.23, 41.55, 44.88, 47.15, 9.63, 13.77, 16.44, 19.22, 23.88, 26.55, 29.14, 33.67, 36.41, 39.78, 43.22, 46.05];

function localAreaFromDetails(details) {
  const match = String(details || '').match(/Local transaction area:\s*([^\n]+)/i);
  const value = match ? match[1].trim().toUpperCase() : '';
  if (value.includes('TORONTO')) return 'TORONTO';
  if (value.includes('CALGARY')) return 'CALGARY';
  if (value.includes('SURREY')) return 'SURREY';
  if (value && value !== 'BASED ON ADDRESS') return value.replace(/[^A-Z .'-]/g, '').replace(/\s+/g, ' ').trim();
  return '';
}

function detailValue(details, label) {
  const wanted = String(label || '').toLowerCase();
  const lines = String(details || '').replace(/\r/g, '').split('\n');
  const startIndex = lines.findIndex((line) => {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    return match && match[1].trim().toLowerCase() === wanted;
  });
  if (startIndex < 0) return '';

  const first = lines[startIndex].replace(/^([^:]+):\s*/, '').trim();
  const valueLines = first ? [first] : [];
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (/^[A-Za-z][A-Za-z0-9 /()'-]*:\s*/.test(line)) break;
    valueLines.push(line);
  }
  return valueLines.join('\n').trim();
}

function requestedTransactionCount(bank, details) {
  const match = String(details || '').match(/Number of Transactions:\s*(\d+)/i);
  const count = match ? parseInt(match[1], 10) : 50;
  if (bank === 'scotia') return Math.min(count, 34);
  if (bank === 'rbc') return Math.min(count, 40);
  if (bank === 'bmo') return Math.min(count, 25);
  if (bank === 'simplii') return Math.min(count, 21);
  return bank === 'cibc' ? Math.min(count, 30) : count;
}

function titleCaseMerchant(text) {
  return String(text || '')
    .replace(/\b(ONCA|ABCA|BCCA|QCCA|SKCA|MBCA|NSCA|NBCA|NLCA|PECA)\b/g, (m) => m.slice(0, 2))
    .toLowerCase()
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .replace(/\bTtc\b/g, 'TTC')
    .replace(/\bPresto\b/g, 'PRESTO')
    .replace(/\bLcbo\b/g, 'LCBO')
    .replace(/\bAtco\b/g, 'ATCO')
    .replace(/\bEnmax\b/g, 'ENMAX');
}

function merchantPoolFor(province, localArea = '') {
  const prov = (province || 'ON').toUpperCase();
  if (LOCAL_FILLER_MERCHANTS[localArea]) return LOCAL_FILLER_MERCHANTS[localArea];
  if (localArea) {
    const suffixByProvince = {
      BC: 'BCCA',
      ON: 'ONCA',
      AB: 'ABCA',
      QC: 'QCCA',
      SK: 'SKCA',
      MB: 'MBCA',
      NS: 'NSCA',
      NB: 'NBCA',
      NL: 'NLCA',
      PE: 'PECA'
    };
    const suffix = suffixByProvince[prov] || 'ONCA';
    const base = {
      BC: ['LOBLAWS', 'SAVE-ON-FOODS', 'SAFEWAY', 'REAL CANADIAN SUPERSTORE', 'SHOPPERS DRUG MART', 'LONDON DRUGS', 'TIM HORTONS', 'STARBUCKS', 'BC HYDRO', 'TELUS', 'DOLLARAMA', 'WINNERS'],
      AB: ['SAFEWAY', 'CO-OP GROCERY', 'REAL CANADIAN SUPERSTORE', 'SHOPPERS DRUG MART', 'TIM HORTONS', 'STARBUCKS', 'CALGARY TRANSIT', 'ENMAX', 'ATCO GAS', 'DOLLARAMA', 'WINNERS'],
      SK: ['CO-OP GROCERY', 'SASKPOWER', 'SASKTEL MOBILE', 'TIM HORTONS', 'REAL CANADIAN SUPERSTORE', 'REGINA TRANSIT', 'STARBUCKS', 'SHOPPERS DRUG MART', 'DOLLARAMA', 'WINNERS'],
      ON: ['LOBLAWS', 'METRO', 'FRESHCO', 'SHOPPERS DRUG MART', 'TIM HORTONS', 'STARBUCKS', 'TTC PRESTO', 'HYDRO', 'ROGERS', 'DOLLARAMA', 'WINNERS']
    }[prov] || ['SHOPPERS DRUG MART', 'SOBEYS', 'TIM HORTONS', 'STARBUCKS', 'DOLLARAMA', 'WINNERS'];
    return base.map((merchant) => `${merchant} ${localArea} ${suffix}`);
  }
  return FILLER_MERCHANTS[prov] || FILLER_MERCHANTS.ON;
}

function isGenericPurchaseDescription(value) {
  const text = String(value || '').trim().toUpperCase();
  if (/^(PURCHASE|POINT OF SALE PURCHASE|DEBIT CARD PURCHASE|CARD PURCHASE|POS PURCHASE|PAYMENT)$/.test(text)) return true;
  return /\b(GROCERY STORE|GROCERIES|COFFEE SHOP|PET STORE|CLOTHING STORE|GAS STATION|GYM MEMBERSHIP|CINEMA|BOOKSTORE|RESTAURANT|PHARMACY|TRANSIT|RENT PAYMENT|MOBILE)$/.test(text);
}

function isCreditLike(tx, bank) {
  if (bank === 'td') return Number(tx.credit || 0) > 0;
  if (bank === 'bmo') return Number(tx.added || 0) > 0;
  if (bank === 'simplii') return Number(tx.fundsIn || 0) > 0;
  return Number(tx.deposited || 0) > 0;
}

function hasMerchantDetail(tx) {
  return Boolean(String(tx.detail || '').trim());
}

function localMerchant(pool, index) {
  return pool[index % pool.length];
}

function fixGenericTransactionDescriptions(txs, bank, province, localArea = '') {
  const pool = merchantPoolFor(province, localArea);
  let merchantIndex = 0;

  return (txs || []).map((tx) => {
    if (!tx || isCreditLike(tx, bank)) return tx;

    const desc = String(tx.description || '').trim();
    const detail = String(tx.detail || '').trim();
    const generic = isGenericPurchaseDescription(desc);
    if (!generic && (bank !== 'scotia' || detail)) return tx;

    const merchant = localMerchant(pool, merchantIndex++);
    if (bank === 'td') {
      return { ...tx, description: `OPOS ${merchant}` };
    }
    if (bank === 'scotia') {
      return {
        ...tx,
        description: generic ? 'Purchase' : desc,
        detail: hasMerchantDetail(tx) ? tx.detail : titleCaseMerchant(merchant)
      };
    }
    if (bank === 'bmo') {
      return { ...tx, description: `Debit Card Purchase\n${titleCaseMerchant(merchant)}` };
    }
    if (bank === 'simplii') {
      return { ...tx, description: titleCaseMerchant(merchant) };
    }
    return { ...tx, description: merchant };
  });
}

function amountFromDetails(details, label) {
  const raw = detailValue(details, label);
  const match = raw.match(/-?\$?\s*([\d,]+(?:\.\d+)?)/);
  return match ? Number(match[1].replace(/,/g, '')) || 0 : 0;
}

function customDepositFrequencyFromDetails(details) {
  const raw = (detailValue(details, 'Custom deposit frequency') || detailValue(details, 'Payroll deposit frequency')).toLowerCase();
  return raw === 'monthly' ? 'monthly' : 'biweekly';
}

function customDepositDaysFromDetails(details, year, month) {
  const frequency = customDepositFrequencyFromDetails(details);
  const raw = detailValue(details, 'Custom deposit days') ||
    detailValue(details, 'Custom deposit dates') ||
    detailValue(details, 'Payroll deposit days') ||
    detailValue(details, 'Payroll deposit dates');
  const maxDay = daysInMonth(year, month);
  if (!raw) return (frequency === 'monthly' ? [1] : [1, 15]).filter((day) => day <= maxDay);

  const days = String(raw)
    .split(/[,\n]+/)
    .map((part) => {
      const iso = part.match(/\b\d{4}-\d{2}-(\d{2})\b/);
      if (iso) return Number(iso[1]);
      const monthDay = part.match(/\b(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\s*\.?\s*(\d{1,2})\b/i);
      if (monthDay) return Number(monthDay[1]);
      const number = part.match(/\b([0-3]?\d)\b/);
      return number ? Number(number[1]) : null;
    })
    .filter((day) => Number.isInteger(day) && day >= 1 && day <= maxDay);

  const uniqueDays = [...new Set(days)].sort((a, b) => a - b);
  return frequency === 'monthly' ? uniqueDays.slice(0, 1) : uniqueDays;
}

function transactionDateText(tx) {
  return String(tx.date || tx.transDate || tx.effDate || '').trim();
}

function transactionDay(tx) {
  const raw = transactionDateText(tx).toUpperCase();
  const afterMonth = raw.match(/\b(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\s*\.?\s*(\d{1,2})\b/);
  if (afterMonth) return Number(afterMonth[1]);
  const beforeMonth = raw.match(/\b(\d{1,2})\s*(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b/);
  if (beforeMonth) return Number(beforeMonth[1]);
  const anyDay = raw.match(/\b([0-3]?\d)\b/);
  return anyDay ? Number(anyDay[1]) : 1;
}

function sortTransactionsByDate(txs) {
  return (txs || [])
    .map((tx, index) => ({ tx, index }))
    .sort((a, b) => transactionDay(a.tx) - transactionDay(b.tx) || a.index - b.index)
    .map(({ tx }) => tx);
}

function bankDate(bank, year, month, day) {
  const dayStr = String(day).padStart(2, '0');
  const ms = MONTH_SHORT[month - 1];
  const mu = MONTH_UPPER[month - 1];
  if (bank === 'td') return `${mu}${dayStr}`;
  if (bank === 'rbc') return `${dayStr} ${ms}`;
  return `${ms} ${dayStr}`;
}

function parseCustomTransactionsFromDetails(details) {
  return String(details || '')
    .split(/\n+/)
    .map((line) => line.match(/^Custom transaction:\s*(deposit|withdrawal)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*\$?\s*([\d,]+(?:\.\d+)?)/i))
    .filter(Boolean)
    .map((match) => ({
      type: match[1].toLowerCase(),
      date: match[2].trim(),
      description: match[3].trim().toUpperCase(),
      amount: Number(match[4].replace(/,/g, '')) || 0
    }))
    .filter((tx) => tx.description && tx.amount > 0);
}

function customTransactionAppliesToMonth(tx, year, month) {
  const iso = String(tx.date || '').match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (!iso) return true;
  return Number(iso[1]) === year && Number(iso[2]) === month;
}

function customTransactionDay(tx, year, month) {
  const maxDay = daysInMonth(year, month);
  const raw = String(tx.date || '').trim();
  const iso = raw.match(/\b\d{4}-\d{2}-(\d{2})\b/);
  const day = iso ? Number(iso[1]) : Number((raw.match(/\b([0-3]?\d)\b/) || [])[1]);
  return Math.min(Math.max(Number.isInteger(day) ? day : 1, 1), maxDay);
}

function customTransactionForBank(bank, year, month, tx) {
  const day = customTransactionDay(tx, year, month);
  const date = bankDate(bank, year, month, day);
  const description = String(tx.description || 'CUSTOM TRANSACTION').toUpperCase();
  const amount = Number(tx.amount || 0);
  const isDeposit = tx.type === 'deposit';

  if (bank === 'td') {
    return { description, debit: isDeposit ? 0 : amount, credit: isDeposit ? amount : 0, date, _customTransaction: true };
  }
  if (bank === 'bmo') {
    return { date, description, deducted: isDeposit ? 0 : amount, added: isDeposit ? amount : 0, _customTransaction: true };
  }
  if (bank === 'simplii') {
    return { transDate: date, effDate: date, description, fundsOut: isDeposit ? 0 : amount, fundsIn: isDeposit ? amount : 0, _customTransaction: true };
  }
  if (bank === 'scotia') {
    return {
      date: `${MONTH_SHORT[month - 1]} ${day}`,
      description: isDeposit ? 'Deposit' : 'Purchase',
      detail: description,
      withdrawn: isDeposit ? 0 : amount,
      deposited: isDeposit ? amount : 0,
      _customTransaction: true
    };
  }
  if (bank === 'rbc') {
    return { date, description, withdrawn: isDeposit ? 0 : amount, deposited: isDeposit ? amount : 0, _customTransaction: true };
  }
  return {
    date: `${MONTH_SHORT[month - 1]} ${day}`,
    description,
    detail: '',
    withdrawn: isDeposit ? 0 : amount,
    deposited: isDeposit ? amount : 0,
    _customTransaction: true
  };
}

function transactionText(tx) {
  return `${tx.description || ''} ${tx.detail || ''}`.toUpperCase();
}

function isGeneratedCustomTransaction(tx, customRows) {
  const text = transactionText(tx);
  const day = transactionDay(tx);
  return customRows.some((row) => text.includes(row.description) && day === row._day);
}

function customDepositTransaction(bank, year, month, day, amount, customDescription) {
  const date = bankDate(bank, year, month, day);
  const description = String(customDescription || 'CUSTOM DEPOSIT').toUpperCase();
  if (bank === 'td') {
    return { description, debit: 0, credit: amount, date };
  }
  if (bank === 'bmo') {
    return { date, description, deducted: 0, added: amount };
  }
  if (bank === 'simplii') {
    return { transDate: date, effDate: date, description, fundsOut: 0, fundsIn: amount };
  }
  if (bank === 'scotia') {
    return { date: `${MONTH_SHORT[month - 1]} ${day}`, description: 'Deposit', detail: description, withdrawn: 0, deposited: amount };
  }
  if (bank === 'rbc') {
    return { date, description, withdrawn: 0, deposited: amount };
  }
  return { date: `${MONTH_SHORT[month - 1]} ${day}`, description, detail: '', withdrawn: 0, deposited: amount };
}

function customDepositAmountFromDetails(details) {
  return amountFromDetails(details, 'Monthly custom deposits') ||
    amountFromDetails(details, 'Biweekly custom deposits') ||
    amountFromDetails(details, 'Custom deposit amount') ||
    amountFromDetails(details, 'Monthly payroll/deposits') ||
    amountFromDetails(details, 'Biweekly payroll/deposits') ||
    amountFromDetails(details, 'Payroll/deposits');
}

function enforceCustomDepositTransactions(txs, bank, year, month, details, targetCount = 0) {
  const amount = customDepositAmountFromDetails(details);
  const customDescription = detailValue(details, 'Custom deposit description') || detailValue(details, 'Payroll deposit description');
  const nonCreditTransactions = (txs || []).filter((tx) => !isCreditLike(tx, bank));
  if (!amount || !customDescription) return sortTransactionsByDate(nonCreditTransactions);

  const customDepositDays = customDepositDaysFromDetails(details, year, month);
  if (!customDepositDays.length) return sortTransactionsByDate(nonCreditTransactions);

  const customDeposits = customDepositDays.map((day) => customDepositTransaction(bank, year, month, day, amount, customDescription));
  const keepNonCustomDeposits = targetCount > customDeposits.length
    ? sortTransactionsByDate(nonCreditTransactions).slice(0, targetCount - customDeposits.length)
    : nonCreditTransactions;
  return sortTransactionsByDate([...keepNonCustomDeposits, ...customDeposits]);
}

function enforceCustomTransactions(txs, bank, year, month, details, targetCount = 0) {
  const customRows = parseCustomTransactionsFromDetails(details)
    .filter((tx) => customTransactionAppliesToMonth(tx, year, month))
    .map((tx) => ({ ...tx, _day: customTransactionDay(tx, year, month) }));

  if (!customRows.length) {
    return enforceCustomDepositTransactions(txs, bank, year, month, details, targetCount);
  }

  const customTxs = customRows.map((tx) => customTransactionForBank(bank, year, month, tx));
  const nonGeneratedCustomRows = (txs || []).filter((tx) => (
    !isCreditLike(tx, bank) &&
    !isGeneratedCustomTransaction(tx, customRows)
  ));
  const remainingCount = Math.max((Number(targetCount) || 0) - customTxs.length, 0);
  const keepRows = remainingCount
    ? sortTransactionsByDate(nonGeneratedCustomRows).slice(0, remainingCount)
    : [];

  return sortTransactionsByDate([...keepRows, ...customTxs]);
}

function padTransactions(txs, targetCount, bank, year, month, province, localArea = '') {
  if (txs.length >= targetCount) return txs;
  const needed = targetCount - txs.length;
  const pool = merchantPoolFor(province, localArea);
  const days = daysInMonth(year, month);
  const mu = MONTH_UPPER[month - 1];
  const ms = MONTH_SHORT[month - 1];

  // Collect used days to spread fillers
  const usedDays = new Set(txs.map(t => {
    const m = String(t.date || t.transDate || '').match(/(\d{1,2})$/);
    return m ? parseInt(m[1]) : null;
  }).filter(Boolean));

  // Pick days for filler — prefer unused, then any day in lower half of month
  const candidateDays = [];
  for (let d = days; d >= 1; d--) {
    if (!usedDays.has(d)) candidateDays.push(d);
  }
  // If we need more, allow repeating days
  while (candidateDays.length < needed) {
    for (let d = Math.floor(days / 2); d >= 1 && candidateDays.length < needed; d--) {
      candidateDays.push(d);
    }
  }
  candidateDays.sort((a, b) => a - b);

  const fillers = [];
  for (let i = 0; i < needed; i++) {
    const day = candidateDays[i % candidateDays.length];
    const dayStr = String(day).padStart(2, '0');
    const merchant = pool[i % pool.length];
    const amount = FILLER_AMOUNTS[i % FILLER_AMOUNTS.length];
    if (bank === 'td') {
      fillers.push({ description: `OPOS ${merchant}`, debit: amount, credit: 0, date: `${mu}${dayStr}` });
    } else if (bank === 'scotia') {
      fillers.push({ date: `${ms} ${day}`, description: 'Purchase', detail: titleCaseMerchant(merchant), withdrawn: amount, deposited: 0 });
    } else if (bank === 'cibc') {
      fillers.push({ date: `${ms} ${day}`, description: merchant, detail: '', withdrawn: amount, deposited: 0 });
    } else if (bank === 'rbc') {
      fillers.push({ date: `${dayStr} ${ms}`, description: merchant, withdrawn: amount, deposited: 0 });
    } else if (bank === 'bmo') {
      fillers.push({ date: `${ms} ${dayStr}`, description: `Debit Card Purchase\n${titleCaseMerchant(merchant)}`, deducted: amount, added: 0 });
    } else if (bank === 'simplii') {
      fillers.push({ transDate: `${ms} ${dayStr}`, effDate: `${ms} ${dayStr}`, description: titleCaseMerchant(merchant), fundsOut: amount, fundsIn: 0 });
    }
  }

  return sortTransactionsByDate([...txs, ...fillers]);
}

function buildBankMonthPrompt(bank, details, year, month, openingBalance, idx, total) {
  const period = formatPeriod(bank, year, month);
  const monthLabel = `${MONTH_FULL[month - 1]} ${year}`;
  const ord = ['1st','2nd','3rd','4th','5th','6th','7th','8th','9th','10th','11th','12th'][idx] || `${idx+1}th`;

  const txCount = requestedTransactionCount(bank, details);

  // Extract province from details for explicit reinforcement
  const provinceMatch = details.match(/Province:\s*([A-Z]{2})/i);
  const province = provinceMatch ? provinceMatch[1].toUpperCase() : null;

  // Strip balance lines from details so each month receives the computed opening,
  // and only the final month receives the requested target closing balance.
  const targetClosing = targetClosingBalanceFromDetails(details);
  const cleanDetails = details.trim()
    .replace(/^opening\s*balance[^\n]*/gim, '')
    .replace(/^target\s*closing\s*balance[^\n]*/gim, '')
    .trim();

  const provinceReminder = province
    ? `PROVINCE REMINDER: Province is ${province}. ALL merchant suffixes, cities, utilities, and mobile carriers MUST match the ${province} rules from RULE 3. Do NOT use ON/Ottawa/Nepean/ONCA for any other province.`
    : '';
  const localArea = localAreaFromDetails(details);
  const localReminder = localArea
    ? `LOCAL TRANSACTION REMINDER: Local transaction area is ${localArea}. Use ${localArea}-based grocery, utility, coffee shop, transit, restaurant, pharmacy, and local-service descriptions for debit transactions.`
    : '';
  const customRows = parseCustomTransactionsFromDetails(details)
    .filter((tx) => customTransactionAppliesToMonth(tx, year, month));
  const legacyCustomDepositAmount = customDepositAmountFromDetails(details);
  const legacyCustomDepositDescription = detailValue(details, 'Custom deposit description') || detailValue(details, 'Payroll deposit description');
  const customDepositDays = (!customRows.length && legacyCustomDepositAmount && legacyCustomDepositDescription)
    ? customDepositDaysFromDetails(details, year, month)
    : [];
  const customTransactionReminder = customRows.length
    ? `CUSTOM TRANSACTION REMINDER: Include these exact custom transaction(s). Do not create any other deposit/credit rows except an ATM Deposit row if needed to hit the target closing balance: ${customRows.map((tx) => `${tx.type.toUpperCase()} ${bankDate(bank, year, month, customTransactionDay(tx, year, month))} ${tx.description.toUpperCase()} $${Number(tx.amount).toFixed(2)}`).join('; ')}.`
    : '';
  const customDepositReminder = customDepositDays.length
    ? `CUSTOM DEPOSIT DATE REMINDER: Custom deposit credits must appear on these day(s) of the month only: ${customDepositDays.map((day) => bankDate(bank, year, month, day)).join(', ')}.`
    : '';
  const targetReminder = (targetClosing !== null && idx === total - 1)
    ? `Target closing balance: $${targetClosing.toFixed(2)}`
    : '';

  return `${cleanDetails}

Statement period: ${period.from} to ${period.to}
Opening balance: $${openingBalance.toFixed(2)}
${targetReminder}
Month: ${monthLabel} (${ord} of ${total} in this consecutive package)
${provinceReminder}
${localReminder}
${customTransactionReminder}
${customDepositReminder}
CRITICAL INSTRUCTION — TRANSACTION COUNT: You MUST generate EXACTLY ${txCount} transaction objects in the "transactions" array. Count them before finalising — the array length must equal ${txCount}. Fewer is wrong. More is wrong. Exactly ${txCount}.
Spread transactions across all days of the month. Vary spending amounts slightly for realism. Follow all BANK STATEMENT GENERATION RULES from the system prompt.`;
}

router.post('/bank-package', authMiddleware, async (req, res) => {
  const { bank, months, startYear, startMonth, details } = req.body;

  if (!bank || !months || !startYear || !startMonth || !details || typeof details !== 'string') {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  const numMonths = Math.min(Math.max(parseInt(months) || 1, 1), 12);
  const docType = BANK_DOC_TYPES[bank];
  if (!docType) return res.status(400).json({ error: 'Invalid bank selection.' });
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'AI service not configured.' });

  const openingMatch = details.match(/opening\s*balance[:\s]*\$?([\d,]+\.?\d*)/i);
  let currentBalance = openingMatch ? parseFloat(openingMatch[1].replace(/,/g, '')) : 5000;
  const targetClosingBalance = targetClosingBalanceFromDetails(details);

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const presets = [];
  let curYear = parseInt(startYear);
  let curMonth = parseInt(startMonth);

  for (let i = 0; i < numMonths; i++) {
    const userMessage = `Document type: ${docType}\n\n${buildBankMonthPrompt(bank, details, curYear, curMonth, currentBalance, i, numMonths)}`;
    try {
      const completion = await client.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage }
        ],
        temperature: 0.4,
        max_tokens: 16000,
        response_format: { type: 'json_object' }
      });

      let parsed;
      try { parsed = JSON.parse(completion.choices[0].message.content.trim()); }
      catch { return res.status(500).json({ error: `AI returned malformed JSON on month ${i + 1}.` }); }

      // Extract transaction count and province from details for padding
      const targetTxCount = requestedTransactionCount(bank, details);
      const provinceMatch = details.match(/Province:\s*([A-Z]{2})/i);
      const province = provinceMatch ? provinceMatch[1].toUpperCase() : 'ON';
      const localArea = localAreaFromDetails(details);
      const suppliedAddress = detailValue(details, 'Address');
      const suppliedBranchAddress = detailValue(details, 'Branch address');

      // Pad transactions server-side if the AI returned fewer than requested
      const inner = parsed[docType] || parsed.statement || parsed.bmoStatement || parsed.simpliiStatement || parsed.scotiaStatement || parsed.cibcStatement || parsed.rbcStatement || {};
      if (bank === 'td') {
        if (suppliedAddress) inner.address = suppliedAddress.toUpperCase();
        if (suppliedBranchAddress) inner.branchAddress = suppliedBranchAddress.toUpperCase();
      }
      if (suppliedBranchAddress) {
        if (bank === 'rbc') inner.bankBranch ||= suppliedBranchAddress;
        else inner.branchAddress ||= suppliedBranchAddress;
      }
      if (bank === 'bmo') {
        parsed.documentType = 'bmoStatement';
        parsed.bmoStatement = inner;
        const period = formatPeriod(bank, curYear, curMonth);
        inner.name ||= '';
        inner.address ||= '';
        inner.branchAddress ||= '';
        inner.branchName ||= 'BMO Bank of Montreal';
        inner.transitNo ||= '';
        inner.phone ||= '1-800-363-9992';
        inner.planName ||= 'Performance Chequing';
        inner.accountNo ||= '';
        inner.accountType ||= 'Primary Chequing Account';
        inner.periodEnd ||= period.to;
        inner.openingBalance = currentBalance;
        inner.transactions = (inner.transactions || []).map((tx) => ({
          date: tx.date || '',
          description: tx.description || tx.detail || '',
          deducted: Number(tx.deducted ?? tx.withdrawn ?? tx.debit ?? 0) || 0,
          added: Number(tx.added ?? tx.deposited ?? tx.credit ?? 0) || 0
        }));
      }
      if (bank === 'simplii') {
        parsed.documentType = 'simpliiStatement';
        parsed.simpliiStatement = inner;
        const period = formatPeriod(bank, curYear, curMonth);
        inner.name ||= '';
        inner.address ||= '';
        inner.accountNo ||= '';
        inner.statementPeriodFrom ||= period.from;
        inner.statementPeriodTo ||= period.to;
        inner.statementDate ||= period.to;
        inner.openingBalance = currentBalance;
        inner.transactions = (inner.transactions || []).map((tx) => ({
          transDate: tx.transDate || tx.date || '',
          effDate: tx.effDate || tx.transDate || tx.date || '',
          description: tx.description || tx.detail || '',
          fundsOut: Number(tx.fundsOut ?? tx.withdrawn ?? tx.debit ?? tx.deducted ?? 0) || 0,
          fundsIn: Number(tx.fundsIn ?? tx.deposited ?? tx.credit ?? tx.added ?? 0) || 0
        }));
      }
      if (inner.transactions) {
        inner.transactions = fixGenericTransactionDescriptions(inner.transactions, bank, province, localArea);
        inner.transactions = enforceCustomTransactions(inner.transactions, bank, curYear, curMonth, details, targetTxCount);
        inner.transactions = padTransactions(inner.transactions, targetTxCount, bank, curYear, curMonth, province, localArea);
        inner.transactions = sortTransactionsByDate(inner.transactions);
        inner.transactions = capGeneratedWithdrawals(inner.transactions, bank, currentBalance);
        if (targetClosingBalance !== null && i === numMonths - 1) {
          inner.transactions = rebalanceToTargetClosing(inner.transactions, bank, currentBalance, targetClosingBalance);
        }
      }

      currentBalance = calcClosing(currentBalance, inner.transactions || [], bank);
      presets.push({ ...parsed, _monthLabel: `${MONTH_FULL[curMonth - 1]} ${curYear}`, _closingBalance: currentBalance });

    } catch (err) {
      console.error(`Bank package error month ${i + 1}:`, err.message);
      return res.status(500).json({ error: `Generation failed at month ${i + 1}: ${err.message}`, partialPresets: presets });
    }

    curMonth++;
    if (curMonth > 12) { curMonth = 1; curYear++; }
  }

  res.json({ presets });
});
// ──────────────────────────────────────────────────────────────────────────────

module.exports = router;
