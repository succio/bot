require('dotenv').config();
const OpenAI = require('openai');
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Random 7-digit account number
const accountNum = String(Math.floor(1000000 + Math.random() * 9000000));
const accountNo = `95290-${accountNum}`;

// Target: Feb opens ~$8,000, ending Apr ~$22,000
// Biweekly pay $7,666.67 × 2/month = $15,333.34 income/month
// Spending ~$10,667/month
// Feb: 8,000 + 15,333 - 10,667 = 12,666
// Mar: 12,666 + 15,333 - 10,667 = 17,332
// Apr: 17,332 + 15,333 - 10,665 = 22,000

const MONTHS = [
  {
    label: 'February', yr: '26', num: '02',
    from: 'FEB 01/26', to: 'FEB 28/26',
    prefix: 'FEB', days: 28,
    pay1Day: 'FEB06', pay2Day: 'FEB20',
    openBal: 8000.00, targetClose: 12666.00,
  },
  {
    label: 'March', yr: '26', num: '03',
    from: 'MAR 01/26', to: 'MAR 31/26',
    prefix: 'MAR', days: 31,
    pay1Day: 'MAR06', pay2Day: 'MAR20',
    openBal: 12666.00, targetClose: 17332.00,
  },
  {
    label: 'April', yr: '26', num: '04',
    from: 'APR 01/26', to: 'APR 30/26',
    prefix: 'APR', days: 30,
    pay1Day: 'APR03', pay2Day: 'APR17',
    openBal: 17332.00, targetClose: 22000.00,
  },
];

function r2(n) { return Math.round(n * 100) / 100; }

function calcClosing(opening, txs) {
  let bal = opening;
  for (const t of txs) {
    bal += (Number(t.credit) || 0) - (Number(t.debit) || 0);
  }
  return r2(bal);
}

async function generateMonth(m) {
  const neededSpending = r2(m.openBal + 15333.34 - m.targetClose);
  const prompt = `Generate exactly 52 realistic banking transactions for ${m.label} 2026 for a resident of Burnaby, BC named JONATHAN BOILY.

Account details:
- Opening balance: $${m.openBal.toFixed(2)}
- Target closing balance: ~$${m.targetClose.toFixed(2)}
- Total income this month: $15,333.34 (2 biweekly payroll deposits)
- Total spending/debits should be approximately: $${neededSpending.toFixed(2)}

REQUIRED transactions (must be included exactly as specified):
1. ${m.pay1Day}: REGEN MEDIA PAYROLL credit $7,666.67
2. ${m.pay2Day}: REGEN MEDIA PAYROLL credit $7,666.67
3. ${m.prefix}01 or ${m.prefix}02: RENT / EFT PAYMENT debit ~$2,150.00
4. One BC HYDRO payment debit $130-170 mid-month
5. One TELUS MOBILITY payment debit $95-115

REMAINING 47 transactions — mix of realistic Burnaby day-to-day spending:
- Save-On-Foods Burnaby, Superstore, Safeway: 5-7 grocery trips ($60-180 each)
- Shell, Petro-Canada gas: 4-5 times ($65-95 each)
- Tim Hortons: 5-6 times ($8-18 each)
- Starbucks: 3-4 times ($7-15 each)
- Various Burnaby restaurants (Earls, White Spot, local spots): 4-5 times ($25-85)
- Amazon.ca: 2-3 orders ($30-120)
- Canadian Tire: 1-2 times ($40-150)
- Compass Card transit top-up: 1-2 times ($50-100)
- Netflix, Spotify or other subscriptions: 1-2 ($10-20)
- ATM CASH WITHDRAWAL: 2-3 times ($200-400)
- SEND E-TFR: 3-5 outgoing e-transfers ($100-500)
- E-TFR RECEIVED: 1-2 incoming e-transfers ($50-300)
- Shoppers Drug Mart: 2-3 times ($20-80)
- Winners or H&M: 1-2 times ($45-120)
- ICBC insurance payment: 1 time (~$185)
- Various other realistic Burnaby day-to-day merchants

All dates must fall within ${m.label} 2026. Date format: ${m.prefix} followed by 2-digit day (e.g. ${m.prefix}01, ${m.prefix}15).
Transactions must be in chronological order.

Return ONLY valid JSON:
{
  "transactions": [
    {"description": "string (max 30 chars, TD bank style ALL CAPS)", "debit": number_or_0, "credit": number_or_0, "date": "string"}
  ]
}

Rules:
- Credits = money IN (payroll, e-transfers received): set credit=amount, debit=0
- Debits = money OUT (purchases, payments, withdrawals): set debit=amount, credit=0
- Never have both debit and credit non-zero on same transaction
- Total credits - total debits should ≈ $${r2(m.targetClose - m.openBal).toFixed(2)} net change`;

  console.error(`Generating ${m.label}...`);
  const completion = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.4,
    max_tokens: 4096,
    response_format: { type: 'json_object' },
  });

  const parsed = JSON.parse(completion.choices[0].message.content);
  const txs = parsed.transactions || [];

  // Adjust last debit/credit to hit target balance exactly
  const actual = calcClosing(m.openBal, txs);
  const diff = r2(m.targetClose - actual);
  if (Math.abs(diff) > 0.01 && txs.length > 0) {
    // Find last debit transaction and adjust
    for (let i = txs.length - 1; i >= 0; i--) {
      if (diff > 0 && txs[i].debit > 0 && txs[i].debit > diff) {
        txs[i].debit = r2(txs[i].debit - diff);
        break;
      } else if (diff < 0 && txs[i].credit > 0 && txs[i].credit > Math.abs(diff)) {
        txs[i].credit = r2(txs[i].credit + diff);
        break;
      }
    }
  }

  return txs;
}

async function main() {
  const presets = [];
  let prevClose = null;

  for (const m of MONTHS) {
    if (prevClose !== null) m.openBal = prevClose;
    const txs = await generateMonth(m);
    const closing = calcClosing(m.openBal, txs);
    prevClose = closing;

    const preset = {
      documentType: 'statement',
      statement: {
        name: 'MR JONATHAN BOILY',
        address: '8881 ERIN AVE\nBURNABY BC V3N 4E8',
        branchAddress: '7155 KINGSWAY AVE,\nBURNABY, BC   V5E 2V1',
        branchNo: '95290',
        accountNo,
        statementFrom: m.from,
        statementTo: m.to,
        openingBalance: m.openBal,
        accountType: 'UNLIMITED',
        transactions: txs,
      },
    };

    presets.push({ preset, label: m.label, closing });
    console.error(`  ${m.label}: open=$${m.openBal.toFixed(2)} close=$${closing.toFixed(2)} txs=${txs.length}`);
  }

  // Output as JSON for the loader script
  console.log(JSON.stringify(presets));
}

main().catch(err => { console.error('ERROR:', err.message); process.exit(1); });
