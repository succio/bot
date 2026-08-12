function getAuthHeaders() {
  const token = localStorage.getItem('token');
  return token ? { 'Authorization': 'Bearer ' + token } : {};
}

async function consumeToken() {
  try {
    const res = await fetch('/api/credits/use-credit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 403 || (err.error && /credits|balance/i.test(err.error))) {
        window.alert('Your balance is too low. Please add more on the dashboard.');
        window.location.href = '/dashboard.html';
        throw new Error('NO_CREDITS');
      }
      throw new Error(err.error || 'Token consumption failed');
    }
    const data = await res.json();
    updateTokenDisplay(data.remainingBalance ?? data.remainingCredits);
    return true;
  } catch (e) {
    if (e.message === 'NO_CREDITS') throw e;
    console.error('consumeToken error', e);
    throw e;
  }
}

function updateTokenDisplay(count) {
  const el = document.getElementById('tokenCount');
  if (!el) return;
  const value = Number(count || 0);
  el.textContent = Number.isFinite(value)
    ? `$${value.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 2 })}`
    : count;
}

async function loadTokenCount() {
  try {
    const res = await fetch('/api/credits/me', { headers: getAuthHeaders() });
    if (res.ok) {
      const data = await res.json();
      updateTokenDisplay(data.balanceUsd ?? data.credits);
    }
  } catch (e) {
    console.error('loadTokenCount error', e);
  }
}

const CAD_FORMATTER = new Intl.NumberFormat("en-CA", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const LONG_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "long",
  day: "numeric",
});

const SHORT_MONTH_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "short",
  day: "2-digit",
});

const TEMPLATE_STORAGE_KEY = "hr-doc-suite-templates-v2";
const DRAFT_STORAGE_KEY = "hr-doc-suite-draft-v1";
let draftSaveTimer = null;
let suspendDraftSave = false;

/* ============================================================
   CANADIAN PAYROLL ENGINE
   Deterministic logic based on deduction ratios
   ============================================================ */
const PayrollEngine = (() => {
  const RATES = {
    federal: {
      non_qc: 0.1838,
      qc: 0.1530,
    },
    ei: {
      non_qc: 0.0079,
      qc: 0.0060,
    },
    cpp: {
      non_qc: 0.0292,
      qc: 0.0315,
    },
    qpip: 0.0036,
    provincial: {
      AB: 0.0963,
      BC: 0.0767,
      ON: 0.1011,
      QC: 0.1681,
    },
  };

  function normalizeProvince(province) {
    const key = String(province ?? "").trim().toUpperCase();
    if (key === "QUEBEC") return "QC";
    return RATES.provincial[key] ? key : "AB";
  }

  function isQuebec(province) {
    return normalizeProvince(province) === "QC";
  }

  function calculateGross({
    rate = 0,
    hours = 0,
    overtimeRate = 0,
    overtimeHours = 0,
    statutoryRate = 0,
    statutoryHours = 0,
  }) {
    const regular = rate * hours;
    const overtime = overtimeRate * overtimeHours;
    const statutory = statutoryRate * statutoryHours;

    return {
      regular,
      overtime,
      statutory,
      gross: regular + overtime + statutory,
    };
  }

  function calculateDeductions(gross, province) {
    const normalizedProvince = normalizeProvince(province);
    const qc = isQuebec(normalizedProvince);

    const ei = gross * (qc ? RATES.ei.qc : RATES.ei.non_qc);
    const cpp = gross * (qc ? RATES.cpp.qc : RATES.cpp.non_qc);
    const federal = gross * (qc ? RATES.federal.qc : RATES.federal.non_qc);
    const provincial = gross * RATES.provincial[normalizedProvince];
    const qpip = qc ? gross * RATES.qpip : 0;

    return {
      ei,
      cpp_or_qpp: cpp,
      federal,
      provincial,
      qpip,
      total: ei + cpp + federal + provincial + qpip,
      isQuebec: qc,
      province: normalizedProvince,
    };
  }

  function calculateNet(gross, deductions) {
    return gross - deductions.total;
  }

  function calculatePayPeriods(currentPayDate, frequency = "monthly") {
    const now = new Date(currentPayDate);
    if (Number.isNaN(now.getTime())) return 1;

    const start = new Date(now.getFullYear(), 0, 1);

    if (frequency === "monthly") {
      return now.getMonth() + 1;
    }

    if (frequency === "biweekly") {
      const diffDays = Math.floor((now - start) / (1000 * 60 * 60 * 24));
      return Math.max(1, Math.floor(diffDays / 14) + 1);
    }

    return 1;
  }

  function calculateYTD(thisPeriodValue, periods) {
    return thisPeriodValue * periods;
  }

  function runPayroll(input) {
    const {
      rate,
      hours,
      overtimeRate,
      overtimeHours,
      statutoryRate,
      statutoryHours,
      province,
      payDate,
      frequency = "monthly",
    } = input;

    const normalizedProvince = normalizeProvince(province);

    const earnings = calculateGross({
      rate,
      hours,
      overtimeRate,
      overtimeHours,
      statutoryRate,
      statutoryHours,
    });

    const deductions = calculateDeductions(earnings.gross, normalizedProvince);
    const net = calculateNet(earnings.gross, deductions);

    const periods = calculatePayPeriods(payDate, frequency);

    const ytd = {
      regular: calculateYTD(earnings.regular, periods),
      overtime: calculateYTD(earnings.overtime, periods),
      statutory: calculateYTD(earnings.statutory, periods),
      gross: calculateYTD(earnings.gross, periods),
      ei: calculateYTD(deductions.ei, periods),
      cpp_or_qpp: calculateYTD(deductions.cpp_or_qpp, periods),
      federal: calculateYTD(deductions.federal, periods),
      provincial: calculateYTD(deductions.provincial, periods),
      qpip: calculateYTD(deductions.qpip, periods),
      total_deductions: calculateYTD(deductions.total, periods),
      net: calculateYTD(net, periods),
    };

    return {
      earnings: {
        thisPeriod: earnings,
        ytd: {
          regular: ytd.regular,
          overtime: ytd.overtime,
          statutory: ytd.statutory,
          gross: ytd.gross,
        },
      },
      deductions: {
        thisPeriod: deductions,
        ytd: {
          ei: ytd.ei,
          cpp_or_qpp: ytd.cpp_or_qpp,
          federal: ytd.federal,
          provincial: ytd.provincial,
          qpip: ytd.qpip,
          total: ytd.total_deductions,
        },
      },
      net: {
        thisPeriod: net,
        ytd: ytd.net,
      },
      metadata: {
        periodsCalculated: periods,
        frequency,
        province: normalizedProvince,
        isQuebec: deductions.isQuebec,
      },
    };
  }

  return { runPayroll, getPayPeriods: calculatePayPeriods };
})();

const sampleData = {
  documentType: "payroll",
  companyName: "WILCO CONTRACTORS NORTHWEST INC.",
  brandText: "WILCO",
  brandColor: "#096250",
  payrollLogoDataUrl: "",
  designTemplate: "classic-blue",
  periodEnding: "2025-11-23",
  payDate: "2025-11-27",
  province: "AB",
  frequency: "monthly",
  employeeName: "CHAD LEPINE",
  employeeId: "",
  employeeAddress: "468 EDGEMONT RD NW\nCALGARY AB T6M 0Y7",
  earnings: [
    {
      label: "Regular",
      rate: 62.5,
      hours: 160,
      period: 10000,
      ytd: 110000,
    },
    {
      label: "Overtime",
      rate: 0,
      hours: 0,
      period: 0,
      ytd: 0,
    },
    {
      label: "Statutory",
      rate: 0,
      hours: 0,
      period: 0,
      ytd: 0,
    },
  ],
  deductions: [
    { label: "Federal Tax", period: 1838, ytd: 20218 },
    { label: "Provincial Tax", period: 963, ytd: 10593 },
    { label: "E.I*", period: 78.64, ytd: 865.04 },
    { label: "CPP*", period: 292, ytd: 3212 },
  ],
  benefits: [{ label: "Vacation Pay", period: 0, ytd: 0 }],
  vacHours: 0,
  sickHours: 0,
  notes:
    "*Federal Claim Code 2\n*Provincial Claim Code 2\n*Excluded from CPP taxable wages\n*Excluded from E.I taxable wages",
  employmentVerification: {
    date: "2026-02-06",
    employeeName: "Gabriel Turmel-Bussieres",
    startDate: "2022-02-15",
    employeeAddress: "Edmonton, AB",
    companyName: "Wolfe Construction",
    companyAddress: "Edmonton, Alberta",
    annualIncome: 97550,
    position: "Field Official",
    logoDataUrl: "",
  },
  cibcStatement: {
    name: "SEBASTIAN DIETRICH",
    address: "2092 MONTEITH DRIVE\nKAMLOOPS BC V2E 2G9",
    accountNo: "60-27195",
    branchTransit: "01732",
    statementFrom: "Nov 1",
    statementTo: "Nov 30, 2024",
    openingBalance: 6570.68,
    disclaimer: "The names shown are based on our current records, as of August 1, 2024. This statement does not reflect any changes in account holders and account holder names that may have occurred prior to this date.",
    transactions: [
      { date: "Nov 1", description: "E-TRANSFER    010992203422", detail: "Viji Niranj", withdrawn: 0, deposited: 86.40 },
      { date: "Nov 2", description: "E-TRANSFER    105050242254", detail: "Interac", withdrawn: 90.00, deposited: 0 },
      { date: "Nov 4", description: "E-TRANSFER    105050242251", detail: "Interac", withdrawn: 140.00, deposited: 0 },
      { date: "Nov 5", description: "E-TRANSFER PayDirect 105050242253", detail: "", withdrawn: 150.00, deposited: 0 },
      { date: "Nov 5", description: "E-TRANSFER    105050242254", detail: "Interac", withdrawn: 200.00, deposited: 0 },
      { date: "Nov 6", description: "E-TRANSFER    011040037939", detail: "Interac", withdrawn: 90.00, deposited: 0 },
      { date: "Nov 6", description: "E-TRANSFER    011040037939", detail: "Viji", withdrawn: 0, deposited: 400.00 },
      { date: "Nov 7", description: "E-TRANSFER    105052971632", detail: "Interac", withdrawn: 140.00, deposited: 0 },
      { date: "Nov 8", description: "E-TRANSFER    105052971634", detail: "Interac", withdrawn: 120.00, deposited: 0 },
      { date: "Nov 14", description: "E-TRANSFER    105089129001", detail: "Interac", withdrawn: 2500.00, deposited: 0 },
      { date: "Nov 15", description: "E-TRANSFER    011016563274", detail: "Interac", withdrawn: 0, deposited: 400.00 },
      { date: "Nov 16", description: "E-TRANSFER    011016563274", detail: "Interac", withdrawn: 900.00, deposited: 0 },
      { date: "Nov 17", description: "E-TRANSFER    011016563274", detail: "Interac", withdrawn: 180.00, deposited: 0 },
      { date: "Nov 26", description: "E-TRANSFER    011016563274", detail: "PayDirect", withdrawn: 2000.00, deposited: 0 },
      { date: "Nov 28", description: "SERVICE CHARGE", detail: "CAPPED MONTHLY FEE$16.95\nRECORD-KEEPING  N/A", withdrawn: 16.95, deposited: 0 },
      { date: "Nov 30", description: "COGECO CONNEXION", detail: "", withdrawn: 0, deposited: 4349.00 },
    ],
  },
  scotiaStatement: {
    name: "REPLICAS CORP",
    address: "31 HAYNES AVE NORTH\nYORK ON M3J 3P8",
    branchAddress: "97832\n2 ROBERT SPECK PARKWAY, SUITE 100\nMISSISSAUGA ONTARIO L4Z 1H8",
    accountNo: "97932 07842 98",
    accountType: "Your Preferred Package",
    statementFrom: "July 01, 2024",
    statementTo: "July 31, 2024",
    openingBalance: 4326.46,
    transactions: [
      { date: "Jul 01", description: "Point of sale purchase", detail: "Opos Uber Canada/ Ubertriptoronto ONCA", withdrawn: 15.19, deposited: 0 },
      { date: "Jul 02", description: "Deposit", detail: "68896109 Free Interac E-Transfer", withdrawn: 0, deposited: 100.00 },
      { date: "Jul 02", description: "Point of sale purchase", detail: "Apos TST-Vela T Toronto ONCA", withdrawn: 196.97, deposited: 0 },
      { date: "Jul 03", description: "Point of sale purchase", detail: "Opos Walmart Canada ONCA", withdrawn: 53.77, deposited: 0 },
      { date: "Jul 03", description: "Point of sale purchase", detail: "Opos Shoppers Drug M Torontoonca", withdrawn: 63.28, deposited: 0 },
      { date: "Jul 04", description: "Deposit", detail: "Payroll Construction ENP", withdrawn: 0, deposited: 3000.00 },
      { date: "Jul 10", description: "Error correction", detail: "Opos Uber Canada/ Ubertriptoronto ONCA", withdrawn: 0, deposited: 24.84 },
      { date: "Jul 11", description: "Error correction", detail: "Opos Uber Canada/ Ubertriptoronto ONCA", withdrawn: 0, deposited: 15.19 },
      { date: "Jul 12", description: "Point of sale purchase", detail: "Opos Walmart Canada ONCA", withdrawn: 12.71, deposited: 0 },
      { date: "Jul 14", description: "Point of sale purchase", detail: "Opos Shoppers Drug M Torontoonca", withdrawn: 25.25, deposited: 0 },
      { date: "Jul 15", description: "Point of sale purchase", detail: "Opos Uber* Trip Uber.Com/Caonca", withdrawn: 90.71, deposited: 0 },
      { date: "Jul 17", description: "Error correction", detail: "Opos Uber Canada/ Ubertriptoronto ONCA", withdrawn: 0, deposited: 108.18 },
      { date: "Jul 18", description: "Deposit", detail: "Payroll Construction ENP", withdrawn: 0, deposited: 3000.00 },
      { date: "Jul 19", description: "Point of sale purchase", detail: "Opos Shoppers Drug M Torontoonca", withdrawn: 308.22, deposited: 0 },
      { date: "Jul 20", description: "Withdrawal", detail: "94517610 Free Interac E-Transfer", withdrawn: 2500.00, deposited: 0 },
      { date: "Jul 22", description: "Deposit", detail: "94802041 Free Interac E-Transfer", withdrawn: 0, deposited: 50.00 },
      { date: "Jul 23", description: "Point of sale purchase", detail: "Opos Uber Canada/ Ubertriptoronto ONCA", withdrawn: 31.33, deposited: 0 },
      { date: "Jul 23", description: "Point of sale purchase", detail: "Opos Uber* Pending Uber.Com/Caonca", withdrawn: 20.50, deposited: 0 },
      { date: "Jul 24", description: "Point of sale purchase", detail: "Apos Shoppers Drug M Torontoonca", withdrawn: 21.55, deposited: 0 },
      { date: "Jul 24", description: "Error correction", detail: "Opos Uber* Trip +1866576103ONCA", withdrawn: 0, deposited: 23.61 },
      { date: "Jul 24", description: "Point of sale purchase", detail: "Opos Uber* Trip +1866576103ONCA", withdrawn: 42.01, deposited: 0 },
      { date: "Jul 25", description: "Point of sale purchase", detail: "Opos HudsonBay ONCA", withdrawn: 99.40, deposited: 0 },
      { date: "Jul 25", description: "Deposit", detail: "03146118 Free Interac E-Transfer", withdrawn: 0, deposited: 25.00 },
      { date: "Jul 26", description: "Misc. payment", detail: "Tpasc", withdrawn: 55.12, deposited: 0 },
      { date: "Jul 27", description: "Overdrawn handling charge", detail: "", withdrawn: 5.00, deposited: 0 },
      { date: "Jul 29", description: "Withdrawal", detail: "ATM Deposit", withdrawn: 1000.00, deposited: 0 },
      { date: "Jul 29", description: "Withdrawal", detail: "05445416 Free Interac E-Transfer", withdrawn: 1000.00, deposited: 0 },
      { date: "Jul 30", description: "Deposit", detail: "05836460 Free Interac E-Transfer", withdrawn: 0, deposited: 100.00 },
      { date: "Jul 30", description: "Point of sale purchase", detail: "Opos Uber Canada/ Ubereatstoronto ONCA", withdrawn: 19.88, deposited: 0 },
      { date: "Jul 30", description: "Withdrawal", detail: "05445336 Free Interac E-Transfer", withdrawn: 50.00, deposited: 0 },
    ],
  },
  rbcStatement: {
    name: "KATIE BLACKETTE",
    address: "40 MEADOWGLEN PLACE, #201\nSCARBOROUGH ON M1G 0A7",
    accountNo: "02782-5094431",
    accountType: "personal",
    bankBranch: "Royal Bank of Canada\n180 Wellington St W, Toronto, ON M5J 1J1",
    statementFrom: "Sep 01, 2024",
    statementTo: "Sep 30, 2024",
    openingBalance: 6307.14,
    transactions: [
      { date: "01 Sep", description: "Interac Etransfer", withdrawn: 19.00, deposited: 0 },
      { date: "01 Sep", description: "ATM deposit", withdrawn: 0, deposited: 1500.00 },
      { date: "01 Sep", description: "Interest paid", withdrawn: 35.99, deposited: 0 },
      { date: "02 Sep", description: "ATM withdrawal", withdrawn: 30.00, deposited: 0 },
      { date: "04 Sep", description: "Interac purchase -1361 - Nasr Foods Inc.", withdrawn: 470.14, deposited: 0 },
      { date: "05 Sep", description: "Overdraft interest", withdrawn: 47.50, deposited: 0 },
      { date: "06 Sep", description: "Cheque #30", withdrawn: 185.00, deposited: 0 },
      { date: "07 Sep", description: "Interac Etransfer", withdrawn: 0, deposited: 438.00 },
      { date: "08 Sep", description: "ATM withdrawal", withdrawn: 270.00, deposited: 0 },
      { date: "09 Sep", description: "ATM withdrawal", withdrawn: 750.00, deposited: 0 },
      { date: "10 Sep", description: "Interac purchase - 1361 - The Bay", withdrawn: 385.30, deposited: 0 },
      { date: "11 Sep", description: "Interac purchase - 1361 - Highland Farms", withdrawn: 49.45, deposited: 0 },
      { date: "13 Sep", description: "North Toronto Sleep Centre Payroll", withdrawn: 0, deposited: 2485.50 },
      { date: "13 Sep", description: "Interac Etransfer", withdrawn: 1000.00, deposited: 0 },
      { date: "14 Sep", description: "ATM deposit", withdrawn: 0, deposited: 1450.00 },
      { date: "15 Sep", description: "Interac Etransfer", withdrawn: 1538.00, deposited: 0 },
      { date: "15 Sep", description: "Interac Etransfer", withdrawn: 0, deposited: 508.00 },
      { date: "16 Sep", description: "Cheque #35", withdrawn: 400.00, deposited: 0 },
      { date: "19 Sep", description: "ATM deposit", withdrawn: 0, deposited: 2470.00 },
      { date: "20 Sep", description: "Interac purchase -1396 - Hudson Bay", withdrawn: 847.90, deposited: 0 },
      { date: "20 Sep", description: "ATM withdrawal", withdrawn: 380.00, deposited: 0 },
      { date: "22 Sep", description: "Cheque #36", withdrawn: 2102.00, deposited: 0 },
      { date: "22 Sep", description: "Interac Etransfer", withdrawn: 0, deposited: 508.00 },
      { date: "22 Sep", description: "ATM withdrawal", withdrawn: 180.00, deposited: 0 },
      { date: "23 Sep", description: "ATM withdrawal", withdrawn: 800.00, deposited: 0 },
      { date: "23 Sep", description: "Interac purchase - 1361 - The Bay", withdrawn: 429.55, deposited: 0 },
      { date: "24 Sep", description: "ATM deposit", withdrawn: 0, deposited: 1470.00 },
      { date: "24 Sep", description: "Interac purchase - 1361 - The Bay", withdrawn: 210.30, deposited: 0 },
      { date: "25 Sep", description: "Interac purchase - 1361 - Highland Farms", withdrawn: 29.50, deposited: 0 },
      { date: "26 Sep", description: "North Toronto Sleep Centre Payroll", withdrawn: 0, deposited: 2490.00 },
      { date: "27 Sep", description: "ATM withdrawal", withdrawn: 320.00, deposited: 0 },
      { date: "28 Sep", description: "ATM withdrawal", withdrawn: 200.00, deposited: 0 },
      { date: "29 Sep", description: "Interac purchase -1361 - Nasr Foods Inc.", withdrawn: 1330.91, deposited: 0 },
      { date: "30 Sep", description: "Interac purchase -1361 - Nasr Foods Inc.", withdrawn: 47.00, deposited: 0 },
    ],
  },
  bmoStatement: {
    name: "SUCCIO SUCCIO",
    address: "235 POLSEN ST\nTORONTO ON M2E 4X3",
    branchAddress: "2738\n3701 STRANDHERD DRIVE\nNEPEAN ONTARIO K2J 4G8",
    branchName: "BMO Bank of Montreal",
    transitNo: "2738",
    phone: "1-800-363-9992",
    planName: "Performance Chequing",
    accountNo: "208848484",
    accountType: "Primary Chequing Account",
    periodEnd: "Jul 31, 2026",
    openingBalance: 5000.00,
    transactions: [
      { date: "Jul 01", description: "Debit Card Purchase\nLoblaws Toronto ON", deducted: 120.00, added: 0 },
      { date: "Jul 03", description: "Debit Card Purchase\nMetro Toronto ON", deducted: 75.00, added: 0 },
      { date: "Jul 05", description: "Direct Deposit\nKLIPFOLIO INC PAYROLL DEPOSIT", deducted: 0, added: 3200.00 },
      { date: "Jul 07", description: "Debit Card Purchase\nShoppers Drug Mart Toronto ON", deducted: 45.00, added: 0 },
      { date: "Jul 09", description: "Debit Card Purchase\nTim Hortons Toronto ON", deducted: 10.00, added: 0 },
      { date: "Jul 11", description: "Debit Card Purchase\nToronto Hydro", deducted: 100.00, added: 0 },
      { date: "Jul 14", description: "Debit Card Purchase\nFreshCo Toronto ON", deducted: 60.00, added: 0 },
      { date: "Jul 18", description: "Direct Deposit\nKLIPFOLIO INC PAYROLL DEPOSIT", deducted: 0, added: 3200.00 },
      { date: "Jul 22", description: "Debit Card Purchase\nStarbucks Toronto ON", deducted: 15.00, added: 0 },
      { date: "Jul 26", description: "Debit Card Purchase\nTTC PRESTO Toronto ON", deducted: 50.00, added: 0 },
    ],
  },
  simpliiStatement: {
    name: "AMEER AYUBE",
    address: "308-134 YORK ST\nOTTAWA ON\nK1N 1K8",
    accountNo: "0293841750",
    statementPeriodFrom: "May 01, 2026",
    statementPeriodTo: "May 31, 2026",
    statementDate: "May 31, 2026",
    openingBalance: 6256.55,
    transactions: [
      { transDate: "May 01", effDate: "May 01", description: "INTERAC E-TRANSFER SEND - RENT", fundsOut: 1500.00, fundsIn: 0 },
      { transDate: "May 01", effDate: "May 01", description: "HYDRO OTTAWA", fundsOut: 82.47, fundsIn: 0 },
      { transDate: "May 02", effDate: "May 02", description: "LOBLAWS #1042 OTTAWA ON", fundsOut: 94.23, fundsIn: 0 },
      { transDate: "May 03", effDate: "May 03", description: "ROGERS WIRELESS", fundsOut: 89.99, fundsIn: 0 },
      { transDate: "May 05", effDate: "May 05", description: "METRO GROCERY #221 OTTAWA ON", fundsOut: 77.31, fundsIn: 0 },
      { transDate: "May 07", effDate: "May 07", description: "AMAZON.CA", fundsOut: 34.99, fundsIn: 0 },
      { transDate: "May 08", effDate: "May 08", description: "SHELL OIL 4892 OTTAWA ON", fundsOut: 62.50, fundsIn: 0 },
      { transDate: "May 09", effDate: "May 09", description: "INTERAC E-TRANSFER SEND ***BKL", fundsOut: 200.00, fundsIn: 0 },
      { transDate: "May 10", effDate: "May 10", description: "LOBLAWS #1042 OTTAWA ON", fundsOut: 88.54, fundsIn: 0 },
      { transDate: "May 11", effDate: "May 11", description: "PETRO CANADA 7821 OTTAWA ON", fundsOut: 55.00, fundsIn: 0 },
      { transDate: "May 13", effDate: "May 13", description: "AMAZON.CA", fundsOut: 67.43, fundsIn: 0 },
      { transDate: "May 14", effDate: "May 14", description: "NETFLIX.COM", fundsOut: 20.99, fundsIn: 0 },
      { transDate: "May 15", effDate: "May 15", description: "KLUE LABS INC PAYROLL", fundsOut: 0, fundsIn: 2627.39 },
      { transDate: "May 16", effDate: "May 16", description: "METRO GROCERY #221 OTTAWA ON", fundsOut: 65.72, fundsIn: 0 },
      { transDate: "May 17", effDate: "May 17", description: "INTERAC E-TRANSFER SEND ***WQX", fundsOut: 300.00, fundsIn: 0 },
      { transDate: "May 19", effDate: "May 19", description: "AMAZON.CA", fundsOut: 29.99, fundsIn: 0 },
      { transDate: "May 20", effDate: "May 20", description: "LOBLAWS #1042 OTTAWA ON", fundsOut: 102.67, fundsIn: 0 },
      { transDate: "May 22", effDate: "May 22", description: "INTERAC E-TRANSFER SEND ***PNQ", fundsOut: 250.00, fundsIn: 0 },
      { transDate: "May 23", effDate: "May 23", description: "PETRO CANADA 7821 OTTAWA ON", fundsOut: 65.00, fundsIn: 0 },
      { transDate: "May 27", effDate: "May 27", description: "AMAZON.CA", fundsOut: 89.50, fundsIn: 0 },
      { transDate: "May 29", effDate: "May 29", description: "KLUE LABS INC PAYROLL", fundsOut: 0, fundsIn: 2627.39 },
    ],
  },
  statement: {
    name: "MR TREQUIL SKENE",
    address: "142 SEGUIN ST\nRICHMOND HILL ON L4E 1N2",
    branchAddress: "9350 YONGE ST,\nRICHMOND HILL, ON   L4C 5G2",
    branchNo: "17912",
    accountNo: "17912-6171925",
    statementFrom: "OCT 01/25",
    statementTo: "DEC 31/25",
    openingBalance: 2784.53,
    accountType: "UNLIMITED",
    transactions: [
      { description: "SHOPPERS DRUG MART #13_K", debit: 217.79, credit: 0, date: "OCT01" },
      { description: "SHOPPERS DRUG MART #13_Q", debit: 324.81, credit: 0, date: "OCT02" },
      { description: "SOW RENTALS", debit: 0, credit: 2096.77, date: "OCT03" },
      { description: "SHELL OIL 5753", debit: 121.11, credit: 0, date: "OCT05" },
      { description: "SEND E-TFR ***QCA", debit: 183.78, credit: 0, date: "OCT06" },
      { description: "UBER EATS", debit: 113.81, credit: 0, date: "OCT07" },
      { description: "SEND E-TFR ***CQC", debit: 261.38, credit: 0, date: "OCT08" },
      { description: "SEND E-TFR ***CJV", debit: 258.36, credit: 0, date: "OCT09" },
      { description: "METRO GROCERY", debit: 256.47, credit: 0, date: "OCT10" },
      { description: "UBER EATS", debit: 273.01, credit: 0, date: "OCT11" },
      { description: "MCDONALD'S #807_F", debit: 90.49, credit: 0, date: "OCT12" },
      { description: "SEND E-TFR ***BZQ", debit: 238.44, credit: 0, date: "OCT13" },
      { description: "SEND E-TFR ***DSA", debit: 279.7, credit: 0, date: "OCT14" },
      { description: "SHOPPERS DRUG MART #13_K", debit: 294.59, credit: 0, date: "OCT15" },
      { description: "UBERCANADAUBE_V", debit: 119.14, credit: 0, date: "OCT16" },
      { description: "E-TRANSFER***YTR", debit: 0, credit: 156.63, date: "OCT17" },
      { description: "SOW RENTALS", debit: 0, credit: 2096.77, date: "OCT18" },
      { description: "UBER E-TFR***CVQ", debit: 262.75, credit: 0, date: "OCT19" },
      { description: "SENDCANADAUBE_V", debit: 48.95, credit: 0, date: "OCT20" },
      { description: "SEND E-TFR***SZQ", debit: 321.09, credit: 0, date: "OCT21" },
      { description: "SEND E-TFR***GBV", debit: 359.48, credit: 0, date: "OCT22" },
      { description: "UBERCANADAUBE_V", debit: 103.77, credit: 0, date: "OCT23" },
      { description: "SEND E-TFR***JJE", debit: 83.44, credit: 0, date: "OCT24" },
      { description: "SEND E-TFR***JVV", debit: 149.57, credit: 0, date: "OCT25" },
      { description: "E-TRANSFER***LCQ", debit: 0, credit: 84.59, date: "OCT26" },
      { description: "E-TRANSFER***LCV", debit: 0, credit: 272.31, date: "OCT27" },
      { description: "SEND E-TFR***WQC", debit: 176, credit: 0, date: "OCT28" },
      { description: "SEND E-TFR***SAK", debit: 349.34, credit: 0, date: "OCT29" },
      { description: "APPLE E-TFR***NKK", debit: 290.02, credit: 0, date: "NOV01" },
      { description: "SEND E-TFR***JFL", debit: 561.17, credit: 0, date: "NOV03" },
      { description: "BALANCE FORWARD", debit: 0, credit: 0, date: "NOV04" },
      { description: "SEND E-TFR***QZA", debit: 289.65, credit: 0, date: "NOV06" },
      { description: "HARVEST REST #210_Y", debit: 213.23, credit: 0, date: "NOV07" },
      { description: "SEND E-TFR***CAA", debit: 370.04, credit: 0, date: "NOV09" },
      { description: "FRESCHO #333", debit: 394, credit: 0, date: "NOV10" },
      { description: "UBERCANADAUBE_V", debit: 242.98, credit: 0, date: "NOV12" },
      { description: "SEND E-TFR***NJL", debit: 51.29, credit: 0, date: "NOV14" },
      { description: "SEND E-TFR***JJE", debit: 243.62, credit: 0, date: "NOV15" },
      { description: "SEND E-TFR***FIJ", debit: 246.21, credit: 0, date: "NOV16" },
      { description: "SEND E-TFR***ZNV", debit: 301.66, credit: 0, date: "NOV18" },
    ],
  },
  noaStatement: {
    name: "TREQUIL SKENE",
    address: "142 SEGUIN ST\nRICHMOND HILL ON L4E 1N2",
    location: "RICHMOND HILL ON L4E1 N2",
    sin: "XXX XX5 016",
    taxYear: "2024",
    dateIssued: "Jun 03, 2025",
    refNumber: "0075022",
    refCode: "ZK25ZG45",
    accountNumber: "",
    annualIncome: 70200.00,
    taxDeducted: 15678.00,
    commissioner: "Bob Hamilton",
    explanation: "We changed your instalments on your return to $0.00 to agree with the credit available in your 2023 instalment account. The balance in your 2024 instalment account is $0.00.\n\nIf you have any questions about your assessment, please call our Individual Tax and Enquiries line at 1-800-959-8281.",
    summaryRows: [],
  },
  scotiaVoidCheck: {
    name: "Mr Carter Tait",
    address: "10045 111 STREET 1303\nEDMONTON, AB T5K2M5",
    transit: "42309",
    institution: "002",
    account: "0520624",
  },
};

let payrollLogoDataUrl = "";
let employmentLogoDataUrl = "";

const elements = {
  documentTypeSelect: document.getElementById("documentTypeSelect"),
  payrollControls: document.getElementById("payrollControls"),
  employmentControls: document.getElementById("employmentControls"),
  creditControls: document.getElementById("creditControls"),
  noaControls: document.getElementById("noaControls"),
  t4Controls: document.getElementById("t4Controls"),
  statementControls: document.getElementById("statementControls"),
  paystub: document.getElementById("paystub"),
  employmentLetter: document.getElementById("employmentLetter"),
  creditReport: document.getElementById("creditReport"),
  noaReport: document.getElementById("noaReport"),
  statementReport: document.getElementById("statementReport"),
  companyName: document.getElementById("companyName"),
  brandText: document.getElementById("brandText"),
  brandColor: document.getElementById("brandColor"),
  payrollLogoFile: document.getElementById("payrollLogoFile"),
  designTemplate: document.getElementById("designTemplate"),
  periodEnding: document.getElementById("periodEnding"),
  payDate: document.getElementById("payDate"),
  province: document.getElementById("province"),
  frequency: document.getElementById("frequency"),
  employeeName: document.getElementById("employeeName"),
  employeeId: document.getElementById("employeeId"),
  employeeAddress: document.getElementById("employeeAddress"),
  vacHours: document.getElementById("vacHours"),
  sickHours: document.getElementById("sickHours"),
  notes: document.getElementById("notes"),
  earningsTable: document.querySelector("#earningsTable tbody"),
  deductionsTable: document.querySelector("#deductionsTable tbody"),
  benefitsTable: document.querySelector("#benefitsTable tbody"),
  uiPayPeriods: document.getElementById("uiPayPeriods"),
  uiGrossPay: document.getElementById("uiGrossPay"),
  uiTotalDeductions: document.getElementById("uiTotalDeductions"),
  uiNetPay: document.getElementById("uiNetPay"),
  uiReadiness: document.getElementById("uiReadiness"),
  addRegularBtn: document.getElementById("addRegularBtn"),
  addOvertimeBtn: document.getElementById("addOvertimeBtn"),
  addBonusBtn: document.getElementById("addBonusBtn"),
  addEarningBtn: document.getElementById("addEarningBtn"),
  addDeductionBtn: document.getElementById("addDeductionBtn"),
  addBenefitBtn: document.getElementById("addBenefitBtn"),
  printBtn: document.getElementById("printBtn"),
  loadSampleBtn: document.getElementById("loadSampleBtn"),
  saveTemplateBtn: document.getElementById("saveTemplateBtn"),
  updateTemplateBtn: document.getElementById("updateTemplateBtn"),
  deleteTemplateBtn: document.getElementById("deleteTemplateBtn"),
  templateNameInput: document.getElementById("templateNameInput"),
  templateMeta: document.getElementById("templateMeta"),
  loadTemplateBtn: document.getElementById("loadTemplateBtn"),
  templateSelect: document.getElementById("templateSelect"),
  exportJsonBtn: document.getElementById("exportJsonBtn"),
  importJson: document.getElementById("importJson"),
  quickSaveBtn: document.getElementById("quickSaveBtn"),
  uiDocStatus: document.getElementById("uiDocStatus"),
  pvPayrollLogoImage: document.getElementById("pvPayrollLogoImage"),
  pvBrandFallback: document.getElementById("pvBrandFallback"),
  pvBrandText: document.getElementById("pvBrandText"),
  pvPeriodEnding: document.getElementById("pvPeriodEnding"),
  pvPayDate: document.getElementById("pvPayDate"),
  pvEmployeeAddress: document.getElementById("pvEmployeeAddress"),
  pvEarningsBody: document.getElementById("pvEarningsBody"),
  pvGrossThis: document.getElementById("pvGrossThis"),
  pvGrossYtd: document.getElementById("pvGrossYtd"),
  pvDeductionsBody: document.getElementById("pvDeductionsBody"),
  pvBenefitsBody: document.getElementById("pvBenefitsBody"),
  pvVacHours: document.getElementById("pvVacHours"),
  pvSickHours: document.getElementById("pvSickHours"),
  pvDepositAmount: document.getElementById("pvDepositAmount"),
  pvDepositDate: document.getElementById("pvDepositDate"),
  pvNetThis: document.getElementById("pvNetThis"),
  pvNetYtd: document.getElementById("pvNetYtd"),
  pvNotes: document.getElementById("pvNotes"),
  pvCompanyName: document.getElementById("pvCompanyName"),
  pvPayee: document.getElementById("pvPayee"),
  pvAmountWords: document.getElementById("pvAmountWords"),
  pvAmountNumber: document.getElementById("pvAmountNumber"),
  evDate: document.getElementById("evDate"),
  evEmployeeName: document.getElementById("evEmployeeName"),
  evStartDate: document.getElementById("evStartDate"),
  evEmployeeAddress: document.getElementById("evEmployeeAddress"),
  evCompanyName: document.getElementById("evCompanyName"),
  evCompanyAddress: document.getElementById("evCompanyAddress"),
  evAnnualIncome: document.getElementById("evAnnualIncome"),
  evPosition: document.getElementById("evPosition"),
  evLogoFile: document.getElementById("evLogoFile"),
  crName: document.getElementById("crName"),
  crReferenceNumber: document.getElementById("crReferenceNumber"),
  crRequestDate: document.getElementById("crRequestDate"),
  crDob: document.getElementById("crDob"),
  crSin: document.getElementById("crSin"),
  crPhone: document.getElementById("crPhone"),
  crAddress1: document.getElementById("crAddress1"),
  crAddress2: document.getElementById("crAddress2"),
  crAka: document.getElementById("crAka"),
  crPersonalFileNumber: document.getElementById("crPersonalFileNumber"),
  crCurrentReportedDate: document.getElementById("crCurrentReportedDate"),
  crCurrentAddress: document.getElementById("crCurrentAddress"),
  crCurrentCity: document.getElementById("crCurrentCity"),
  crCurrentProvince: document.getElementById("crCurrentProvince"),
  crCurrentPostal: document.getElementById("crCurrentPostal"),
  crPreviousReportedDate: document.getElementById("crPreviousReportedDate"),
  crPreviousAddress: document.getElementById("crPreviousAddress"),
  crPreviousCity: document.getElementById("crPreviousCity"),
  crPreviousProvince: document.getElementById("crPreviousProvince"),
  crPreviousPostal: document.getElementById("crPreviousPostal"),
  crCreditScore: document.getElementById("crCreditScore"),
  crLogoFile: document.getElementById("crLogoFile"),
  noaName: document.getElementById("noaName"),
  noaAddress: document.getElementById("noaAddress"),
  noaSin: document.getElementById("noaSin"),
  noaTaxYear: document.getElementById("noaTaxYear"),
  noaDateIssued: document.getElementById("noaDateIssued"),
  noaLocation: document.getElementById("noaLocation"),
  noaRefNumber: document.getElementById("noaRefNumber"),
  noaRefCode: document.getElementById("noaRefCode"),
  noaAccountNumber: document.getElementById("noaAccountNumber"),
  noaAnnualIncome: document.getElementById("noaAnnualIncome"),
  noaTaxDeducted: document.getElementById("noaTaxDeducted"),
  noaBalanceOverride: document.getElementById("noaBalanceOverride"),
  noaBalanceOverrideCrdr: document.getElementById("noaBalanceOverrideCrdr"),
  noaCommissioner: document.getElementById("noaCommissioner"),
  noaExplanation: document.getElementById("noaExplanation"),
  addNoaRowBtn: document.getElementById("addNoaRowBtn"),
  noaSummaryTable: document.querySelector("#noaSummaryTable tbody"),
  stName: document.getElementById("stName"),
  stAddress: document.getElementById("stAddress"),
  stBranchAddress: document.getElementById("stBranchAddress"),
  stBranchNo: document.getElementById("stBranchNo"),
  stAccountNo: document.getElementById("stAccountNo"),
  stFrom: document.getElementById("stFrom"),
  stTo: document.getElementById("stTo"),
  stOpeningBalance: document.getElementById("stOpeningBalance"),
  stAccountType: document.getElementById("stAccountType"),
  addStatementRowBtn: document.getElementById("addStatementRowBtn"),
  statementTransactionsTable: document.querySelector("#statementTransactionsTable tbody"),
  scotiaStatementControls: document.getElementById("scotiaStatementControls"),
  scotiaReport: document.getElementById("scotiaReport"),
  scName: document.getElementById("scName"),
  scAddress: document.getElementById("scAddress"),
  scBranchAddress: document.getElementById("scBranchAddress"),
  scAccountNo: document.getElementById("scAccountNo"),
  scAccountType: document.getElementById("scAccountType"),
  scFrom: document.getElementById("scFrom"),
  scTo: document.getElementById("scTo"),
  scOpeningBalance: document.getElementById("scOpeningBalance"),
  addScotiaRowBtn: document.getElementById("addScotiaRowBtn"),
  scotiaTransactionsTable: document.querySelector("#scotiaTransactionsTable tbody"),
  cibcStatementControls: document.getElementById("cibcStatementControls"),
  cibcReport: document.getElementById("cibcReport"),
  cbName: document.getElementById("cbName"),
  cbAddress: document.getElementById("cbAddress"),
  cbAccountNo: document.getElementById("cbAccountNo"),
  cbBranchTransit: document.getElementById("cbBranchTransit"),
  cbFrom: document.getElementById("cbFrom"),
  cbTo: document.getElementById("cbTo"),
  cbOpeningBalance: document.getElementById("cbOpeningBalance"),
  cbDisclaimer: document.getElementById("cbDisclaimer"),
  addCibcRowBtn: document.getElementById("addCibcRowBtn"),
  cibcTransactionsTable: document.querySelector("#cibcTransactionsTable tbody"),
  rbcStatementControls: document.getElementById("rbcStatementControls"),
  rbcReport: document.getElementById("rbcReport"),
  rbName: document.getElementById("rbName"),
  rbAddress: document.getElementById("rbAddress"),
  rbAccountNo: document.getElementById("rbAccountNo"),
  rbAccountType: document.getElementById("rbAccountType"),
  rbBankBranch: document.getElementById("rbBankBranch"),
  rbFrom: document.getElementById("rbFrom"),
  rbTo: document.getElementById("rbTo"),
  rbOpeningBalance: document.getElementById("rbOpeningBalance"),
  addRbcRowBtn: document.getElementById("addRbcRowBtn"),
  rbcTransactionsTable: document.querySelector("#rbcTransactionsTable tbody"),
  simpliiStatementControls: document.getElementById("simpliiStatementControls"),
  simpliiReport: document.getElementById("simpliiReport"),
  sfName: document.getElementById("sfName"),
  sfAddress: document.getElementById("sfAddress"),
  sfAccountNo: document.getElementById("sfAccountNo"),
  sfFrom: document.getElementById("sfFrom"),
  sfTo: document.getElementById("sfTo"),
  sfStatementDate: document.getElementById("sfStatementDate"),
  sfOpeningBalance: document.getElementById("sfOpeningBalance"),
  addSimpliiRowBtn: document.getElementById("addSimpliiRowBtn"),
  simpliiTransactionsTable: document.querySelector("#simpliiTransactionsTable tbody"),
  bmoStatementControls: document.getElementById("bmoStatementControls"),
  bmoReport: document.getElementById("bmoReport"),
  bmName: document.getElementById("bmName"),
  bmAddress: document.getElementById("bmAddress"),
  bmBranchAddress: document.getElementById("bmBranchAddress"),
  bmBranchName: document.getElementById("bmBranchName"),
  bmTransitNo: document.getElementById("bmTransitNo"),
  bmPhone: document.getElementById("bmPhone"),
  bmPlanName: document.getElementById("bmPlanName"),
  bmAccountNo: document.getElementById("bmAccountNo"),
  bmAccountType: document.getElementById("bmAccountType"),
  bmPeriodEnd: document.getElementById("bmPeriodEnd"),
  bmOpeningBalance: document.getElementById("bmOpeningBalance"),
  addBmoRowBtn: document.getElementById("addBmoRowBtn"),
  bmoTransactionsTable: document.querySelector("#bmoTransactionsTable tbody"),
  pvEvDate: document.getElementById("pvEvDate"),
  pvEvEmployeeNameUpper: document.getElementById("pvEvEmployeeNameUpper"),
  pvEvCompanyNameTop: document.getElementById("pvEvCompanyNameTop"),
  pvEvParagraph1: document.getElementById("pvEvParagraph1"),
  pvEvParagraph2: document.getElementById("pvEvParagraph2"),
  pvEvParagraph3: document.getElementById("pvEvParagraph3"),
  pvEvParagraph4: document.getElementById("pvEvParagraph4"),
  pvEvCompanyNameBottom: document.getElementById("pvEvCompanyNameBottom"),
  pvEvLogoImage: document.getElementById("pvEvLogoImage"),
  pvEvWatermark: document.getElementById("pvEvWatermark"),
  pvCrLogoPage1: document.getElementById("pvCrLogoPage1"),
  pvCrLogoPage2: document.getElementById("pvCrLogoPage2"),
  pvCrNameTop: document.getElementById("pvCrNameTop"),
  pvCrAddress1Top: document.getElementById("pvCrAddress1Top"),
  pvCrAddress2Top: document.getElementById("pvCrAddress2Top"),
  pvCrReference: document.getElementById("pvCrReference"),
  pvCrNameMid: document.getElementById("pvCrNameMid"),
  pvCrRequestDateInline: document.getElementById("pvCrRequestDateInline"),
  pvCrRequestDateTop: document.getElementById("pvCrRequestDateTop"),
  pvCrCurrentName: document.getElementById("pvCrCurrentName"),
  pvCrAka: document.getElementById("pvCrAka"),
  pvCrPfn: document.getElementById("pvCrPfn"),
  pvCrDob: document.getElementById("pvCrDob"),
  pvCrSin: document.getElementById("pvCrSin"),
  pvCrPhone: document.getElementById("pvCrPhone"),
  pvCrCurrentReported: document.getElementById("pvCrCurrentReported"),
  pvCrCurrentAddress: document.getElementById("pvCrCurrentAddress"),
  pvCrCurrentCity: document.getElementById("pvCrCurrentCity"),
  pvCrCurrentProvince: document.getElementById("pvCrCurrentProvince"),
  pvCrCurrentPostal: document.getElementById("pvCrCurrentPostal"),
  pvCrPreviousReported: document.getElementById("pvCrPreviousReported"),
  pvCrPreviousAddress: document.getElementById("pvCrPreviousAddress"),
  pvCrPreviousCity: document.getElementById("pvCrPreviousCity"),
  pvCrPreviousProvince: document.getElementById("pvCrPreviousProvince"),
  pvCrPreviousPostal: document.getElementById("pvCrPreviousPostal"),
  pvCrScoreDate: document.getElementById("pvCrScoreDate"),
  pvCrScore: document.getElementById("pvCrScore"),
  pvCrScoreLeft: document.getElementById("pvCrScoreLeft"),
  pvNoaTopLocation: document.getElementById("pvNoaTopLocation"),
  pvNoaRefCodeTop: document.getElementById("pvNoaRefCodeTop"),
  pvNoaSinTop: document.getElementById("pvNoaSinTop"),
  pvNoaTaxYearTop: document.getElementById("pvNoaTaxYearTop"),
  pvNoaDateIssuedTop: document.getElementById("pvNoaDateIssuedTop"),
  pvNoaNameMail: document.getElementById("pvNoaNameMail"),
  pvNoaTaxYearBody: document.getElementById("pvNoaTaxYearBody"),
  pvNoaBalanceSentence: document.getElementById("pvNoaBalanceSentence"),
  pvNoaDepositSentence: document.getElementById("pvNoaDepositSentence"),
  pvNoaAccountLabel: document.getElementById("pvNoaAccountLabel"),
  pvNoaRefundAmount: document.getElementById("pvNoaRefundAmount"),
  pvNoaNameMail2: document.getElementById("pvNoaNameMail2"),
  pvNoaSinTop2: document.getElementById("pvNoaSinTop2"),
  pvNoaTaxYearTop2: document.getElementById("pvNoaTaxYearTop2"),
  pvNoaExplanation1: document.getElementById("pvNoaExplanation1"),
  pvStBranchAddress: document.getElementById("pvStBranchAddress"),
  pvStBranchAddress2: document.getElementById("pvStBranchAddress2"),
  pvStNamePage1: document.getElementById("pvStNamePage1"),
  pvStAddressLine1Page1: document.getElementById("pvStAddressLine1Page1"),
  pvStAddressLine2Page1: document.getElementById("pvStAddressLine2Page1"),
  pvStBranchNo1: document.getElementById("pvStBranchNo1"),
  pvStAccountNo1: document.getElementById("pvStAccountNo1"),
  pvStAccountType1: document.getElementById("pvStAccountType1"),
  pvStFromTo1: document.getElementById("pvStFromTo1"),
  pvStRowsPage1: document.getElementById("pvStRowsPage1"),
  pvStTotalDebit1: document.getElementById("pvStTotalDebit1"),
  pvStTotalCredit1: document.getElementById("pvStTotalCredit1"),
  pvStAccountTypeFees1: document.getElementById("pvStAccountTypeFees1"),
  pvStNamePage2: document.getElementById("pvStNamePage2"),
  pvStAddressLine1Page2: document.getElementById("pvStAddressLine1Page2"),
  pvStAddressLine2Page2: document.getElementById("pvStAddressLine2Page2"),
  pvStBranchNo2: document.getElementById("pvStBranchNo2"),
  pvStAccountNo2: document.getElementById("pvStAccountNo2"),
  pvStAccountType2: document.getElementById("pvStAccountType2"),
  pvStFromTo2: document.getElementById("pvStFromTo2"),
  pvStRowsPage2: document.getElementById("pvStRowsPage2"),
  pvStTotalDebit2: document.getElementById("pvStTotalDebit2"),
  pvStTotalCredit2: document.getElementById("pvStTotalCredit2"),
  pvStAccountTypeFees2: document.getElementById("pvStAccountTypeFees2"),
  bmoVoidControls: document.getElementById("bmoVoidControls"),
  scotiaVoidControls: document.getElementById("scotiaVoidControls"),
  rbcVoidControls: document.getElementById("rbcVoidControls"),
  tdVoidControls: document.getElementById("tdVoidControls"),
  cibcVoidControls: document.getElementById("cibcVoidControls"),
  bmoVoidReport: document.getElementById("bmoVoidReport"),
  scotiaVoidReport: document.getElementById("scotiaVoidReport"),
  rbcVoidReport: document.getElementById("rbcVoidReport"),
  tdVoidReport: document.getElementById("tdVoidReport"),
  cibcVoidReport: document.getElementById("cibcVoidReport"),
  bmoVoidName: document.getElementById("bmoVoidName"),
  bmoVoidAddress: document.getElementById("bmoVoidAddress"),
  bmoVoidTransit: document.getElementById("bmoVoidTransit"),
  bmoVoidInstitution: document.getElementById("bmoVoidInstitution"),
  bmoVoidAccount: document.getElementById("bmoVoidAccount"),
  scotiaVoidName: document.getElementById("scotiaVoidName"),
  scotiaVoidAddress: document.getElementById("scotiaVoidAddress"),
  scotiaVoidTransit: document.getElementById("scotiaVoidTransit"),
  scotiaVoidInstitution: document.getElementById("scotiaVoidInstitution"),
  scotiaVoidAccount: document.getElementById("scotiaVoidAccount"),
  rbcVoidName: document.getElementById("rbcVoidName"),
  rbcVoidTransit: document.getElementById("rbcVoidTransit"),
  rbcVoidInstitution: document.getElementById("rbcVoidInstitution"),
  rbcVoidAccount: document.getElementById("rbcVoidAccount"),
  tdVoidCustomerName: document.getElementById("tdVoidCustomerName"),
  tdVoidCustomerAddress: document.getElementById("tdVoidCustomerAddress"),
  tdVoidTransit: document.getElementById("tdVoidTransit"),
  tdVoidInstitution: document.getElementById("tdVoidInstitution"),
  tdVoidAccount: document.getElementById("tdVoidAccount"),
  tdVoidDesignation: document.getElementById("tdVoidDesignation"),
  tdVoidSwiftBic: document.getElementById("tdVoidSwiftBic"),
  tdVoidBranchAddress: document.getElementById("tdVoidBranchAddress"),
  tdVoidCustomerAccountNumber: document.getElementById("tdVoidCustomerAccountNumber"),
  cibcVoidName: document.getElementById("cibcVoidName"),
  cibcVoidAddress: document.getElementById("cibcVoidAddress"),
  cibcVoidDate: document.getElementById("cibcVoidDate"),
  cibcVoidTransit: document.getElementById("cibcVoidTransit"),
  cibcVoidInstitution: document.getElementById("cibcVoidInstitution"),
  cibcVoidAccount: document.getElementById("cibcVoidAccount"),
  cibcVoidBranchAddress: document.getElementById("cibcVoidBranchAddress"),
  bmoVoidPage: document.getElementById("bmoVoidPage"),
  bmoVoidBgImage: document.getElementById("bmoVoidBgImage"),
  bmoVoidOverlay: document.getElementById("bmoVoidOverlay"),
  scotiaVoidPage: document.getElementById("scotiaVoidPage"),
  scotiaVoidBgImage: document.getElementById("scotiaVoidBgImage"),
  scotiaVoidOverlay: document.getElementById("scotiaVoidOverlay"),
  rbcVoidPage: document.getElementById("rbcVoidPage"),
  rbcVoidBgImage: document.getElementById("rbcVoidBgImage"),
  rbcVoidOverlay: document.getElementById("rbcVoidOverlay"),
  tdVoidPage: document.getElementById("tdVoidPage"),
  tdVoidBgImage: document.getElementById("tdVoidBgImage"),
  tdVoidOverlay: document.getElementById("tdVoidOverlay"),
  cibcVoidPage1: document.getElementById("cibcVoidPage1"),
  cibcVoidBgImage1: document.getElementById("cibcVoidBgImage1"),
  cibcVoidOverlay1: document.getElementById("cibcVoidOverlay1"),
  cibcVoidPage2: document.getElementById("cibcVoidPage2"),
  cibcVoidBgImage2: document.getElementById("cibcVoidBgImage2"),
  cibcVoidOverlay2: document.getElementById("cibcVoidOverlay2"),
};

function toNumber(value) {
  const normalized = String(value ?? "")
    .replace(/,/g, "")
    .trim();
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeText(value) {
  return String(value ?? "").trim();
}

function escapeAttr(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/\"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "&#39;");
}

function formatMoney(value) {
  return CAD_FORMATTER.format(value || 0);
}


function fmtShortDate(value) {
  const text = safeText(value);
  const match = text.match(/\b([A-Za-z]{3})\s+0?(\d{1,2})/);
  return match ? `${match[1]} ${match[2].padStart(2, "0")}` : text;
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return DATE_FORMATTER.format(date);
}

function formatLongDate(value) {
  if (!value) return "";
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return LONG_DATE_FORMATTER.format(date);
}

function formatSlashDate(value) {
  if (!value) return "";
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}/${month}/${day}`;
}

function wordsUnderThousand(number) {
  const units = [
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
  ];
  const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

  if (number < 20) return units[number];
  if (number < 100) {
    const ten = Math.floor(number / 10);
    const unit = number % 10;
    return unit ? `${tens[ten]}-${units[unit]}` : tens[ten];
  }

  const hundred = Math.floor(number / 100);
  const remainder = number % 100;
  if (!remainder) return `${units[hundred]} hundred`;
  return `${units[hundred]} hundred ${wordsUnderThousand(remainder)}`;
}

function numberToWords(value) {
  const absValue = Math.abs(value);
  const totalCents = Math.round(absValue * 100);
  const dollars = Math.floor(totalCents / 100);
  const cents = totalCents % 100;

  if (dollars === 0) {
    return `zero dollars and ${cents.toString().padStart(2, "0")} cents`;
  }

  const chunks = [
    { value: 1_000_000_000, label: "billion" },
    { value: 1_000_000, label: "million" },
    { value: 1_000, label: "thousand" },
  ];

  let remainder = dollars;
  const parts = [];

  for (const chunk of chunks) {
    if (remainder >= chunk.value) {
      const count = Math.floor(remainder / chunk.value);
      parts.push(`${wordsUnderThousand(count)} ${chunk.label}`);
      remainder %= chunk.value;
    }
  }

  if (remainder) {
    parts.push(wordsUnderThousand(remainder));
  }

  const sentence = parts.join(" ");
  return `${sentence} dollars and ${cents.toString().padStart(2, "0")} cents`;
}

function slugify(value) {
  return safeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function cloneData(value) {
  return JSON.parse(JSON.stringify(value));
}

const GROUP_REQUIREMENTS = {
  payrollControls: {
    "Company + Employee": ["companyName", "employeeName", "periodEnding", "payDate"],
    Earnings: ["__earnings"],
  },
  employmentControls: {
    "Employment Verification Letter": [
      "evDate",
      "evEmployeeName",
      "evStartDate",
      "evPosition",
      "evCompanyName",
      "evAnnualIncome",
    ],
  },
  statementControls: {
    Statement: ["stName", "stAddress", "stBranchAddress", "stBranchNo", "stAccountNo", "stFrom", "stTo", "stOpeningBalance"],
    "Statement Rows": ["__statementRows"],
  },
};

function getActiveControlSectionId() {
  const docType = getDocumentType();
  if (docType === "employment") return "employmentControls";
  if (docType === "statement") return "statementControls";
  return "payrollControls";
}

function setSaveStatus(text, variant = "") {
  if (!elements.uiDocStatus) return;
  elements.uiDocStatus.textContent = text;
  elements.uiDocStatus.classList.remove("error", "success");
  if (variant) {
    elements.uiDocStatus.classList.add(variant);
  }
}

function clearFieldErrors() {
  document.querySelectorAll(".field-error").forEach((node) => node.remove());
  document.querySelectorAll(".invalid-field").forEach((node) => node.classList.remove("invalid-field"));
}

function setFieldError(element, message) {
  if (!element) return;
  element.classList.add("invalid-field");
  const host = element.closest("label") ?? element.parentElement;
  if (!host) return;

  let msgNode = host.querySelector(".field-error");
  if (!msgNode) {
    msgNode = document.createElement("span");
    msgNode.className = "field-error";
    host.appendChild(msgNode);
  }
  msgNode.textContent = message;
}

function isBlank(value) {
  return safeText(value).length === 0;
}

function parseDateValue(value) {
  if (!value) return null;
  const parsed = new Date(`${value}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function collectValidationState(data) {
  const fieldErrors = {};
  const missingByGroup = {};
  const activeSectionId = getActiveControlSectionId();

  const markMissing = (groupTitle, count = 1) => {
    if (!missingByGroup[groupTitle]) missingByGroup[groupTitle] = 0;
    missingByGroup[groupTitle] += count;
  };

  const requireField = (groupTitle, fieldKey, label) => {
    const field = elements[fieldKey];
    if (!field) return;
    if (isBlank(field.value)) {
      fieldErrors[fieldKey] = `${label} is required.`;
      markMissing(groupTitle);
    }
  };

  if (activeSectionId === "payrollControls") {
    requireField("Company + Employee", "companyName", "Company name");
    requireField("Company + Employee", "employeeName", "Employee name");
    requireField("Company + Employee", "periodEnding", "Period ending");
    requireField("Company + Employee", "payDate", "Pay date");
    if (!data.earnings.length) {
      markMissing("Earnings");
    }
    const periodEnding = parseDateValue(data.periodEnding);
    const payDate = parseDateValue(data.payDate);
    if (periodEnding && payDate && payDate < periodEnding) {
      fieldErrors.payDate = "Pay date must be on or after period ending.";
      markMissing("Company + Employee");
    }
  } else if (activeSectionId === "employmentControls") {
    requireField("Employment Verification Letter", "evDate", "Date");
    requireField("Employment Verification Letter", "evEmployeeName", "Employee name");
    requireField("Employment Verification Letter", "evStartDate", "Start date");
    requireField("Employment Verification Letter", "evPosition", "Position");
    requireField("Employment Verification Letter", "evCompanyName", "Company name");
    requireField("Employment Verification Letter", "evAnnualIncome", "Annual income");
  } else if (activeSectionId === "statementControls") {
    requireField("Statement", "stName", "Name");
    requireField("Statement", "stAddress", "Address");
    requireField("Statement", "stBranchAddress", "Branch address");
    requireField("Statement", "stBranchNo", "Branch no.");
    requireField("Statement", "stAccountNo", "Account no.");
    requireField("Statement", "stFrom", "Statement from");
    requireField("Statement", "stTo", "Statement to");
    requireField("Statement", "stOpeningBalance", "Opening balance");
    if (!data.statement?.transactions?.length) {
      markMissing("Statement Rows");
    }
  }

  return {
    activeSectionId,
    fieldErrors,
    missingByGroup,
    blockingCount: Object.keys(fieldErrors).length + Object.values(missingByGroup).reduce((sum, value) => sum + value, 0),
  };
}

function applyValidationState(validationState) {
  clearFieldErrors();
  for (const [fieldKey, message] of Object.entries(validationState.fieldErrors)) {
    setFieldError(elements[fieldKey], message);
  }

  document.querySelectorAll(".form-group").forEach((group) => {
    const section = group.closest(".doc-section");
    const badge = group.querySelector(".form-group-badge");
    if (!section || !badge) return;
    const title = group.dataset.groupTitle ?? "";
    const requiredMap = GROUP_REQUIREMENTS[section.id] ?? {};
    const tracked = Object.prototype.hasOwnProperty.call(requiredMap, title);
    const missing = section.id === validationState.activeSectionId ? validationState.missingByGroup[title] ?? 0 : 0;

    group.classList.toggle("has-missing", tracked && missing > 0);
    group.classList.toggle("has-errors", tracked && missing > 0);

    if (!tracked) {
      badge.textContent = "Optional";
      return;
    }

    badge.textContent = missing > 0 ? `Missing ${missing}` : "Done";
  });
}

function buildControlAccordions() {
  for (const sectionId of ["payrollControls", "employmentControls", "statementControls"]) {
    const section = document.getElementById(sectionId);
    if (!section || section.dataset.grouped === "true") continue;

    const nodes = [...section.children];
    const fragment = document.createDocumentFragment();
    let currentBody = null;
    let groupIndex = -1;

    for (const node of nodes) {
      if (node.tagName === "H2") {
        groupIndex += 1;
        const group = document.createElement("section");
        group.className = "form-group";
        if (groupIndex > 0) {
          group.classList.add("is-collapsed");
        }
        const title = safeText(node.textContent);
        group.dataset.groupTitle = title;

        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "form-group-toggle";
        toggle.innerHTML = `<span>${escapeAttr(title)}</span><span class="form-group-badge">Done</span>`;
        toggle.addEventListener("click", () => {
          group.classList.toggle("is-collapsed");
        });

        currentBody = document.createElement("div");
        currentBody.className = "form-group-body";
        group.appendChild(toggle);
        group.appendChild(currentBody);
        fragment.appendChild(group);
        continue;
      }

      if (currentBody) {
        currentBody.appendChild(node);
      } else {
        fragment.appendChild(node);
      }
    }

    section.innerHTML = "";
    section.appendChild(fragment);
    section.dataset.grouped = "true";
  }
}

function saveDraftNow() {
  if (suspendDraftSave) return;
  try {
    const data = getCurrentFormData();
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(data));
  } catch {}
}

function scheduleDraftSave() {
  if (suspendDraftSave) return;
  if (draftSaveTimer) clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(saveDraftNow, 800);
}

function restoreDraftIfAvailable() {
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return false;
    suspendDraftSave = true;
    hydrateForm(parsed);
    suspendDraftSave = false;
    return true;
  } catch {
    return false;
  }
}

function getDocumentType() {
  const value = elements.documentTypeSelect?.value;
  if (value === "employment") return value;
  if (value === "statement") return value;
  if (value === "scotiaStatement") return value;
  if (value === "cibcStatement") return value;
  if (value === "rbcStatement") return value;
  if (value === "bmoStatement") return value;
  if (value === "simpliiStatement") return value;
  if (value === "noaStatement") return value;
  if (value === "t4Slip") return value;
  if (value === "bmoVoidCheck") return value;
  if (value === "scotiaVoidCheck") return value;
  if (value === "rbcVoidCheck") return value;
  if (value === "tdVoidCheck") return value;
  if (value === "cibcVoidCheck") return value;
  return "payroll";
}

function setDocumentType(type) {
  const validTypes = ["employment", "statement", "scotiaStatement", "cibcStatement", "rbcStatement", "bmoStatement", "simpliiStatement", "noaStatement", "t4Slip", "bmoVoidCheck", "scotiaVoidCheck", "rbcVoidCheck", "tdVoidCheck", "cibcVoidCheck"];
  const normalized = validTypes.includes(type) ? type : "payroll";
  elements.documentTypeSelect.value = normalized;
  elements.payrollControls.classList.toggle("is-hidden", normalized !== "payroll");
  elements.employmentControls.classList.toggle("is-hidden", normalized !== "employment");
  elements.statementControls.classList.toggle("is-hidden", normalized !== "statement");
  elements.scotiaStatementControls.classList.toggle("is-hidden", normalized !== "scotiaStatement");
  elements.cibcStatementControls.classList.toggle("is-hidden", normalized !== "cibcStatement");
  elements.rbcStatementControls.classList.toggle("is-hidden", normalized !== "rbcStatement");
  elements.bmoStatementControls.classList.toggle("is-hidden", normalized !== "bmoStatement");
  elements.simpliiStatementControls.classList.toggle("is-hidden", normalized !== "simpliiStatement");
  elements.noaControls.classList.toggle("is-hidden", normalized !== "noaStatement");
  elements.t4Controls.classList.toggle("is-hidden", normalized !== "t4Slip");
  elements.bmoVoidControls.classList.toggle("is-hidden", normalized !== "bmoVoidCheck");
  elements.scotiaVoidControls.classList.toggle("is-hidden", normalized !== "scotiaVoidCheck");
  elements.rbcVoidControls.classList.toggle("is-hidden", normalized !== "rbcVoidCheck");
  elements.tdVoidControls.classList.toggle("is-hidden", normalized !== "tdVoidCheck");
  elements.cibcVoidControls.classList.toggle("is-hidden", normalized !== "cibcVoidCheck");
  elements.paystub.classList.toggle("is-hidden", normalized !== "payroll");
  elements.employmentLetter.classList.toggle("is-hidden", normalized !== "employment");
  elements.statementReport.classList.toggle("is-hidden", normalized !== "statement");
  elements.scotiaReport.classList.toggle("is-hidden", normalized !== "scotiaStatement");
  elements.cibcReport.classList.toggle("is-hidden", normalized !== "cibcStatement");
  elements.rbcReport.classList.toggle("is-hidden", normalized !== "rbcStatement");
  elements.bmoReport.classList.toggle("is-hidden", normalized !== "bmoStatement");
  elements.simpliiReport.classList.toggle("is-hidden", normalized !== "simpliiStatement");
  elements.noaReport.classList.toggle("is-hidden", normalized !== "noaStatement");
  const t4El = document.getElementById("t4Report");
  if (t4El) t4El.classList.toggle("is-hidden", normalized !== "t4Slip");
  elements.bmoVoidReport.classList.toggle("is-hidden", normalized !== "bmoVoidCheck");
  elements.scotiaVoidReport.classList.toggle("is-hidden", normalized !== "scotiaVoidCheck");
  elements.rbcVoidReport.classList.toggle("is-hidden", normalized !== "rbcVoidCheck");
  elements.tdVoidReport.classList.toggle("is-hidden", normalized !== "tdVoidCheck");
  elements.cibcVoidReport.classList.toggle("is-hidden", normalized !== "cibcVoidCheck");
}

function getActiveDocumentNode() {
  if (getDocumentType() === "employment") return elements.employmentLetter;
  if (getDocumentType() === "statement") return elements.statementReport;
  if (getDocumentType() === "scotiaStatement") return elements.scotiaReport;
  if (getDocumentType() === "cibcStatement") return elements.cibcReport;
  if (getDocumentType() === "rbcStatement") return elements.rbcReport;
  if (getDocumentType() === "bmoStatement") return elements.bmoReport;
  if (getDocumentType() === "simpliiStatement") return elements.simpliiReport;
  if (getDocumentType() === "noaStatement") return elements.noaReport;
  if (getDocumentType() === "t4Slip") return document.getElementById("t4Report");
  if (getDocumentType() === "bmoVoidCheck") return elements.bmoVoidReport;
  if (getDocumentType() === "scotiaVoidCheck") return elements.scotiaVoidReport;
  if (getDocumentType() === "rbcVoidCheck") return elements.rbcVoidReport;
  if (getDocumentType() === "tdVoidCheck") return elements.tdVoidReport;
  if (getDocumentType() === "cibcVoidCheck") return elements.cibcVoidReport;
  return elements.paystub;
}

function buildPdfFilename(data) {
  const docType = getDocumentType();
  if (docType === "employment") {
    const person = slugify(data.employmentVerification?.employeeName) || "employee";
    const date = data.employmentVerification?.date || "letter-date";
    return `employment-verification-${person}-${date}.pdf`;
  }
  if (docType === "statement") {
    const person = slugify(data.statement?.name) || "account-holder";
    const from = slugify(data.statement?.statementFrom) || "from";
    const to = slugify(data.statement?.statementTo) || "to";
    return `statement-${person}-${from}-${to}.pdf`;
  }
  if (docType === "scotiaStatement") {
    const person = slugify(data.scotiaStatement?.name) || "account-holder";
    const from = slugify(data.scotiaStatement?.statementFrom) || "from";
    const to = slugify(data.scotiaStatement?.statementTo) || "to";
    return `scotia-statement-${person}-${from}-${to}.pdf`;
  }
  if (docType === "cibcStatement") {
    const person = slugify(data.cibcStatement?.name) || "account-holder";
    const from = slugify(data.cibcStatement?.statementFrom) || "from";
    const to = slugify(data.cibcStatement?.statementTo) || "to";
    return `cibc-statement-${person}-${from}-${to}.pdf`;
  }
  if (docType === "rbcStatement") {
    const person = slugify(data.rbcStatement?.name) || "account-holder";
    const from = slugify(data.rbcStatement?.statementFrom) || "from";
    const to = slugify(data.rbcStatement?.statementTo) || "to";
    return `rbc-statement-${person}-${from}-${to}.pdf`;
  }
  if (docType === "bmoStatement") {
    const person = slugify(data.bmoStatement?.name) || "account-holder";
    const period = slugify(data.bmoStatement?.periodEnd) || "period";
    return `bmo-statement-${person}-${period}.pdf`;
  }
  if (docType === "simpliiStatement") {
    const person = slugify(data.simpliiStatement?.name) || "account-holder";
    const from = slugify(data.simpliiStatement?.statementPeriodFrom) || "from";
    const to = slugify(data.simpliiStatement?.statementPeriodTo) || "to";
    return `simplii-statement-${person}-${from}-${to}.pdf`;
  }
  if (docType === "noaStatement") {
    const person = slugify(data.noaStatement?.name) || "taxpayer";
    const year = slugify(data.noaStatement?.taxYear) || "year";
    return `noa-${person}-${year}.pdf`;
  }
  if (docType === "t4Slip") {
    const year = data.t4Slip?.year || "year";
    const name = slugify(data.t4Slip?.employerName) || "employer";
    return `t4-slip-${name}-${year}.pdf`;
  }
  if (docType === "bmoVoidCheck") {
    const name = slugify(data.bmoVoidCheck?.name) || "customer";
    return `bmo-void-cheque-${name}.pdf`;
  }
  if (docType === "scotiaVoidCheck") {
    const name = slugify(data.scotiaVoidCheck?.name) || "customer";
    return `scotia-void-cheque-${name}.pdf`;
  }
  if (docType === "rbcVoidCheck") {
    const name = slugify(data.rbcVoidCheck?.name) || "customer";
    return `rbc-void-cheque-${name}.pdf`;
  }
  if (docType === "tdVoidCheck") {
    const name = slugify(data.tdVoidCheck?.customerName) || "customer";
    return `td-void-cheque-${name}.pdf`;
  }
  if (docType === "cibcVoidCheck") {
    const name = slugify(data.cibcVoidCheck?.name) || "customer";
    return `cibc-void-cheque-${name}.pdf`;
  }
  const employee = slugify(data.employeeName) || "employee";
  const payDate = data.payDate || "pay-date";
  return `payroll-statement-${employee}-${payDate}.pdf`;
}

function getPdfPageSizeMm(format) {
  if (String(format).toLowerCase() === "letter") {
    return { width: 215.9, height: 279.4 };
  }
  return { width: 210, height: 297 };
}

async function saveTwoPagePdf(filename, firstPageId, secondPageId, format = "a4") {
  const pageNodes = [document.getElementById(firstPageId), document.getElementById(secondPageId)].filter(Boolean);

  if (!pageNodes.length) return;
  const pageSize = getPdfPageSizeMm(format);
  const pageOpts = {
    margin: [0, 0, 0, 0],
    image: { type: "jpeg", quality: 0.98 },
    html2canvas: {
      scale: 2,
      useCORS: true,
      backgroundColor: "#ffffff",
    },
    jsPDF: {
      unit: "mm",
      format,
      orientation: "portrait",
    },
    pagebreak: { mode: [] },
  };

  const originalBreakStyles = pageNodes.map((node) => ({
    node,
    breakAfter: node.style.breakAfter,
    pageBreakAfter: node.style.pageBreakAfter,
    breakBefore: node.style.breakBefore,
    pageBreakBefore: node.style.pageBreakBefore,
  }));

  try {
    // Neutralize CSS page-break hints; this export path adds pages manually.
    pageNodes.forEach((node) => {
      node.style.breakAfter = "auto";
      node.style.pageBreakAfter = "auto";
      node.style.breakBefore = "auto";
      node.style.pageBreakBefore = "auto";
    });

    const firstPageWorker = window.html2pdf().set(pageOpts).from(pageNodes[0]).toPdf();
    const pdf = await firstPageWorker.get("pdf");

    // Guard: some engines still append a trailing blank page from legacy break rules.
    if (typeof pdf.getNumberOfPages === "function" && typeof pdf.deletePage === "function") {
      for (let pageNum = pdf.getNumberOfPages(); pageNum > 1; pageNum -= 1) {
        pdf.deletePage(pageNum);
      }
    }

    if (pageNodes[1]) {
      const secondPageCanvasWorker = window.html2pdf().set(pageOpts).from(pageNodes[1]).toCanvas();
      const secondCanvas = await secondPageCanvasWorker.get("canvas");
      const secondImageData = secondCanvas.toDataURL("image/jpeg", 0.98);
      pdf.addPage(format, "portrait");
      pdf.addImage(secondImageData, "JPEG", 0, 0, pageSize.width, pageSize.height);
    }

    const expectedPages = pageNodes[1] ? 2 : 1;
    if (typeof pdf.getNumberOfPages === "function" && typeof pdf.deletePage === "function") {
      while (pdf.getNumberOfPages() > expectedPages) {
        pdf.deletePage(pdf.getNumberOfPages());
      }
    }

    pdf.save(filename);
  } finally {
    originalBreakStyles.forEach(({ node, breakAfter, pageBreakAfter, breakBefore, pageBreakBefore }) => {
      node.style.breakAfter = breakAfter;
      node.style.pageBreakAfter = pageBreakAfter;
      node.style.breakBefore = breakBefore;
      node.style.pageBreakBefore = pageBreakBefore;
    });
  }
}

async function saveStatementPdf(filename) {
  return saveTwoPagePdf(filename, "statementPage1", "statementPage2", "a4");
}

async function downloadPdf() {
  try {
    await consumeToken();
  } catch (e) {
    return;
  }

  renderPreview();

  const docNode = getActiveDocumentNode();
  if (!docNode) return;

  const data = getCurrentFormData();
  const validationState = collectValidationState(data);
  const issueCount =
    Object.keys(validationState.fieldErrors).length +
    Object.values(validationState.missingByGroup).reduce((sum, value) => sum + value, 0);
  if (issueCount > 0) {
    const proceed = window.confirm(
      `There are ${issueCount} validation issue${issueCount === 1 ? "" : "s"}. Save PDF anyway?`
    );
    if (!proceed) return;
  }

  const filename = buildPdfFilename(data);
  const isStatementExport = getDocumentType() === "statement";
  const isScotiaExport = getDocumentType() === "scotiaStatement";
  const isCibcExport = getDocumentType() === "cibcStatement";
  const isRbcExport = getDocumentType() === "rbcStatement";
  const isBmoExport = getDocumentType() === "bmoStatement";
  const isSimpliiExport = getDocumentType() === "simpliiStatement";
  const isCompactThemeExport =
    getDocumentType() === "payroll" &&
    (data.designTemplate === "northern-mint" || data.designTemplate === "monochrome-ledger");

  if (typeof window.html2pdf !== "function") {
    window.print();
    return;
  }

  const originalLabel = elements.printBtn.textContent;
  const originalQuickLabel = elements.quickSaveBtn ? elements.quickSaveBtn.textContent : "";
  const originalRootFontSize = document.documentElement.style.fontSize;
  elements.printBtn.disabled = true;
  elements.printBtn.textContent = "Saving...";
  if (elements.quickSaveBtn) {
    elements.quickSaveBtn.disabled = true;
    elements.quickSaveBtn.textContent = "Saving...";
  }
  setSaveStatus("Rendering PDF...", "");

  try {
    // Reduce global rem sizing during export so content fits one page.
    document.documentElement.style.fontSize = isCompactThemeExport ? "13px" : "14px";
    if (isCompactThemeExport) {
      docNode.classList.add("compact-export");
    }
    await new Promise((resolve) => window.requestAnimationFrame(resolve));

    if (isStatementExport) {
      await saveStatementPdf(filename);
      setSaveStatus(`Saved ${filename}`, "success");
      return;
    }

    if (isScotiaExport) {
      await saveScotiaPdf(filename);
      setSaveStatus(`Saved ${filename}`, "success");
      return;
    }

    if (isCibcExport) {
      await saveCibcPdf(filename);
      setSaveStatus(`Saved ${filename}`, "success");
      return;
    }

    if (isRbcExport) {
      await saveRbcPdf(filename);
      setSaveStatus(`Saved ${filename}`, "success");
      return;
    }

    if (isBmoExport) {
      await saveBmoPdf(filename);
      setSaveStatus(`Saved ${filename}`, "success");
      return;
    }

    if (isSimpliiExport) {
      await saveSimpliiPdf(filename);
      setSaveStatus(`Saved ${filename}`, "success");
      return;
    }

    if (getDocumentType() === "noaStatement") {
      await saveNoaPdf(filename);
      setSaveStatus(`Saved ${filename}`, "success");
      return;
    }

    if (getDocumentType() === "t4Slip") {
      await saveT4Pdf(filename);
      setSaveStatus(`Saved ${filename}`, "success");
      return;
    }

    if (getDocumentType() === "bmoVoidCheck") {
      await saveBmoVoidPdf(filename);
      setSaveStatus(`Saved ${filename}`, "success");
      return;
    }

    if (getDocumentType() === "scotiaVoidCheck") {
      await saveScotiaVoidPdf(filename);
      setSaveStatus(`Saved ${filename}`, "success");
      return;
    }

    if (getDocumentType() === "rbcVoidCheck") {
      await saveRbcVoidPdf(filename);
      setSaveStatus(`Saved ${filename}`, "success");
      return;
    }

    if (getDocumentType() === "tdVoidCheck") {
      await saveTdVoidPdf(filename);
      setSaveStatus(`Saved ${filename}`, "success");
      return;
    }

    if (getDocumentType() === "cibcVoidCheck") {
      await saveCibcVoidPdf(filename);
      setSaveStatus(`Saved ${filename}`, "success");
      return;
    }

    await window
      .html2pdf()
      .set({
        margin: isCompactThemeExport ? [4, 4, 4, 4] : [6, 6, 6, 6],
        filename,
        image: { type: "jpeg", quality: 0.98 },
        html2canvas: {
          scale: 2,
          useCORS: true,
          backgroundColor: "#ffffff",
        },
        jsPDF: {
          unit: "mm",
          format: "a4",
          orientation: "portrait",
        },
        pagebreak: { mode: ["css", "legacy"] },
      })
      .from(docNode)
      .save();
    setSaveStatus(`Saved ${filename}`, "success");
  } catch (error) {
    // Show a deterministic error instead of failing silently in browser PDF engines.
    console.error("PDF export failed", error);
    setSaveStatus("Could not save PDF. Please try again.", "error");
    window.alert("Could not save PDF. Please try again.");
  } finally {
    docNode.classList.remove("compact-export");
    document.documentElement.style.fontSize = originalRootFontSize;
    elements.printBtn.disabled = false;
    elements.printBtn.textContent = originalLabel;
    if (elements.quickSaveBtn) {
      elements.quickSaveBtn.disabled = false;
      elements.quickSaveBtn.textContent = originalQuickLabel || "Save PDF";
    }
  }
}

function addRow(tableBody, type, data = {}) {
  const row = document.createElement("tr");

  if (type === "earnings") {
    row.innerHTML = `
      <td><input type="text" data-key="label" value="${escapeAttr(safeText(data.label))}" placeholder="Regular" /></td>
      <td><input type="number" step="0.01" data-key="rate" value="${data.rate ?? ""}" /></td>
      <td><input type="number" step="0.01" data-key="hours" value="${data.hours ?? ""}" /></td>
      <td><input type="number" step="0.01" data-key="period" value="${data.period ?? ""}" class="readonly" readonly /></td>
      <td><input type="number" step="0.01" data-key="ytd" value="${data.ytd ?? ""}" class="readonly" readonly /></td>
      <td class="row-actions"><button class="duplicate-row" type="button">copy</button> <button class="remove-row" type="button">x</button></td>
    `;
  } else {
    row.innerHTML = `
      <td><input type="text" data-key="label" value="${escapeAttr(safeText(data.label))}" /></td>
      <td><input type="number" step="0.01" data-key="period" value="${data.period ?? ""}" /></td>
      <td><input type="number" step="0.01" data-key="ytd" value="${data.ytd ?? ""}" /></td>
      <td class="row-actions"><button class="duplicate-row" type="button">copy</button> <button class="remove-row" type="button">x</button></td>
    `;
  }

  tableBody.appendChild(row);
}

function readRows(tableBody, type) {
  const rows = [];
  for (const row of tableBody.querySelectorAll("tr")) {
    const label = safeText(row.querySelector('[data-key="label"]').value);
    if (!label) continue;

    if (type === "earnings") {
      rows.push({
        label,
        rate: toNumber(row.querySelector('[data-key="rate"]').value),
        hours: toNumber(row.querySelector('[data-key="hours"]').value),
      });
    } else {
      rows.push({
        label,
        period: toNumber(row.querySelector('[data-key="period"]').value),
        ytd: toNumber(row.querySelector('[data-key="ytd"]').value),
      });
    }
  }
  return rows;
}

function writeRows(tableBody, type, rows) {
  tableBody.innerHTML = "";
  for (const row of rows) {
    addRow(tableBody, type, row);
  }
}

function addStatementRow(tableBody, data = {}) {
  if (!tableBody) return;
  const row = document.createElement("tr");
  row.innerHTML = `
    <td><input type="text" data-key="date" value="${escapeAttr(safeText(data.date))}" /></td>
    <td><input type="text" data-key="description" value="${escapeAttr(safeText(data.description))}" /></td>
    <td><input type="number" step="0.01" data-key="debit" value="${data.debit ?? ""}" /></td>
    <td><input type="number" step="0.01" data-key="credit" value="${data.credit ?? ""}" /></td>
    <td class="row-actions"><button class="duplicate-row" type="button">copy</button> <button class="remove-row" type="button">x</button></td>
  `;
  tableBody.appendChild(row);
}

function readStatementRows(tableBody) {
  const rows = [];
  if (!tableBody) return rows;

  for (const row of tableBody.querySelectorAll("tr")) {
    const date = safeText(row.querySelector('[data-key="date"]')?.value);
    const description = safeText(row.querySelector('[data-key="description"]')?.value);
    const debit = Math.max(0, toNumber(row.querySelector('[data-key="debit"]')?.value));
    const credit = Math.max(0, toNumber(row.querySelector('[data-key="credit"]')?.value));

    if (!date && !description && debit === 0 && credit === 0) continue;
    rows.push({ date, description, debit, credit });
  }

  return rows;
}

function writeStatementRows(tableBody, rows) {
  if (!tableBody) return;
  tableBody.innerHTML = "";
  for (const row of rows ?? []) {
    addStatementRow(tableBody, row);
  }
}

function addScotiaRow(tableBody, data = {}) {
  if (!tableBody) return;
  const row = document.createElement("tr");
  row.innerHTML = `
    <td><input type="text" data-key="date" value="${escapeAttr(safeText(data.date))}" /></td>
    <td><input type="text" data-key="description" value="${escapeAttr(safeText(data.description))}" /></td>
    <td><input type="text" data-key="detail" value="${escapeAttr(safeText(data.detail))}" /></td>
    <td><input type="number" step="0.01" data-key="withdrawn" value="${data.withdrawn ?? ""}" /></td>
    <td><input type="number" step="0.01" data-key="deposited" value="${data.deposited ?? ""}" /></td>
    <td class="row-actions"><button class="duplicate-row" type="button">copy</button> <button class="remove-row" type="button">x</button></td>
  `;
  tableBody.appendChild(row);
}

function readScotiaRows(tableBody) {
  const rows = [];
  if (!tableBody) return rows;
  for (const row of tableBody.querySelectorAll("tr")) {
    const date = safeText(row.querySelector('[data-key="date"]')?.value);
    const description = safeText(row.querySelector('[data-key="description"]')?.value);
    const detail = safeText(row.querySelector('[data-key="detail"]')?.value);
    const withdrawn = Math.max(0, toNumber(row.querySelector('[data-key="withdrawn"]')?.value));
    const deposited = Math.max(0, toNumber(row.querySelector('[data-key="deposited"]')?.value));
    if (!date && !description && !detail && withdrawn === 0 && deposited === 0) continue;
    rows.push({ date, description, detail, withdrawn, deposited });
  }
  return rows;
}

function writeScotiaRows(tableBody, rows) {
  if (!tableBody) return;
  tableBody.innerHTML = "";
  for (const row of rows ?? []) {
    addScotiaRow(tableBody, row);
  }
}

function addCibcRow(tableBody, data = {}) {
  if (!tableBody) return;
  const row = document.createElement("tr");
  row.innerHTML = `
    <td><input type="text" data-key="date" value="${escapeAttr(safeText(data.date))}" /></td>
    <td><input type="text" data-key="description" value="${escapeAttr(safeText(data.description))}" /></td>
    <td><input type="text" data-key="detail" value="${escapeAttr(safeText(data.detail))}" /></td>
    <td><input type="number" step="0.01" data-key="withdrawn" value="${data.withdrawn ?? ""}" /></td>
    <td><input type="number" step="0.01" data-key="deposited" value="${data.deposited ?? ""}" /></td>
    <td class="row-actions"><button class="duplicate-row" type="button">copy</button> <button class="remove-row" type="button">x</button></td>
  `;
  tableBody.appendChild(row);
}

function readCibcRows(tableBody) {
  const rows = [];
  if (!tableBody) return rows;
  for (const row of tableBody.querySelectorAll("tr")) {
    const date = safeText(row.querySelector('[data-key="date"]')?.value);
    const description = safeText(row.querySelector('[data-key="description"]')?.value);
    const detail = safeText(row.querySelector('[data-key="detail"]')?.value);
    const withdrawn = Math.max(0, toNumber(row.querySelector('[data-key="withdrawn"]')?.value));
    const deposited = Math.max(0, toNumber(row.querySelector('[data-key="deposited"]')?.value));
    if (!date && !description && !detail && withdrawn === 0 && deposited === 0) continue;
    rows.push({ date, description, detail, withdrawn, deposited });
  }
  return rows;
}

function writeCibcRows(tableBody, rows) {
  if (!tableBody) return;
  tableBody.innerHTML = "";
  for (const row of rows ?? []) {
    addCibcRow(tableBody, row);
  }
}

function addRbcRow(tableBody, data = {}) {
  if (!tableBody) return;
  const row = document.createElement("tr");
  row.innerHTML = `
    <td><input type="text" data-key="date" value="${escapeAttr(safeText(data.date))}" /></td>
    <td><input type="text" data-key="description" value="${escapeAttr(safeText(data.description))}" /></td>
    <td><input type="number" step="0.01" data-key="withdrawn" value="${data.withdrawn ?? ""}" /></td>
    <td><input type="number" step="0.01" data-key="deposited" value="${data.deposited ?? ""}" /></td>
    <td class="row-actions"><button class="duplicate-row" type="button">copy</button> <button class="remove-row" type="button">x</button></td>
  `;
  tableBody.appendChild(row);
}

function readRbcRows(tableBody) {
  const rows = [];
  if (!tableBody) return rows;
  for (const row of tableBody.querySelectorAll("tr")) {
    const date = safeText(row.querySelector('[data-key="date"]')?.value);
    const description = safeText(row.querySelector('[data-key="description"]')?.value);
    const withdrawn = Math.max(0, toNumber(row.querySelector('[data-key="withdrawn"]')?.value));
    const deposited = Math.max(0, toNumber(row.querySelector('[data-key="deposited"]')?.value));
    if (!date && !description && withdrawn === 0 && deposited === 0) continue;
    rows.push({ date, description, withdrawn, deposited });
  }
  return rows;
}

function writeRbcRows(tableBody, rows) {
  if (!tableBody) return;
  tableBody.innerHTML = "";
  for (const row of rows ?? []) {
    addRbcRow(tableBody, row);
  }
}

function buildBmoPages(bmoData) {
  const openingBalance = toNumber(bmoData.openingBalance);
  const transactions = (bmoData.transactions ?? []).map((row) => ({
    date:        safeText(row?.date),
    description: safeText(row?.description),
    deducted:    Math.max(0, toNumber(row?.deducted)),
    added:       Math.max(0, toNumber(row?.added)),
  }));

  const rowsPerPage = 15;
  const page1Transactions = transactions.slice(0, rowsPerPage);
  const page2Transactions = transactions.slice(rowsPerPage);

  let runningBalance = openingBalance;
  let totalDeducted  = 0;
  let totalAdded     = 0;

  const toRenderedRows = (rows) =>
    rows.map((row) => {
      totalDeducted  += row.deducted;
      totalAdded     += row.added;
      runningBalance += row.added - row.deducted;
      return { ...row, balance: runningBalance };
    });

  const page1Rows        = toRenderedRows(page1Transactions);
  const balanceAfterPage1 = runningBalance;
  const page2Rows        = toRenderedRows(page2Transactions);
  const closingBalance   = runningBalance;

  return { page1Rows, page2Rows, totalDeducted, totalAdded, closingBalance, balanceAfterPage1 };
}

// ── Standalone Node.js helper (no DOM needed) ─────────────────────────────
// Compute opening balance required to hit a target closing balance.
// Works for any number of transactions.
function computeOpeningBalance(transactions, targetClosing) {
  const net = transactions.reduce((s, t) => s + (t.added || 0) - (t.deducted || 0), 0);
  return +((targetClosing - net).toFixed(2));
}


// ─────────────────────────────────────────────────────────────────────────────
// 6.  renderBmoRows  (app.js, line 3429)
//     Writes rendered transaction rows into a DOM <tbody>.
//     Each row gets a running balance column (pre-calculated by buildBmoPages).
// ─────────────────────────────────────────────────────────────────────────────

function renderBmoRows(target, rows) {
  if (!target) return;
  target.innerHTML = rows
    .map((row) => {
      const descHtml = escapeAttr(row.description).replace(/\\n|\n/g, "<br>");
      return `<tr class="bmo-tx-row">
        <td class="bmo-td-date"><strong>${escapeAttr(row.date)}</strong></td>
        <td class="bmo-td-desc">${descHtml}</td>
        <td class="bmo-td-amount">${row.deducted > 0 ? formatMoney(row.deducted) : ""}</td>
        <td class="bmo-td-amount">${row.added    > 0 ? formatMoney(row.added)    : ""}</td>
        <td class="bmo-td-bal">${formatMoney(row.balance)}</td>
      </tr>`;
    })
    .join("");
}


// ─────────────────────────────────────────────────────────────────────────────
// 7.  renderBmoPreview  (app.js, line 3447)
//     Populates the live 2-page DOM preview from a full `data` object.
//     Requires the HTML in §11 to be in the document.
// ─────────────────────────────────────────────────────────────────────────────

function renderBmoPreview(data) {
  const bmo            = data.bmoStatement ?? {};
  const openingBalance = toNumber(bmo.openingBalance);
  const layout         = buildBmoPages(bmo);

  const set    = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val ?? ""; };
  const setHtml = (id, val) => { const el = document.getElementById(id); if (el) el.innerHTML  = val ?? ""; };

  // ── Page 1 header fields ────────────────────────────────────────────────
  setHtml("pvBmBranchAddress1", (bmo.branchAddress ?? "").replace(/\n/g, "<br>"));
  set("pvBmBranchName1",  bmo.branchName  ?? "");
  set("pvBmTransitNo1",   bmo.transitNo   ?? "");
  set("pvBmPhone1",       bmo.phone       ?? "");
  set("pvBmPlanName1",    bmo.planName    ?? "");
  setHtml("pvBmName1",    (bmo.name    ?? "").replace(/\n/g, "<br>"));
  setHtml("pvBmAddress1", (bmo.address ?? "").replace(/\n/g, "<br>"));
  set("pvBmPeriodEnd1",   bmo.periodEnd   ?? "");
  set("pvBmSummaryDate",  bmo.periodEnd   ?? "");
  set("pvBmAccountType1", bmo.accountType ?? "");
  set("pvBmAccountNo1",   bmo.accountNo   ?? "");

  // ── Summary row ─────────────────────────────────────────────────────────
  set("pvBmSummaryOpen",     formatMoney(openingBalance));
  set("pvBmSummaryDeducted", formatMoney(layout.totalDeducted));
  set("pvBmSummaryAdded",    formatMoney(layout.totalAdded));
  set("pvBmSummaryClose",    formatMoney(layout.closingBalance));

  // ── Page 1 ledger ───────────────────────────────────────────────────────
  const firstDate = (bmo.transactions ?? [])[0]?.date ?? "";
  const lastDate  = (bmo.transactions ?? [])[(bmo.transactions ?? []).length - 1]?.date ?? "";

  const accountHeaderHtml = `
    <tr class="bmo-acct-hdr-row">
      <td colspan="5"><span class="bmo-acct-icon"></span><strong>${escapeAttr(bmo.accountType ?? "")}# ${escapeAttr(bmo.accountNo ?? "")}</strong></td>
    </tr>
    <tr class="bmo-owner-row">
      <td colspan="5">Owner:<br>${escapeAttr(bmo.name ?? "")}</td>
    </tr>`;

  const openingRowHtml = `<tr class="bmo-opening-row">
    <td class="bmo-td-date"><strong>${escapeAttr(firstDate)}</strong></td>
    <td class="bmo-td-desc"><strong>Opening balance</strong></td>
    <td class="bmo-td-amount"></td>
    <td class="bmo-td-amount"></td>
    <td class="bmo-td-bal"><strong>${formatMoney(openingBalance)}</strong></td>
  </tr>`;

  const pvPage1 = document.getElementById("pvBmRowsPage1");
  if (pvPage1) {
    pvPage1.innerHTML = accountHeaderHtml + openingRowHtml;
    const tmp = document.createElement("tbody");
    renderBmoRows(tmp, layout.page1Rows);
    pvPage1.innerHTML += tmp.innerHTML;
  }

  // ── Page 2 ledger ───────────────────────────────────────────────────────
  const accountHeaderHtmlP2 = `
    <tr class="bmo-acct-hdr-row">
      <td colspan="4"><strong>${escapeAttr(bmo.accountType ?? "")}# ${escapeAttr(bmo.accountNo ?? "")}</strong></td>
      <td class="bmo-p2-continued">(continued)</td>
    </tr>`;

  const closingRowHtml = `<tr class="bmo-closing-row">
    <td class="bmo-td-date"><strong>${escapeAttr(lastDate)}</strong></td>
    <td class="bmo-td-desc"><strong>Closing totals</strong></td>
    <td class="bmo-td-amount"><strong>${formatMoney(layout.totalDeducted)}</strong></td>
    <td class="bmo-td-amount"><strong>${formatMoney(layout.totalAdded)}</strong></td>
    <td class="bmo-td-bal"></td>
  </tr>`;

  const pvPage2 = document.getElementById("pvBmRowsPage2");
  if (pvPage2) {
    pvPage2.innerHTML = accountHeaderHtmlP2;
    const tmp2 = document.createElement("tbody");
    renderBmoRows(tmp2, layout.page2Rows);
    pvPage2.innerHTML += tmp2.innerHTML + closingRowHtml;
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// 8.  saveBmoPdf  (app.js, line 3521)
//     Saves a 2-page US Letter PDF.
//     saveTwoPagePdf() captures #bmoPage1 then #bmoPage2 at Letter dimensions.
// ─────────────────────────────────────────────────────────────────────────────

async function saveBmoPdf(filename) {
  return saveTwoPagePdf(filename, "bmoPage1", "bmoPage2", "letter");
}

function addBmoRow(tableBody, data = {}) {
  if (!tableBody) return;
  const row = document.createElement("tr");
  row.innerHTML = `
    <td><input type="text" data-key="date" value="${escapeAttr(safeText(data.date))}" /></td>
    <td><input type="text" data-key="description" value="${escapeAttr(safeText(data.description))}" /></td>
    <td><input type="number" step="0.01" data-key="deducted" value="${data.deducted ?? ""}" /></td>
    <td><input type="number" step="0.01" data-key="added" value="${data.added ?? ""}" /></td>
    <td class="row-actions">
      <button class="duplicate-row" type="button">copy</button>
      <button class="remove-row" type="button">x</button>
    </td>
  `;
  tableBody.appendChild(row);
}

function readBmoRows(tableBody) {
  const rows = [];
  if (!tableBody) return rows;
  for (const row of tableBody.querySelectorAll("tr")) {
    const date = safeText(row.querySelector('[data-key="date"]')?.value);
    const description = safeText(row.querySelector('[data-key="description"]')?.value);
    const deducted = Math.max(0, toNumber(row.querySelector('[data-key="deducted"]')?.value));
    const added = Math.max(0, toNumber(row.querySelector('[data-key="added"]')?.value));
    if (!date && !description && deducted === 0 && added === 0) continue;
    rows.push({ date, description, deducted, added });
  }
  return rows;
}

function writeBmoRows(tableBody, rows) {
  if (!tableBody) return;
  tableBody.innerHTML = "";
  for (const row of rows ?? []) {
    addBmoRow(tableBody, row);
  }
}

function buildSimpliiData(sfData) {
  const openingBalance = toNumber(sfData.openingBalance);
  const transactions = (sfData.transactions ?? []).map((row) => ({
    transDate:   safeText(row?.transDate),
    effDate:     safeText(row?.effDate),
    description: safeText(row?.description),
    fundsOut:    Math.max(0, toNumber(row?.fundsOut)),
    fundsIn:     Math.max(0, toNumber(row?.fundsIn)),
  }));

  let runningBalance = openingBalance;
  let totalFundsOut  = 0;
  let totalFundsIn   = 0;

  const renderedRows = transactions.map((row) => {
    totalFundsOut  += row.fundsOut;
    totalFundsIn   += row.fundsIn;
    runningBalance += row.fundsIn - row.fundsOut;
    return { ...row, balance: runningBalance };
  });

  return { openingBalance, renderedRows, totalFundsOut, totalFundsIn, closingBalance: runningBalance };
}

function renderSimpliiRows(target, rows) {
  if (!target) return;
  target.innerHTML = rows.map((row) => `
    <tr>
      <td class="si-date">${escapeAttr(row.transDate)}</td>
      <td class="si-date">${escapeAttr(row.effDate)}</td>
      <td>${escapeAttr(row.description)}</td>
      <td class="si-right">${row.fundsOut > 0 ? formatMoney(row.fundsOut) : ''}</td>
      <td class="si-right">${row.fundsIn  > 0 ? formatMoney(row.fundsIn)  : ''}</td>
      <td class="si-right">${formatMoney(row.balance)}</td>
    </tr>
  `).join('');
}

function renderSimpliiPreview(data) {
  const sf     = data.simpliiStatement ?? {};
  const layout = buildSimpliiData(sf);

  // ── header / meta fields ──────────────────────────────────────────────────
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

  set('pvSfName',           sf.name ?? '');
  set('pvSfAddress',        sf.address ?? '');
  set('pvSfPeriodFrom',     sf.statementPeriodFrom ?? '');
  set('pvSfPeriodFrom2',    sf.statementPeriodFrom ?? '');
  set('pvSfPeriodTo',       sf.statementPeriodTo ?? '');
  set('pvSfPeriodTo2',      sf.statementPeriodTo ?? '');
  set('pvSfStatementDate',  sf.statementDate ?? '');
  set('pvSfStatementDate2', sf.statementDate ?? '');
  set('pvSfAccountNo1',     sf.accountNo ?? '');
  set('pvSfAccountNo2',     sf.accountNo ?? '');
  set('pvSfAccountNoEnd',   sf.accountNo ?? '');

  // ── transaction rows ──────────────────────────────────────────────────────
  const pvSfRows        = document.getElementById('pvSfRows');
  const pvSfRowsP2      = document.getElementById('pvSfRowsP2');
  const simpliiP2Overflow = document.getElementById('simpliiP2Overflow');

  if (pvSfRows) {
    const bfDate   = fmtShortDate(sf.statementPeriodFrom ?? '');
    const balFwdRow = `<tr class="si-balance-forward-row">
      <td class="si-date">${escapeAttr(bfDate)}</td>
      <td class="si-date">${escapeAttr(bfDate)}</td>
      <td>BALANCE FORWARD</td>
      <td></td><td></td>
      <td class="si-right">${formatMoney(layout.openingBalance)}</td>
    </tr>`;

    const MAX_PAGE1 = 21;
    const MAX_PAGE2 = 5;
    const p1Rows      = layout.renderedRows.slice(0, MAX_PAGE1);
    const p2Rows      = layout.renderedRows.slice(MAX_PAGE1, MAX_PAGE1 + MAX_PAGE2);
    const displayedRows = [...p1Rows, ...p2Rows];

    const dispTotalOut = displayedRows.reduce((s, r) => s + r.fundsOut, 0);
    const dispTotalIn  = displayedRows.reduce((s, r) => s + r.fundsIn,  0);
    const dispClosing  = layout.openingBalance + dispTotalIn - dispTotalOut;

    set('pvSfTotalOut',   formatMoney(dispTotalOut));
    set('pvSfTotalIn',    formatMoney(dispTotalIn));
    set('pvSfClosingBal', formatMoney(dispClosing));

    const tempDiv1 = document.createElement('tbody');
    renderSimpliiRows(tempDiv1, p1Rows);
    pvSfRows.innerHTML = balFwdRow + tempDiv1.innerHTML;

    if (pvSfRowsP2 && simpliiP2Overflow) {
      if (p2Rows.length > 0) {
        const tempDiv2 = document.createElement('tbody');
        renderSimpliiRows(tempDiv2, p2Rows);
        pvSfRowsP2.innerHTML = tempDiv2.innerHTML;
        simpliiP2Overflow.classList.remove('is-hidden');
      } else {
        pvSfRowsP2.innerHTML = '';
        simpliiP2Overflow.classList.add('is-hidden');
      }
    }
  }
}

function saveSimpliiPdf(filename) {
  return saveTwoPagePdf(filename, 'simpliiPage1', 'simpliiPage2', 'letter');
}

function addSimpliiRow(tableBody, data = {}) {
  if (!tableBody) return;
  const row = document.createElement('tr');
  row.innerHTML = `
    <td><input type="text" data-key="transDate" value="${escapeAttr(safeText(data.transDate))}" /></td>
    <td><input type="text" data-key="effDate" value="${escapeAttr(safeText(data.effDate))}" /></td>
    <td><input type="text" data-key="description" value="${escapeAttr(safeText(data.description))}" /></td>
    <td><input type="number" step="0.01" data-key="fundsOut" value="${data.fundsOut ?? ''}" /></td>
    <td><input type="number" step="0.01" data-key="fundsIn" value="${data.fundsIn ?? ''}" /></td>
    <td class="row-actions">
      <button class="duplicate-row" type="button">copy</button>
      <button class="remove-row" type="button">x</button>
    </td>
  `;
  tableBody.appendChild(row);
}

function readSimpliiRows(tableBody) {
  const rows = [];
  if (!tableBody) return rows;
  for (const row of tableBody.querySelectorAll('tr')) {
    const transDate   = safeText(row.querySelector('[data-key="transDate"]')?.value);
    const effDate     = safeText(row.querySelector('[data-key="effDate"]')?.value);
    const description = safeText(row.querySelector('[data-key="description"]')?.value);
    const fundsOut    = Math.max(0, toNumber(row.querySelector('[data-key="fundsOut"]')?.value));
    const fundsIn     = Math.max(0, toNumber(row.querySelector('[data-key="fundsIn"]')?.value));
    if (!transDate && !effDate && !description && fundsOut === 0 && fundsIn === 0) continue;
    rows.push({ transDate, effDate, description, fundsOut, fundsIn });
  }
  return rows;
}

function writeSimpliiRows(tableBody, rows) {
  if (!tableBody) return;
  tableBody.innerHTML = '';
  for (const row of rows ?? []) {
    addSimpliiRow(tableBody, row);
  }
}

function getCurrentFormData() {
  return {
    documentType: getDocumentType(),
    companyName: safeText(elements.companyName.value),
    brandText: safeText(elements.brandText.value),
    brandColor: safeText(elements.brandColor.value) || "#096250",
    payrollLogoDataUrl,
    designTemplate: safeText(elements.designTemplate.value) || "classic-blue",
    periodEnding: elements.periodEnding.value,
    payDate: elements.payDate.value,
    province: safeText(elements.province.value).toUpperCase() || "AB",
    frequency: safeText(elements.frequency.value) || "monthly",
    employeeName: safeText(elements.employeeName.value),
    employeeId: safeText(elements.employeeId.value),
    employeeAddress: elements.employeeAddress.value.trim(),
    earnings: readRows(elements.earningsTable, "earnings"),
    deductions: readRows(elements.deductionsTable, "deductions"),
    benefits: readRows(elements.benefitsTable, "benefits"),
    vacHours: toNumber(elements.vacHours.value),
    sickHours: toNumber(elements.sickHours.value),
    notes: elements.notes.value.trim(),
    employmentVerification: {
      date: elements.evDate.value,
      employeeName: safeText(elements.evEmployeeName.value),
      startDate: elements.evStartDate.value,
      employeeAddress: elements.evEmployeeAddress.value.trim(),
      companyName: safeText(elements.evCompanyName.value),
      companyAddress: elements.evCompanyAddress.value.trim(),
      annualIncome: toNumber(elements.evAnnualIncome.value),
      position: safeText(elements.evPosition.value),
      logoDataUrl: employmentLogoDataUrl,
    },
    statement: {
      name: safeText(elements.stName.value),
      address: elements.stAddress.value.trim(),
      branchAddress: elements.stBranchAddress.value.trim(),
      branchNo: safeText(elements.stBranchNo.value),
      accountNo: safeText(elements.stAccountNo.value),
      statementFrom: safeText(elements.stFrom.value),
      statementTo: safeText(elements.stTo.value),
      openingBalance: toNumber(elements.stOpeningBalance.value),
      accountType: safeText(elements.stAccountType.value),
      transactions: readStatementRows(elements.statementTransactionsTable),
    },
    scotiaStatement: {
      name: safeText(elements.scName.value),
      address: elements.scAddress.value.trim(),
      branchAddress: elements.scBranchAddress.value.trim(),
      accountNo: safeText(elements.scAccountNo.value),
      accountType: safeText(elements.scAccountType.value),
      statementFrom: safeText(elements.scFrom.value),
      statementTo: safeText(elements.scTo.value),
      openingBalance: toNumber(elements.scOpeningBalance.value),
      transactions: readScotiaRows(elements.scotiaTransactionsTable),
    },
    cibcStatement: {
      name: safeText(elements.cbName.value),
      address: elements.cbAddress.value.trim(),
      accountNo: safeText(elements.cbAccountNo.value),
      branchTransit: safeText(elements.cbBranchTransit.value),
      statementFrom: safeText(elements.cbFrom.value),
      statementTo: safeText(elements.cbTo.value),
      openingBalance: toNumber(elements.cbOpeningBalance.value),
      disclaimer: elements.cbDisclaimer.value.trim(),
      transactions: readCibcRows(elements.cibcTransactionsTable),
    },
    rbcStatement: {
      name: safeText(elements.rbName.value),
      address: elements.rbAddress.value.trim(),
      accountNo: safeText(elements.rbAccountNo.value),
      accountType: safeText(elements.rbAccountType.value),
      bankBranch: elements.rbBankBranch.value.trim(),
      statementFrom: safeText(elements.rbFrom.value),
      statementTo: safeText(elements.rbTo.value),
      openingBalance: toNumber(elements.rbOpeningBalance.value),
      transactions: readRbcRows(elements.rbcTransactionsTable),
    },
    bmoStatement: {
      name: safeText(elements.bmName.value),
      address: elements.bmAddress.value.trim(),
      branchAddress: elements.bmBranchAddress.value.trim(),
      branchName: safeText(elements.bmBranchName.value),
      transitNo: safeText(elements.bmTransitNo.value),
      phone: safeText(elements.bmPhone.value),
      planName: safeText(elements.bmPlanName.value),
      accountNo: safeText(elements.bmAccountNo.value),
      accountType: safeText(elements.bmAccountType.value),
      periodEnd: safeText(elements.bmPeriodEnd.value),
      openingBalance: toNumber(elements.bmOpeningBalance.value),
      transactions: readBmoRows(elements.bmoTransactionsTable),
    },
    simpliiStatement: {
      name: safeText(elements.sfName.value),
      address: elements.sfAddress.value.trim(),
      accountNo: safeText(elements.sfAccountNo.value),
      statementPeriodFrom: safeText(elements.sfFrom.value),
      statementPeriodTo: safeText(elements.sfTo.value),
      statementDate: safeText(elements.sfStatementDate.value),
      openingBalance: toNumber(elements.sfOpeningBalance.value),
      transactions: readSimpliiRows(elements.simpliiTransactionsTable),
    },
    noaStatement: {
      name: safeText(elements.noaName.value),
      address: elements.noaAddress.value.trim(),
      location: safeText(elements.noaLocation.value),
      sin: safeText(elements.noaSin.value),
      taxYear: safeText(elements.noaTaxYear.value),
      dateIssued: safeText(elements.noaDateIssued.value),
      refNumber: safeText(elements.noaRefNumber.value),
      refCode: safeText(elements.noaRefCode.value),
      accountNumber: safeText(elements.noaAccountNumber.value),
      annualIncome: toNumber(elements.noaAnnualIncome.value),
      taxDeducted: toNumber(elements.noaTaxDeducted.value),
      balanceOverride: elements.noaBalanceOverride.value !== "" ? toNumber(elements.noaBalanceOverride.value) : null,
      balanceOverrideCrdr: elements.noaBalanceOverrideCrdr.value,
      commissioner: safeText(elements.noaCommissioner.value),
      explanation: elements.noaExplanation.value.trim(),
      summaryRows: readNoaRows(elements.noaSummaryTable),
    },
    t4Slip: readT4SlipForm(),
    bmoVoidCheck: {
      name: safeText(elements.bmoVoidName.value),
      address: elements.bmoVoidAddress.value.trim(),
      transit: safeText(elements.bmoVoidTransit.value),
      institution: safeText(elements.bmoVoidInstitution.value),
      account: safeText(elements.bmoVoidAccount.value),
    },
    scotiaVoidCheck: readScotiaVoidForm(),
    rbcVoidCheck: {
      name: safeText(elements.rbcVoidName.value),
      transit: safeText(elements.rbcVoidTransit.value),
      institution: safeText(elements.rbcVoidInstitution.value),
      account: safeText(elements.rbcVoidAccount.value),
    },
    tdVoidCheck: {
      customerName: safeText(elements.tdVoidCustomerName.value),
      customerAddress: elements.tdVoidCustomerAddress.value.trim(),
      transit: safeText(elements.tdVoidTransit.value),
      institution: safeText(elements.tdVoidInstitution.value),
      account: safeText(elements.tdVoidAccount.value),
      designation: safeText(elements.tdVoidDesignation.value),
      swiftBic: safeText(elements.tdVoidSwiftBic.value),
      branchAddress: elements.tdVoidBranchAddress.value.trim(),
      customerAccountNumber: safeText(elements.tdVoidCustomerAccountNumber.value),
    },
    cibcVoidCheck: {
      name: safeText(elements.cibcVoidName.value),
      address: elements.cibcVoidAddress.value.trim(),
      date: safeText(elements.cibcVoidDate.value),
      transit: safeText(elements.cibcVoidTransit.value),
      institution: safeText(elements.cibcVoidInstitution.value),
      account: safeText(elements.cibcVoidAccount.value),
      branchAddress: elements.cibcVoidBranchAddress.value.trim(),
    },
  };
}

function hydrateForm(data) {
  setDocumentType(data.documentType ?? "payroll");
  elements.companyName.value = data.companyName ?? "";
  elements.brandText.value = data.brandText ?? "";
  elements.brandColor.value = data.brandColor ?? "#096250";
  payrollLogoDataUrl = safeText(data.payrollLogoDataUrl);
  if (elements.payrollLogoFile) elements.payrollLogoFile.value = "";
  elements.designTemplate.value = data.designTemplate ?? "classic-blue";
  elements.periodEnding.value = data.periodEnding ?? "";
  elements.payDate.value = data.payDate ?? "";
  elements.province.value = (data.province ?? "AB").toUpperCase();
  elements.frequency.value = data.frequency ?? "monthly";
  elements.employeeName.value = data.employeeName ?? "";
  elements.employeeId.value = data.employeeId ?? "";
  elements.employeeAddress.value = data.employeeAddress ?? "";
  elements.vacHours.value = data.vacHours ?? 0;
  elements.sickHours.value = data.sickHours ?? 0;
  elements.notes.value = data.notes ?? "";
  writeRows(elements.earningsTable, "earnings", data.earnings ?? []);
  writeRows(elements.deductionsTable, "deductions", data.deductions ?? []);
  writeRows(elements.benefitsTable, "benefits", data.benefits ?? []);

  const ev = data.employmentVerification ?? {};
  elements.evDate.value = ev.date ?? "";
  elements.evEmployeeName.value = ev.employeeName ?? "";
  elements.evStartDate.value = ev.startDate ?? "";
  elements.evEmployeeAddress.value = ev.employeeAddress ?? "";
  elements.evCompanyName.value = ev.companyName ?? "";
  elements.evCompanyAddress.value = ev.companyAddress ?? "";
  elements.evAnnualIncome.value = ev.annualIncome ?? "";
  elements.evPosition.value = ev.position ?? "";
  employmentLogoDataUrl = safeText(ev.logoDataUrl);
  if (elements.evLogoFile) elements.evLogoFile.value = "";

  const statement = data.statement ?? {};
  elements.stName.value = statement.name ?? "";
  elements.stAddress.value = statement.address ?? "";
  elements.stBranchAddress.value = statement.branchAddress ?? "";
  elements.stBranchNo.value = statement.branchNo ?? "";
  elements.stAccountNo.value = statement.accountNo ?? "";
  elements.stFrom.value = statement.statementFrom ?? "";
  elements.stTo.value = statement.statementTo ?? "";
  elements.stOpeningBalance.value = statement.openingBalance ?? "";
  elements.stAccountType.value = statement.accountType ?? "";
  writeStatementRows(elements.statementTransactionsTable, statement.transactions ?? []);

  const scotia = data.scotiaStatement ?? {};
  elements.scName.value = scotia.name ?? "";
  elements.scAddress.value = scotia.address ?? "";
  elements.scBranchAddress.value = scotia.branchAddress ?? "";
  elements.scAccountNo.value = scotia.accountNo ?? "";
  elements.scAccountType.value = scotia.accountType ?? "";
  elements.scFrom.value = scotia.statementFrom ?? "";
  elements.scTo.value = scotia.statementTo ?? "";
  elements.scOpeningBalance.value = scotia.openingBalance ?? "";
  writeScotiaRows(elements.scotiaTransactionsTable, scotia.transactions ?? []);

  const cibc = data.cibcStatement ?? {};
  elements.cbName.value = cibc.name ?? "";
  elements.cbAddress.value = cibc.address ?? "";
  elements.cbAccountNo.value = cibc.accountNo ?? "";
  elements.cbBranchTransit.value = cibc.branchTransit ?? "";
  elements.cbFrom.value = cibc.statementFrom ?? "";
  elements.cbTo.value = cibc.statementTo ?? "";
  elements.cbOpeningBalance.value = cibc.openingBalance ?? "";
  elements.cbDisclaimer.value = cibc.disclaimer ?? "";
  writeCibcRows(elements.cibcTransactionsTable, cibc.transactions ?? []);

  const rbc = data.rbcStatement ?? {};
  elements.rbName.value = rbc.name ?? "";
  elements.rbAddress.value = rbc.address ?? "";
  elements.rbAccountNo.value = rbc.accountNo ?? "";
  elements.rbAccountType.value = rbc.accountType ?? "personal";
  elements.rbBankBranch.value = rbc.bankBranch ?? "";
  elements.rbFrom.value = rbc.statementFrom ?? "";
  elements.rbTo.value = rbc.statementTo ?? "";
  elements.rbOpeningBalance.value = rbc.openingBalance ?? "";
  writeRbcRows(elements.rbcTransactionsTable, rbc.transactions ?? []);

  const bmo = data.bmoStatement ?? {};
  elements.bmName.value = bmo.name ?? "";
  elements.bmAddress.value = bmo.address ?? "";
  elements.bmBranchAddress.value = bmo.branchAddress ?? "";
  elements.bmBranchName.value = bmo.branchName ?? "";
  elements.bmTransitNo.value = bmo.transitNo ?? "";
  elements.bmPhone.value = bmo.phone ?? "";
  elements.bmPlanName.value = bmo.planName ?? "";
  elements.bmAccountNo.value = bmo.accountNo ?? "";
  elements.bmAccountType.value = bmo.accountType ?? "";
  elements.bmPeriodEnd.value = bmo.periodEnd ?? "";
  elements.bmOpeningBalance.value = bmo.openingBalance ?? "";
  writeBmoRows(elements.bmoTransactionsTable, bmo.transactions ?? []);

  const simplii = data.simpliiStatement ?? {};
  elements.sfName.value = simplii.name ?? "";
  elements.sfAddress.value = simplii.address ?? "";
  elements.sfAccountNo.value = simplii.accountNo ?? "";
  elements.sfFrom.value = simplii.statementPeriodFrom ?? "";
  elements.sfTo.value = simplii.statementPeriodTo ?? "";
  elements.sfStatementDate.value = simplii.statementDate ?? "";
  elements.sfOpeningBalance.value = simplii.openingBalance ?? "";
  writeSimpliiRows(elements.simpliiTransactionsTable, simplii.transactions ?? []);

  const noa = data.noaStatement ?? {};
  elements.noaName.value = noa.name ?? "";
  elements.noaAddress.value = noa.address ?? "";
  elements.noaLocation.value = noa.location ?? "";
  elements.noaSin.value = noa.sin ?? "";
  elements.noaTaxYear.value = noa.taxYear ?? "";
  elements.noaDateIssued.value = noa.dateIssued ?? "";
  elements.noaRefNumber.value = noa.refNumber ?? "";
  elements.noaRefCode.value = noa.refCode ?? "";
  elements.noaAccountNumber.value = noa.accountNumber ?? "";
  elements.noaAnnualIncome.value = noa.annualIncome ?? "";
  elements.noaTaxDeducted.value = noa.taxDeducted ?? 0;
  elements.noaBalanceOverride.value = noa.balanceOverride != null ? noa.balanceOverride : "";
  elements.noaBalanceOverrideCrdr.value = noa.balanceOverrideCrdr ?? "DR";
  elements.noaCommissioner.value = noa.commissioner ?? "Bob Hamilton";
  elements.noaExplanation.value = noa.explanation ?? "";
  writeNoaRows(elements.noaSummaryTable, noa.summaryRows ?? []);

  hydrateT4SlipForm(data.t4Slip ?? {});

  const bv = data.bmoVoidCheck ?? {};
  elements.bmoVoidName.value = bv.name ?? "";
  elements.bmoVoidAddress.value = bv.address ?? "";
  elements.bmoVoidTransit.value = bv.transit ?? "";
  elements.bmoVoidInstitution.value = bv.institution ?? "";
  elements.bmoVoidAccount.value = bv.account ?? "";

  hydrateScotiaVoidForm(data.scotiaVoidCheck ?? {});

  const rv = data.rbcVoidCheck ?? {};
  elements.rbcVoidName.value = rv.name ?? "";
  elements.rbcVoidTransit.value = rv.transit ?? "";
  elements.rbcVoidInstitution.value = rv.institution ?? "";
  elements.rbcVoidAccount.value = rv.account ?? "";

  const tv = data.tdVoidCheck ?? {};
  elements.tdVoidCustomerName.value = tv.customerName ?? "";
  elements.tdVoidCustomerAddress.value = tv.customerAddress ?? "";
  elements.tdVoidTransit.value = tv.transit ?? "";
  elements.tdVoidInstitution.value = tv.institution ?? "";
  elements.tdVoidAccount.value = tv.account ?? "";
  elements.tdVoidDesignation.value = tv.designation ?? "";
  elements.tdVoidSwiftBic.value = tv.swiftBic ?? "";
  elements.tdVoidBranchAddress.value = tv.branchAddress ?? "";
  elements.tdVoidCustomerAccountNumber.value = tv.customerAccountNumber ?? "";

  const cv = data.cibcVoidCheck ?? {};
  elements.cibcVoidName.value = cv.name ?? "";
  elements.cibcVoidAddress.value = cv.address ?? "";
  elements.cibcVoidDate.value = cv.date ?? "";
  elements.cibcVoidTransit.value = cv.transit ?? "";
  elements.cibcVoidInstitution.value = cv.institution ?? "";
  elements.cibcVoidAccount.value = cv.account ?? "";
  elements.cibcVoidBranchAddress.value = cv.branchAddress ?? "";
}

function toEngineRateHours(amount) {
  if (!Number.isFinite(amount) || amount === 0) {
    return { rate: 0, hours: 0 };
  }
  return { rate: amount, hours: 1 };
}

function deriveEngineInput(data, computedEarnings) {
  let regularAmount = 0;
  let overtimeAmount = 0;
  let statutoryAmount = 0;

  for (const item of computedEarnings) {
    const label = item.label.toLowerCase();
    if (label.includes("overtime")) {
      overtimeAmount += item.periodComputed;
    } else if (label.includes("stat")) {
      statutoryAmount += item.periodComputed;
    } else {
      regularAmount += item.periodComputed;
    }
  }

  const regular = toEngineRateHours(regularAmount);
  const overtime = toEngineRateHours(overtimeAmount);
  const statutory = toEngineRateHours(statutoryAmount);

  return {
    rate: regular.rate,
    hours: regular.hours,
    overtimeRate: overtime.rate,
    overtimeHours: overtime.hours,
    statutoryRate: statutory.rate,
    statutoryHours: statutory.hours,
    province: data.province,
    payDate: data.payDate,
    frequency: data.frequency,
  };
}

function lockCalculatedDeductions() {
  for (const row of elements.deductionsTable.querySelectorAll("tr")) {
    for (const input of row.querySelectorAll("input")) {
      input.readOnly = true;
      input.tabIndex = -1;
      input.classList.add("readonly");
    }
    const remove = row.querySelector(".remove-row");
    if (remove) remove.style.display = "none";
  }
}

function updateCalculatedEarningsTable(periods) {
  for (const row of elements.earningsTable.querySelectorAll("tr")) {
    const rateInput = row.querySelector('[data-key="rate"]');
    const hoursInput = row.querySelector('[data-key="hours"]');
    const periodInput = row.querySelector('[data-key="period"]');
    const ytdInput = row.querySelector('[data-key="ytd"]');

    if (!rateInput || !hoursInput || !periodInput || !ytdInput) continue;

    const period = toNumber(rateInput.value) * toNumber(hoursInput.value);
    const ytd = period * periods;

    periodInput.value = period.toFixed(2);
    ytdInput.value = ytd.toFixed(2);
    periodInput.readOnly = true;
    ytdInput.readOnly = true;
    periodInput.classList.add("readonly");
    ytdInput.classList.add("readonly");
  }
}

function calculate(data) {
  const periods = PayrollEngine.getPayPeriods(data.payDate, data.frequency);
  const earnings = data.earnings.map((item) => {
    const thisPeriod = item.rate * item.hours;
    const ytd = thisPeriod * periods;
    return {
      ...item,
      periodComputed: thisPeriod,
      ytdComputed: ytd,
    };
  });

  const engineInput = deriveEngineInput(data, earnings);
  const payroll = PayrollEngine.runPayroll(engineInput);

  const grossThis = payroll.earnings.thisPeriod.gross;
  const grossYtd = earnings.reduce((sum, item) => sum + item.ytdComputed, 0);

  const deductionRows = [
    {
      label: "Federal Tax",
      period: payroll.deductions.thisPeriod.federal,
      ytd: payroll.deductions.ytd.federal,
    },
    {
      label: "Provincial Tax",
      period: payroll.deductions.thisPeriod.provincial,
      ytd: payroll.deductions.ytd.provincial,
    },
    {
      label: "E.I*",
      period: payroll.deductions.thisPeriod.ei,
      ytd: payroll.deductions.ytd.ei,
    },
    {
      label: payroll.metadata.isQuebec ? "QPP*" : "CPP*",
      period: payroll.deductions.thisPeriod.cpp_or_qpp,
      ytd: payroll.deductions.ytd.cpp_or_qpp,
    },
  ];

  if (payroll.metadata.isQuebec) {
    deductionRows.push({
      label: "QPIP",
      period: payroll.deductions.thisPeriod.qpip,
      ytd: payroll.deductions.ytd.qpip,
    });
  }

  const deductionsThis = deductionRows.reduce((sum, item) => sum + item.period, 0);
  const deductionsYtd = deductionRows.reduce((sum, item) => sum + item.ytd, 0);

  const benefitsThis = data.benefits.reduce((sum, item) => sum + item.period, 0);
  const benefitsYtd = data.benefits.reduce((sum, item) => sum + item.ytd, 0);

  const netThis = payroll.net.thisPeriod + benefitsThis;
  const netYtd = payroll.net.ytd + benefitsYtd;

  return {
    earnings,
    deductionRows,
    periods,
    grossThis,
    grossYtd,
    deductionsThis,
    deductionsYtd,
    benefitsThis,
    benefitsYtd,
    netThis,
    netYtd,
  };
}

function renderEmploymentPreview(data) {
  const ev = data.employmentVerification;
  const employeeName = ev.employeeName || data.employeeName || "Employee";
  const firstName = employeeName.split(" ")[0] || "The employee";
  const companyName = ev.companyName || data.companyName || "Company";
  const startDate = formatLongDate(ev.startDate);
  const letterDate = formatDate(ev.date);
  const annualIncome = formatMoney(ev.annualIncome || 0);
  const position = ev.position || "Employee";
  const companyAddress = ev.companyAddress || "the listed company address";
  const employeeAddress = ev.employeeAddress || "the employee's address on file";
  const logoDataUrl = safeText(ev.logoDataUrl);
  const hasLogo = logoDataUrl.startsWith("data:image/");

  elements.pvEvDate.textContent = letterDate;
  elements.pvEvEmployeeNameUpper.textContent = employeeName.toUpperCase();
  elements.pvEvCompanyNameTop.textContent = companyName.toUpperCase();
  elements.pvEvCompanyNameBottom.textContent = companyName;
  elements.pvEvCompanyNameTop.classList.toggle("is-hidden", hasLogo);
  elements.pvEvLogoImage.classList.toggle("is-hidden", !hasLogo);
  elements.pvEvWatermark.classList.toggle("is-hidden", !hasLogo);

  if (hasLogo) {
    elements.pvEvLogoImage.src = logoDataUrl;
    elements.pvEvWatermark.src = logoDataUrl;
  } else {
    elements.pvEvLogoImage.removeAttribute("src");
    elements.pvEvWatermark.removeAttribute("src");
  }

  elements.pvEvParagraph1.textContent =
    `This letter is to formally verify the employment of ${employeeName} with ${companyName}, headquartered at ${companyAddress}. ${employeeName} currently resides at ${employeeAddress}.`;

  elements.pvEvParagraph2.textContent =
    `${firstName} has been an integral member of our organization since ${startDate || "the stated start date"}, and is currently engaged in a full-time capacity as ${position}.`;

  elements.pvEvParagraph3.textContent =
    `${firstName} continues to fulfill all responsibilities associated with this role and remains an employee in good standing with the company.`;

  elements.pvEvParagraph4.textContent =
    `As of the date of this letter, ${firstName}'s current annual salary is $${annualIncome} CAD. This confirmation is issued at the request of the employee for verification purposes.`;
}

function formatStatementAmount(value, force = false) {
  const amount = toNumber(value);
  if (!force && amount === 0) return "";
  return formatMoney(amount);
}

function splitAddressLines(value) {
  const lines = String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return [lines[0] ?? "", lines[1] ?? ""];
}

function normalizeStatementTransaction(row) {
  return {
    description: safeText(row?.description).toUpperCase(),
    debit: Math.max(0, toNumber(row?.debit)),
    credit: Math.max(0, toNumber(row?.credit)),
    date: safeText(row?.date).toUpperCase(),
  };
}

function buildStatementPages(statement) {
  const openingBalance = toNumber(statement.openingBalance);
  const transactions = (statement.transactions ?? []).map(normalizeStatementTransaction);
  const rowsPerPage = 31;
  const page1Transactions = transactions.slice(0, rowsPerPage);
  const page2Transactions = transactions.slice(rowsPerPage, rowsPerPage * 2);

  let runningBalance = openingBalance;
  const toRenderedRows = (rows) =>
    rows.map((row) => {
      runningBalance += row.credit - row.debit;
      return {
        ...row,
        balance: runningBalance,
      };
    });

  const page1Rows = [
    {
      description: "STARTING BALANCE",
      debit: 0,
      credit: 0,
      date: "",
      balance: openingBalance,
      isBalanceForward: true,
    },
    ...toRenderedRows(page1Transactions),
  ];

  const page2Opening = runningBalance;
  const page2Rows = [
    {
      description: "BALANCE FORWARD",
      debit: 0,
      credit: 0,
      date: "",
      balance: page2Opening,
      isBalanceForward: true,
    },
    ...toRenderedRows(page2Transactions),
  ];

  const sum = (rows, key) => rows.reduce((total, row) => total + toNumber(row[key]), 0);
  return {
    page1Rows,
    page2Rows,
    page1Debit: sum(page1Transactions, "debit"),
    page1Credit: sum(page1Transactions, "credit"),
    page2Debit: sum(page2Transactions, "debit"),
    page2Credit: sum(page2Transactions, "credit"),
  };
}

function renderStatementRows(target, rows) {
  if (!target) return;
  target.innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td>${escapeAttr(row.description)}</td>
          <td>${formatStatementAmount(row.debit)}</td>
          <td>${formatStatementAmount(row.credit)}</td>
          <td>${escapeAttr(row.date)}</td>
          <td>${formatStatementAmount(row.balance, true)}</td>
        </tr>
      `
    )
    .join("");
}

function buildScotiaPages(scotiaData) {
  const openingBalance = toNumber(scotiaData.openingBalance);
  const transactions = (scotiaData.transactions ?? []).slice(0, 34).map(normalizeScotiaTransaction);

  const rowsPerPage = 14;
  const page1Transactions = transactions.slice(0, rowsPerPage);
  const page2Transactions = transactions.slice(rowsPerPage);

  let runningBalance = openingBalance;
  let totalWithdrawals = 0;
  let totalDeposits = 0;

  const toRenderedRows = (rows) =>
    rows.map((row) => {
      totalWithdrawals += row.withdrawn;
      totalDeposits += row.deposited;
      runningBalance += row.deposited - row.withdrawn;
      return { ...row, balance: runningBalance };
    });

  const page1Rows = toRenderedRows(page1Transactions);
  const balanceAfterPage1 = runningBalance;
  const page2Rows = toRenderedRows(page2Transactions);
  const closingBalance = runningBalance;

  return {
    page1Rows,
    page2Rows,
    totalWithdrawals,
    totalDeposits,
    closingBalance,
    balanceAfterPage1,
  };
}

function formatScotiaDate(date) {
  return safeText(date).replace(/^([A-Za-z]{3})\s+0?(\d{1,2})$/, (_, mon, day) => `${mon}${String(day).padStart(2, "0")}`);
}

function formatScotiaMerchantDetail(text) {
  return safeText(text)
    .replace(/\b(ONCA|ABCA|BCCA|QCCA|SKCA|MBCA|NSCA|NBCA|NLCA|PECA)\b/gi, (m) => m.slice(0, 2).toUpperCase())
    .toLowerCase()
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .replace(/\bTtc\b/g, "TTC")
    .replace(/\bPresto\b/g, "PRESTO")
    .replace(/\bLcbo\b/g, "LCBO")
    .replace(/\bAtco\b/g, "ATCO")
    .replace(/\bEnmax\b/g, "ENMAX")
    .replace(/\bInc\b/g, "Inc")
    .replace(/\bLtd\b/g, "Ltd");
}

function normalizeScotiaTransaction(row) {
  const withdrawn = Math.max(0, toNumber(row?.withdrawn));
  const deposited = Math.max(0, toNumber(row?.deposited));
  let description = safeText(row?.description);
  let detail = safeText(row?.detail);
  const combined = [description, detail].filter(Boolean).join(" ");

  if (deposited > 0 && /payroll|direct\s*deposit/i.test(combined)) {
    description = "Direct Deposit";
    detail = detail || description;
    detail = combined.replace(/\b(OPOS|APOS)\b/gi, "").trim();
  } else if (/^(OPOS|APOS)\b/i.test(description)) {
    description = "Purchase";
    detail = formatScotiaMerchantDetail(description.replace(/^(OPOS|APOS)\s+/i, ""));
  } else if (/purchase/i.test(description)) {
    description = "Purchase";
    detail = formatScotiaMerchantDetail(detail);
  }

  return {
    date: formatScotiaDate(row?.date),
    description,
    detail,
    withdrawn,
    deposited,
  };
}

function renderScotiaRows(target, rows) {
  if (!target) return;
  target.innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td>${escapeAttr(row.date)}</td>
          <td class="sc-desc"><span class="sc-desc-type">${escapeAttr(row.description)}</span><span class="sc-desc-detail">${escapeAttr(row.detail)}</span></td>
          <td>${row.withdrawn > 0 ? formatMoney(row.withdrawn) : ""}</td>
          <td>${row.deposited > 0 ? formatMoney(row.deposited) : ""}</td>
          <td>${formatMoney(row.balance)}</td>
        </tr>
      `
    )
    .join("");
}

function renderScotiaPreview(data) {
  const scotia = data.scotiaStatement ?? {};
  const openingBalance = toNumber(scotia.openingBalance);
  const layout = buildScotiaPages(scotia);
  const fromTo = [safeText(scotia.statementFrom), safeText(scotia.statementTo)].filter(Boolean).join(" - ");

  const pvScBranchAddress = document.getElementById("pvScBranchAddress");
  if (pvScBranchAddress) pvScBranchAddress.textContent = scotia.branchAddress ?? "";

  const pvScNamePage1 = document.getElementById("pvScNamePage1");
  if (pvScNamePage1) pvScNamePage1.textContent = scotia.name ?? "";

  const pvScAddressPage1 = document.getElementById("pvScAddressPage1");
  if (pvScAddressPage1) pvScAddressPage1.textContent = scotia.address ?? "";

  const pvScAccountNo1 = document.getElementById("pvScAccountNo1");
  if (pvScAccountNo1) pvScAccountNo1.textContent = scotia.accountNo ?? "";

  const pvScAccountType1 = document.getElementById("pvScAccountType1");
  if (pvScAccountType1) pvScAccountType1.textContent = scotia.accountType ?? "";

  const pvScFromTo1 = document.getElementById("pvScFromTo1");
  if (pvScFromTo1) pvScFromTo1.textContent = scotia.statementFrom ?? "";

  const pvScOpeningBal = document.getElementById("pvScOpeningBal");
  if (pvScOpeningBal) pvScOpeningBal.textContent = formatMoney(openingBalance);

  const pvScTotalWithdrawals = document.getElementById("pvScTotalWithdrawals");
  if (pvScTotalWithdrawals) pvScTotalWithdrawals.textContent = formatMoney(layout.totalWithdrawals);

  const pvScTotalDeposits = document.getElementById("pvScTotalDeposits");
  if (pvScTotalDeposits) pvScTotalDeposits.textContent = formatMoney(layout.totalDeposits);

  const pvScClosingBal = document.getElementById("pvScClosingBal");
  if (pvScClosingBal) pvScClosingBal.textContent = formatMoney(layout.closingBalance);

  const pvScClosingDate1 = document.getElementById("pvScClosingDate1");
  if (pvScClosingDate1) pvScClosingDate1.textContent = scotia.statementTo ?? "";

  const pvScRowsPage1 = document.getElementById("pvScRowsPage1");
  const openingRow = `<tr class="sc-opening-row"><td></td><td class="sc-desc"><span class="sc-desc-type">Opening Balance</span></td><td></td><td></td><td>${formatMoney(openingBalance)}</td></tr>`;
  if (pvScRowsPage1) {
    pvScRowsPage1.innerHTML = openingRow;
    const tempDiv = document.createElement("tbody");
    renderScotiaRows(tempDiv, layout.page1Rows);
    pvScRowsPage1.innerHTML += tempDiv.innerHTML;
  }

  const pvScRowsPage2 = document.getElementById("pvScRowsPage2");
  if (pvScRowsPage2) {
    const balFwdRow = `<tr class="sc-opening-row"><td></td><td class="sc-desc"><span class="sc-desc-type">Balance Forward</span></td><td></td><td></td><td>${formatMoney(layout.balanceAfterPage1)}</td></tr>`;
    pvScRowsPage2.innerHTML = balFwdRow;
    const tempDiv2 = document.createElement("tbody");
    renderScotiaRows(tempDiv2, layout.page2Rows);
    pvScRowsPage2.innerHTML += tempDiv2.innerHTML;
  }

  const pvScNamePage2 = document.getElementById("pvScNamePage2");
  if (pvScNamePage2) pvScNamePage2.textContent = scotia.name ?? "";

  const pvScAccountType2 = document.getElementById("pvScAccountType2");
  if (pvScAccountType2) pvScAccountType2.textContent = scotia.accountType ?? "";

  const pvScFromTo2 = document.getElementById("pvScFromTo2");
  if (pvScFromTo2) pvScFromTo2.textContent = fromTo;

  const pvScAccountNo2 = document.getElementById("pvScAccountNo2");
  if (pvScAccountNo2) pvScAccountNo2.textContent = scotia.accountNo ?? "";

  renderScotiaBarcode(document.getElementById("scBarcodesvg1"), (scotia.accountNo ?? "") + (scotia.name ?? ""));
}

function renderScotiaBarcode(canvasEl, seed) {
  if (!canvasEl) return;
  const W = 660;
  const H = 36;
  canvasEl.width = W;
  canvasEl.height = H;
  const ctx = canvasEl.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#000000";

  let rng = 5381;
  for (let i = 0; i < seed.length; i++) {
    rng = ((rng << 5) + rng) ^ seed.charCodeAt(i);
    rng = rng >>> 0;
  }
  function next() {
    rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5;
    return (rng = rng >>> 0);
  }

  let x = 8;
  // Start guard
  ctx.fillRect(x, 0, 2, H); x += 4;
  ctx.fillRect(x, 0, 2, H); x += 3;
  let black = false;
  const widths = [1, 1, 1, 2, 2, 3];
  while (x < 648) {
    const w = widths[next() % 6];
    if (black) ctx.fillRect(x, 0, w, H);
    black = !black;
    x += w;
  }
  // Stop guard
  ctx.fillRect(x, 0, 3, H); x += 4;
  ctx.fillRect(x, 0, 1, H); x += 2;
  ctx.fillRect(x, 0, 3, H);
}

async function saveScotiaPdf(filename) {
  return saveTwoPagePdf(filename, "scotiaPage1", "scotiaPage2", "letter");
}

function buildCibcPages(cibcData) {
  const openingBalance = toNumber(cibcData.openingBalance);
  const transactions = (cibcData.transactions ?? []).slice(0, 30).map((row) => ({
    date: safeText(row?.date),
    description: safeText(row?.description),
    detail: safeText(row?.detail),
    withdrawn: Math.max(0, toNumber(row?.withdrawn)),
    deposited: Math.max(0, toNumber(row?.deposited)),
  }));

  const rowsPerPage = 12;
  const page1Transactions = transactions.slice(0, rowsPerPage);
  const page2Transactions = transactions.slice(rowsPerPage);

  let runningBalance = openingBalance;
  let totalWithdrawals = 0;
  let totalDeposits = 0;

  const toRenderedRows = (rows) =>
    rows.map((row) => {
      totalWithdrawals += row.withdrawn;
      totalDeposits += row.deposited;
      runningBalance += row.deposited - row.withdrawn;
      return { ...row, balance: runningBalance };
    });

  const page1Rows = toRenderedRows(page1Transactions);
  const balanceAfterPage1 = runningBalance;
  const page2Rows = toRenderedRows(page2Transactions);
  const closingBalance = runningBalance;

  return {
    page1Rows,
    page2Rows,
    totalWithdrawals,
    totalDeposits,
    closingBalance,
    balanceAfterPage1,
  };
}

function renderCibcRows(target, rows) {
  if (!target) return;
  target.innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td>${escapeAttr(row.date)}</td>
          <td class="cb-desc"><span class="cb-desc-type">${escapeAttr(row.description)}</span><span class="cb-desc-detail">${escapeAttr(row.detail)}</span></td>
          <td class="cb-amount">${row.withdrawn > 0 ? formatMoney(row.withdrawn) : ""}</td>
          <td class="cb-amount">${row.deposited > 0 ? formatMoney(row.deposited) : ""}</td>
          <td class="cb-amount">${formatMoney(row.balance)}</td>
        </tr>
      `
    )
    .join("");
}

function renderCibcPreview(data) {
  const cibc = data.cibcStatement ?? {};
  const openingBalance = toNumber(cibc.openingBalance);
  const layout = buildCibcPages(cibc);
  const dateRange = [safeText(cibc.statementFrom), safeText(cibc.statementTo)].filter(Boolean).join(" to ");

  const pvCbNamePage1 = document.getElementById("pvCbNamePage1");
  if (pvCbNamePage1) pvCbNamePage1.textContent = cibc.name ?? "";

  const pvCbAddressPage1 = document.getElementById("pvCbAddressPage1");
  if (pvCbAddressPage1) pvCbAddressPage1.textContent = cibc.address ?? "";

  const pvCbDateRange1 = document.getElementById("pvCbDateRange1");
  if (pvCbDateRange1) pvCbDateRange1.textContent = dateRange;

  const pvCbAccountNo1 = document.getElementById("pvCbAccountNo1");
  if (pvCbAccountNo1) pvCbAccountNo1.textContent = cibc.accountNo ?? "";

  const pvCbBranchTransit1 = document.getElementById("pvCbBranchTransit1");
  if (pvCbBranchTransit1) pvCbBranchTransit1.textContent = cibc.branchTransit ?? "";

  const pvCbDisclaimer = document.getElementById("pvCbDisclaimer");
  if (pvCbDisclaimer) pvCbDisclaimer.textContent = cibc.disclaimer ?? "";

  const pvCbOpenDate = document.getElementById("pvCbOpenDate");
  if (pvCbOpenDate) pvCbOpenDate.textContent = cibc.statementFrom ?? "";

  const pvCbCloseDate = document.getElementById("pvCbCloseDate");
  if (pvCbCloseDate) pvCbCloseDate.textContent = cibc.statementTo ?? "";

  const pvCbOpeningBal = document.getElementById("pvCbOpeningBal");
  if (pvCbOpeningBal) pvCbOpeningBal.textContent = formatMoney(openingBalance);

  const pvCbTotalWithdrawals = document.getElementById("pvCbTotalWithdrawals");
  if (pvCbTotalWithdrawals) pvCbTotalWithdrawals.textContent = "-" + formatMoney(layout.totalWithdrawals);

  const pvCbTotalDeposits = document.getElementById("pvCbTotalDeposits");
  if (pvCbTotalDeposits) pvCbTotalDeposits.textContent = "+" + formatMoney(layout.totalDeposits);

  const pvCbClosingBal = document.getElementById("pvCbClosingBal");
  if (pvCbClosingBal) pvCbClosingBal.textContent = formatMoney(layout.closingBalance);

  const pvCbRowsPage1 = document.getElementById("pvCbRowsPage1");
  const openingRow = `<tr class="cb-opening-row"><td></td><td class="cb-desc"><span class="cb-desc-type"><strong>Opening balance</strong></span></td><td></td><td></td><td class="cb-amount"><strong>${formatMoney(openingBalance)}</strong></td></tr>`;
  if (pvCbRowsPage1) {
    pvCbRowsPage1.innerHTML = openingRow;
    const tempDiv = document.createElement("tbody");
    renderCibcRows(tempDiv, layout.page1Rows);
    pvCbRowsPage1.innerHTML += tempDiv.innerHTML;
  }

  const pvCbRowsPage2 = document.getElementById("pvCbRowsPage2");
  if (pvCbRowsPage2) {
    const balFwdRow = `<tr class="cb-opening-row"><td></td><td class="cb-desc"><span class="cb-desc-type">Balance Forward</span></td><td></td><td></td><td class="cb-amount">${formatMoney(layout.balanceAfterPage1)}</td></tr>`;
    pvCbRowsPage2.innerHTML = balFwdRow;
    const tempDiv2 = document.createElement("tbody");
    renderCibcRows(tempDiv2, layout.page2Rows);
    pvCbRowsPage2.innerHTML += tempDiv2.innerHTML;
    const closingRow = `<tr class="cb-closing-row"><td></td><td class="cb-desc"><span class="cb-desc-type"><strong>Closing balance</strong></span></td><td></td><td></td><td class="cb-amount"><strong>${formatMoney(layout.closingBalance)}</strong></td></tr>`;
    pvCbRowsPage2.innerHTML += closingRow;
  }

  const pvCbDateRange2 = document.getElementById("pvCbDateRange2");
  if (pvCbDateRange2) pvCbDateRange2.textContent = dateRange;

  const pvCbAccountNo2 = document.getElementById("pvCbAccountNo2");
  if (pvCbAccountNo2) pvCbAccountNo2.textContent = cibc.accountNo ?? "";

  const pvCbBranchTransit2 = document.getElementById("pvCbBranchTransit2");
  if (pvCbBranchTransit2) pvCbBranchTransit2.textContent = cibc.branchTransit ?? "";
}

async function saveCibcPdf(filename) {
  return saveTwoPagePdf(filename, "cibcPage1", "cibcPage2", "a4");
}

function buildRbcPages(rbcData) {
  const openingBalance = toNumber(rbcData.openingBalance);
  const transactions = (rbcData.transactions ?? []).slice(0, 40).map((row) => ({
    date: safeText(row?.date),
    description: safeText(row?.description),
    withdrawn: Math.max(0, toNumber(row?.withdrawn)),
    deposited: Math.max(0, toNumber(row?.deposited)),
  }));

  const rowsPerPage = 26;
  const page1Transactions = transactions.slice(0, rowsPerPage);
  const page2Transactions = transactions.slice(rowsPerPage);

  let runningBalance = openingBalance;
  let totalWithdrawals = 0;
  let totalDeposits = 0;

  const toRenderedRows = (rows) =>
    rows.map((row) => {
      totalWithdrawals += row.withdrawn;
      totalDeposits += row.deposited;
      runningBalance += row.deposited - row.withdrawn;
      return { ...row, balance: runningBalance };
    });

  const page1Rows = toRenderedRows(page1Transactions);
  const balanceAfterPage1 = runningBalance;
  const page2Rows = toRenderedRows(page2Transactions);
  const closingBalance = runningBalance;

  return {
    page1Rows,
    page2Rows,
    totalWithdrawals,
    totalDeposits,
    closingBalance,
    balanceAfterPage1,
  };
}

function renderRbcRows(target, rows) {
  if (!target) return;
  target.innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td>${escapeAttr(row.date)}</td>
          <td>${escapeAttr(row.description)}</td>
          <td class="rb-amount">${row.withdrawn > 0 ? formatMoney(row.withdrawn) : ""}</td>
          <td class="rb-amount">${row.deposited > 0 ? formatMoney(row.deposited) : ""}</td>
          <td class="rb-amount">${formatMoney(row.balance)}</td>
        </tr>
      `
    )
    .join("");
}

function renderRbcPreview(data) {
  const rbc = data.rbcStatement ?? {};
  const openingBalance = toNumber(rbc.openingBalance);
  const layout = buildRbcPages(rbc);

  const isBusiness = (rbc.accountType ?? "personal") === "business";
  const titleText = isBusiness
    ? "Your business chequing account statement"
    : "Your personal chequing account statement";
  const pvRbTitle1 = document.getElementById("pvRbTitle1");
  if (pvRbTitle1) pvRbTitle1.textContent = titleText;
  const pvRbTitle2 = document.getElementById("pvRbTitle2");
  if (pvRbTitle2) pvRbTitle2.textContent = titleText;

  const pvRbBankBranch1 = document.getElementById("pvRbBankBranch1");
  if (pvRbBankBranch1) pvRbBankBranch1.textContent = rbc.bankBranch ?? "";

  const pvRbBankBranch2 = document.getElementById("pvRbBankBranch2");
  if (pvRbBankBranch2) pvRbBankBranch2.textContent = rbc.bankBranch ?? "";

  const pvRbFrom1 = document.getElementById("pvRbFrom1");
  if (pvRbFrom1) pvRbFrom1.textContent = rbc.statementFrom ?? "";

  const pvRbTo1 = document.getElementById("pvRbTo1");
  if (pvRbTo1) pvRbTo1.textContent = rbc.statementTo ?? "";

  const pvRbFrom2 = document.getElementById("pvRbFrom2");
  if (pvRbFrom2) pvRbFrom2.textContent = rbc.statementFrom ?? "";

  const pvRbTo2 = document.getElementById("pvRbTo2");
  if (pvRbTo2) pvRbTo2.textContent = rbc.statementTo ?? "";

  const pvRbName1 = document.getElementById("pvRbName1");
  if (pvRbName1) pvRbName1.textContent = rbc.name ?? "";

  const pvRbAddress1 = document.getElementById("pvRbAddress1");
  if (pvRbAddress1) pvRbAddress1.textContent = rbc.address ?? "";

  const pvRbAccountNo1 = document.getElementById("pvRbAccountNo1");
  if (pvRbAccountNo1) pvRbAccountNo1.textContent = rbc.accountNo ?? "";

  const pvRbAccountType1 = document.getElementById("pvRbAccountType1");
  if (pvRbAccountType1) pvRbAccountType1.textContent = isBusiness ? "Business Chequing" : "Personal Chequing";

  const pvRbAccountNo1b = document.getElementById("pvRbAccountNo1b");
  if (pvRbAccountNo1b) pvRbAccountNo1b.textContent = rbc.accountNo ?? "";

  const pvRbBankBranch1b = document.getElementById("pvRbBankBranch1b");
  if (pvRbBankBranch1b) pvRbBankBranch1b.textContent = rbc.bankBranch ?? "";

  const pvRbOpeningDate = document.getElementById("pvRbOpeningDate");
  if (pvRbOpeningDate) pvRbOpeningDate.textContent = rbc.statementFrom ?? "";

  const pvRbOpeningBal = document.getElementById("pvRbOpeningBal");
  if (pvRbOpeningBal) pvRbOpeningBal.textContent = "$" + formatMoney(openingBalance);

  const pvRbTotalDeposits = document.getElementById("pvRbTotalDeposits");
  if (pvRbTotalDeposits) pvRbTotalDeposits.textContent = "+ " + formatMoney(layout.totalDeposits);

  const pvRbTotalWithdrawals = document.getElementById("pvRbTotalWithdrawals");
  if (pvRbTotalWithdrawals) pvRbTotalWithdrawals.textContent = "- " + formatMoney(layout.totalWithdrawals);

  const pvRbClosingDate = document.getElementById("pvRbClosingDate");
  if (pvRbClosingDate) pvRbClosingDate.textContent = rbc.statementTo ?? "";

  const pvRbClosingBal = document.getElementById("pvRbClosingBal");
  if (pvRbClosingBal) pvRbClosingBal.textContent = "= $" + formatMoney(layout.closingBalance);

  const pvRbRowsPage1 = document.getElementById("pvRbRowsPage1");
  if (pvRbRowsPage1) {
    const tempDiv = document.createElement("tbody");
    renderRbcRows(tempDiv, layout.page1Rows);
    pvRbRowsPage1.innerHTML = tempDiv.innerHTML;
  }

  const pvRbRowsPage2 = document.getElementById("pvRbRowsPage2");
  if (pvRbRowsPage2) {
    const tempDiv2 = document.createElement("tbody");
    renderRbcRows(tempDiv2, layout.page2Rows);
    pvRbRowsPage2.innerHTML = tempDiv2.innerHTML;
  }
}

async function saveRbcPdf(filename) {
  return saveTwoPagePdf(filename, "rbcPage1", "rbcPage2", "a4");
}

function addNoaRow(tableBody, data = {}) {
  const row = document.createElement("tr");
  row.innerHTML = `
    <td><input type="text" data-key="line" value="${escapeAttr(safeText(data.line))}" placeholder="15000" style="width:60px" /></td>
    <td><input type="text" data-key="description" value="${escapeAttr(safeText(data.description))}" placeholder="Description" /></td>
    <td><input type="number" step="0.01" data-key="amount" value="${data.amount ?? ""}" /></td>
    <td>
      <select data-key="crdr">
        <option value=""${(data.crdr ?? "") === "" ? " selected" : ""}></option>
        <option value="CR"${data.crdr === "CR" ? " selected" : ""}>CR</option>
        <option value="DR"${data.crdr === "DR" ? " selected" : ""}>DR</option>
      </select>
    </td>
    <td><button type="button" class="remove-row">&times;</button><button type="button" class="duplicate-row">&#x2398;</button></td>
  `;
  tableBody.appendChild(row);
}

function readNoaRows(tableBody) {
  const rows = [];
  if (!tableBody) return rows;
  for (const row of tableBody.querySelectorAll("tr")) {
    const line = safeText(row.querySelector('[data-key="line"]')?.value);
    const description = safeText(row.querySelector('[data-key="description"]')?.value);
    const amount = toNumber(row.querySelector('[data-key="amount"]')?.value);
    const crdr = safeText(row.querySelector('[data-key="crdr"]')?.value);
    if (!line && !description && amount === 0) continue;
    rows.push({ line, description, amount, crdr });
  }
  return rows;
}

function writeNoaRows(tableBody, rows) {
  if (!tableBody) return;
  tableBody.innerHTML = "";
  for (const row of rows ?? []) {
    addNoaRow(tableBody, row);
  }
}

function generateNOA_2024(annualIncome, taxDeducted) {
  const income = Math.max(0, annualIncome);
  const deducted = Math.max(0, taxDeducted);

  const fedBrackets = [
    { limit: 55867, rate: 0.15 },
    { limit: 111733, rate: 0.205 },
    { limit: 154906, rate: 0.26 },
    { limit: 220000, rate: 0.29 },
    { limit: Infinity, rate: 0.33 },
  ];
  const provBrackets = [
    { limit: 51446, rate: 0.0505 },
    { limit: 102894, rate: 0.0915 },
    { limit: 150000, rate: 0.1116 },
    { limit: 220000, rate: 0.1216 },
    { limit: Infinity, rate: 0.1316 },
  ];

  function calcBracketTax(taxable, brackets) {
    let tax = 0;
    let prev = 0;
    for (const b of brackets) {
      if (taxable <= prev) break;
      const chunk = Math.min(taxable, b.limit) - prev;
      tax += chunk * b.rate;
      prev = b.limit;
    }
    return tax;
  }

  const cppRate = 0.0595;
  const cppExemption = 3500;
  const cppMax = 68500;
  const cppMaxContrib = 3867.50;
  const eiRate = 0.0166;
  const eiMaxInsurable = 63200;
  const eiMaxPremium = 1049.12;
  const fedBPA = 15705;
  const provBPA = 11865;

  const cppPensionable = Math.min(income, cppMax);
  const cppContrib = cppPensionable > cppExemption ? Math.min((cppPensionable - cppExemption) * cppRate, cppMaxContrib) : 0;
  const eiPremium = Math.min(income, eiMaxInsurable) * eiRate;
  const eiCapped = Math.min(eiPremium, eiMaxPremium);

  const deductions = cppContrib + eiCapped;
  const netIncome = Math.max(0, income - deductions);
  const taxableIncome = netIncome;

  const fedGross = calcBracketTax(taxableIncome, fedBrackets);
  const fedNonRefCredits = fedBPA * 0.15 + cppContrib * 0.15 + eiCapped * 0.15;
  const netFedTax = Math.max(0, fedGross - fedNonRefCredits);

  const provGross = calcBracketTax(taxableIncome, provBrackets);
  const provNonRefCredits = provBPA * 0.0505 + cppContrib * 0.0505 + eiCapped * 0.0505;
  const netProvTax = Math.max(0, provGross - provNonRefCredits);

  const totalPayable = netFedTax + cppContrib + netProvTax;
  const totalCredits = deducted;
  const balance = totalCredits - totalPayable;
  const isRefund = balance >= 0;
  const refundOrOwing = Math.abs(balance);

  const r2 = (v) => Math.round(v * 100) / 100;

  const summaryRows = [
    { line: "15000", description: "Total income", amount: r2(income), crdr: "" },
    { line: "", description: "Deductions from total income", amount: r2(deductions), crdr: "" },
    { line: "23600", description: "Net income", amount: r2(netIncome), crdr: "" },
    { line: "26000", description: "Taxable income", amount: r2(taxableIncome), crdr: "" },
    { line: "35000", description: "Total federal non-refundable tax credits", amount: r2(fedNonRefCredits), crdr: "" },
    { line: "61500", description: "Total Ontario non-refundable tax credits", amount: r2(provNonRefCredits), crdr: "" },
    { line: "42000", description: "Net federal tax", amount: r2(netFedTax), crdr: "" },
    { line: "42100", description: "CPP contributions payable", amount: r2(cppContrib), crdr: "" },
    { line: "42800", description: "Net Ontario tax", amount: r2(netProvTax), crdr: "" },
    { line: "43500", description: "Total payable", amount: r2(totalPayable), crdr: "" },
    { line: "43700", description: "Total income tax deducted", amount: r2(deducted), crdr: "" },
    { line: "47600", description: "Tax paid by instalments", amount: 0, crdr: "" },
    { line: "48200", description: "Total credits", amount: r2(totalCredits), crdr: "" },
    { line: "", description: "Total payable minus Total credits", amount: r2(refundOrOwing), crdr: isRefund ? "CR" : "DR" },
    { line: "", description: "Balance from this assessment", amount: r2(refundOrOwing), crdr: isRefund ? "CR" : "DR" },
    { line: "", description: "Direct deposit", amount: r2(refundOrOwing), crdr: isRefund ? "CR" : "DR" },
  ];

  return { summaryRows, refundOrOwing, isRefund, totalPayable, totalCredits };
}

function renderNoaPreview(data) {
  const noa = data.noaStatement ?? {};
  const annualIncome = toNumber(noa.annualIncome);
  const taxDeducted = toNumber(noa.taxDeducted);
  const calc = generateNOA_2024(annualIncome, taxDeducted);
  const manualRows = noa.summaryRows ?? [];
  const summaryRows = manualRows.length > 0 ? manualRows : calc.summaryRows;
  let refundAmount = calc.refundOrOwing;
  let isRefund = calc.isRefund;
  if (manualRows.length > 0) {
    const balanceRow = manualRows.find(r => (r.description ?? "").toLowerCase().includes("balance from this assessment"));
    if (balanceRow) {
      refundAmount = Math.abs(toNumber(balanceRow.amount));
      isRefund = (balanceRow.crdr ?? "").toUpperCase() === "CR";
    }
  }
  if (noa.balanceOverride != null && noa.balanceOverride !== "") {
    refundAmount = Math.abs(toNumber(noa.balanceOverride));
    isRefund = (noa.balanceOverrideCrdr ?? "DR").toUpperCase() === "CR";
  }

  const pvNoaRefNumberTop = document.getElementById("pvNoaRefNumberTop");
  if (pvNoaRefNumberTop) pvNoaRefNumberTop.textContent = noa.refNumber ?? "";

  const pvNoaTopLocation = document.getElementById("pvNoaTopLocation");
  if (pvNoaTopLocation) pvNoaTopLocation.textContent = noa.location ?? "";

  const pvNoaSinTop = document.getElementById("pvNoaSinTop");
  if (pvNoaSinTop) pvNoaSinTop.textContent = noa.sin ?? "";

  const pvNoaTaxYearTop = document.getElementById("pvNoaTaxYearTop");
  if (pvNoaTaxYearTop) pvNoaTaxYearTop.textContent = noa.taxYear ?? "";

  const pvNoaDateIssuedTop = document.getElementById("pvNoaDateIssuedTop");
  if (pvNoaDateIssuedTop) pvNoaDateIssuedTop.textContent = noa.dateIssued ?? "";

  const pvNoaNameMail = document.getElementById("pvNoaNameMail");
  if (pvNoaNameMail) pvNoaNameMail.textContent = noa.name ?? "";

  const pvNoaAddressBlock1 = document.getElementById("pvNoaAddressBlock1");
  if (pvNoaAddressBlock1) pvNoaAddressBlock1.textContent = noa.address ?? "";

  const pvNoaRefCodeTop = document.getElementById("pvNoaRefCodeTop");
  if (pvNoaRefCodeTop) pvNoaRefCodeTop.textContent = noa.refCode ?? "";

  const pvNoaTaxYearBody = document.getElementById("pvNoaTaxYearBody");
  if (pvNoaTaxYearBody) pvNoaTaxYearBody.textContent = noa.taxYear ?? "";

  const pvNoaBalanceSentence = document.getElementById("pvNoaBalanceSentence");
  if (pvNoaBalanceSentence) {
    if (isRefund) {
      pvNoaBalanceSentence.innerHTML = `You have a refund of <strong>$${formatMoney(refundAmount)}</strong>`;
    } else {
      pvNoaBalanceSentence.innerHTML = `You have a balance owing of <strong>$${formatMoney(refundAmount)}</strong>`;
    }
  }

  const pvNoaDepositSentence = document.getElementById("pvNoaDepositSentence");
  if (pvNoaDepositSentence) pvNoaDepositSentence.style.display = isRefund ? "" : "none";

  const pvNoaCommissioner = document.getElementById("pvNoaCommissioner");
  if (pvNoaCommissioner) pvNoaCommissioner.textContent = (noa.commissioner ?? "Bob Hamilton") + "\nCommissioner of Revenue";

  const pvNoaAccountLabel = document.getElementById("pvNoaAccountLabel");
  if (pvNoaAccountLabel) pvNoaAccountLabel.textContent = isRefund
    ? "You have a refund in the amount shown below."
    : "You have a balance owing in the amount shown below.";

  const pvNoaRefundLine = document.querySelector(".noa-refund-line span");
  if (pvNoaRefundLine) pvNoaRefundLine.textContent = isRefund ? "Refund:" : "Balance owing:";

  const pvNoaRefundAmount = document.getElementById("pvNoaRefundAmount");
  if (pvNoaRefundAmount) pvNoaRefundAmount.textContent = "$" + formatMoney(refundAmount);

  const pvNoaNameMail2 = document.getElementById("pvNoaNameMail2");
  if (pvNoaNameMail2) pvNoaNameMail2.textContent = noa.name ?? "";

  const pvNoaAddressBlock2 = document.getElementById("pvNoaAddressBlock2");
  if (pvNoaAddressBlock2) pvNoaAddressBlock2.textContent = noa.address ?? "";

  const pvNoaSinTop2 = document.getElementById("pvNoaSinTop2");
  if (pvNoaSinTop2) pvNoaSinTop2.textContent = noa.sin ?? "";

  const pvNoaTaxYearTop2 = document.getElementById("pvNoaTaxYearTop2");
  if (pvNoaTaxYearTop2) pvNoaTaxYearTop2.textContent = noa.taxYear ?? "";

  const pvNoaSummaryBody = document.getElementById("pvNoaSummaryBody");
  let ddRow = null;
  if (pvNoaSummaryBody) {
    const tableRows = [];
    for (const row of summaryRows) {
      const isDirectDeposit = (row.description ?? "").toLowerCase().includes("direct deposit");
      if (isDirectDeposit) {
        ddRow = row;
        continue;
      }
      const amountText = formatMoney(toNumber(row.amount));
      tableRows.push(`<tr>
        <td>${escapeAttr(row.line ?? "")}</td>
        <td>${escapeAttr(row.description ?? "")}</td>
        <td>${amountText}</td>
        <td>${escapeAttr(row.crdr ?? "")}</td>
      </tr>`);
    }
    pvNoaSummaryBody.innerHTML = tableRows.join("");
  }

  const pvNoaDdAmount = document.getElementById("pvNoaDdAmount");
  const pvNoaDdCrdr = document.getElementById("pvNoaDdCrdr");
  if (ddRow) {
    if (pvNoaDdAmount) pvNoaDdAmount.textContent = formatMoney(toNumber(ddRow.amount));
    if (pvNoaDdCrdr) pvNoaDdCrdr.textContent = ddRow.crdr ?? "CR";
  } else {
    if (pvNoaDdAmount) pvNoaDdAmount.textContent = formatMoney(refundAmount);
    if (pvNoaDdCrdr) pvNoaDdCrdr.textContent = isRefund ? "CR" : "DR";
  }

  const pvNoaExplanation1 = document.getElementById("pvNoaExplanation1");
  if (pvNoaExplanation1) pvNoaExplanation1.textContent = noa.explanation ?? "";
}

async function saveNoaPdf(filename) {
  return saveTwoPagePdf(filename, "noaPage1", "noaPage2", "a4");
}

function getWithholdingRate(province, income) {
  if (income < 15000) return 0.05;
  if (income < 30000) return province === "QC" ? 0.18 : 0.15;
  if (income < 50000) return province === "QC" ? 0.21 : 0.20;
  if (income < 80000) return province === "QC" ? 0.25 : 0.24;
  if (income < 120000) return province === "QC" ? 0.29 : 0.28;
  return province === "QC" ? 0.31 : 0.30;
}

const T4_PAGE = { width: 1700, height: 2200, slipOffsetY: 1076 };
const T4_EXPORT_SCALE = 1;

const T4_PREVIEW_FIELDS = [
  { key: "year", x1: 814, y1: 100, x2: 975, y2: 150, fontSize: 11, align: "center" },
  { key: "employerName", x1: 145, y1: 106, x2: 690, y2: 172, fontSize: 11, align: "left" },
  { key: "employerAccount", x1: 176, y1: 286, x2: 706, y2: 329, fontSize: 11, align: "left" },
  { key: "sin", x1: 159, y1: 383, x2: 500, y2: 433, fontSize: 12, align: "left" },
  { key: "28_cpp_qpp", x1: 574, y1: 383, x2: 614, y2: 433, fontSize: 12, align: "center" },
  { key: "28_ei", x1: 634, y1: 383, x2: 674, y2: 433, fontSize: 12, align: "center" },
  { key: "28_ppip", x1: 694, y1: 383, x2: 734, y2: 433, fontSize: 12, align: "center" },
  { key: "10", x1: 804, y1: 308, x2: 885, y2: 358, fontSize: 12, align: "center" },
  { key: "14", x1: 904, y1: 208, x2: 1177, y2: 258, fontSize: 12, align: "right" },
  { key: "16", x1: 974, y1: 308, x2: 1177, y2: 358, fontSize: 12, align: "right" },
  { key: "17", x1: 974, y1: 408, x2: 1177, y2: 458, fontSize: 12, align: "right" },
  { key: "18", x1: 974, y1: 508, x2: 1177, y2: 558, fontSize: 12, align: "right" },
  { key: "20", x1: 974, y1: 608, x2: 1177, y2: 658, fontSize: 12, align: "right" },
  { key: "22", x1: 1314, y1: 208, x2: 1547, y2: 258, fontSize: 12, align: "right" },
  { key: "24", x1: 1344, y1: 308, x2: 1547, y2: 358, fontSize: 12, align: "right" },
  { key: "26", x1: 1344, y1: 408, x2: 1547, y2: 458, fontSize: 12, align: "right" },
  { key: "29", x1: 804, y1: 408, x2: 885, y2: 458, fontSize: 12, align: "center" },
  { key: "44", x1: 1344, y1: 508, x2: 1547, y2: 558, fontSize: 12, align: "right" },
  { key: "46", x1: 1344, y1: 608, x2: 1547, y2: 658, fontSize: 12, align: "right" },
  { key: "50", x1: 1344, y1: 708, x2: 1547, y2: 758, fontSize: 12, align: "right" },
  { key: "52", x1: 974, y1: 708, x2: 1177, y2: 758, fontSize: 12, align: "right" },
  { key: "55", x1: 974, y1: 808, x2: 1177, y2: 858, fontSize: 12, align: "right" },
  { key: "56", x1: 1344, y1: 808, x2: 1547, y2: 858, fontSize: 12, align: "right" },
];

const CPP_TABLE = {
  2021: { ympe: 61600, ybe: 3500, rate: 0.0545 },
  2022: { ympe: 64900, ybe: 3500, rate: 0.057 },
  2023: { ympe: 66600, ybe: 3500, rate: 0.0595 },
  2024: { ympe: 68500, ybe: 3500, rate: 0.0595 },
  2025: { ympe: 71300, ybe: 3500, rate: 0.0595 },
  2026: { ympe: 74600, ybe: 3500, rate: 0.0595 },
};

const CPP2_TABLE = {
  2024: { yampe: 73200, rate2: 0.04 },
  2025: { yampe: 81200, rate2: 0.04 },
  2026: { yampe: 85000, rate2: 0.04 },
};

const QPP_TABLE = {
  2021: { ympe: 61600, ybe: 3500, rate: 0.059 },
  2022: { ympe: 64900, ybe: 3500, rate: 0.0615 },
  2023: { ympe: 66600, ybe: 3500, rate: 0.064 },
  2024: { ympe: 68500, ybe: 3500, rate: 0.064 },
  2025: { ympe: 71300, ybe: 3500, rate: 0.064 },
  2026: { ympe: 74600, ybe: 3500, rate: 0.063 },
};

const QPP2_TABLE = {
  2024: { yampe: 73200, rate2: 0.04 },
  2025: { yampe: 81200, rate2: 0.04 },
  2026: { yampe: 85000, rate2: 0.04 },
};

const EI_FED_TABLE = {
  2021: { mie: 56300, rate: 0.0158 },
  2022: { mie: 60300, rate: 0.0158 },
  2023: { mie: 61500, rate: 0.0163 },
  2024: { mie: 63200, rate: 0.0166 },
  2025: { mie: 65700, rate: 0.0164 },
  2026: { mie: 68900, rate: 0.0163 },
};

const EI_QC_TABLE = {
  2021: { mie: 56300, rate: 0.0118 },
  2022: { mie: 60300, rate: 0.012 },
  2023: { mie: 61500, rate: 0.0127 },
  2024: { mie: 63200, rate: 0.0132 },
  2025: { mie: 65700, rate: 0.0131 },
  2026: { mie: 68900, rate: 0.013 },
};

const QPIP_TABLE = {
  2021: { mie: 83500, rate: 0.00494 },
  2022: { mie: 88000, rate: 0.00494 },
  2023: { mie: 91000, rate: 0.00494 },
  2024: { mie: 94000, rate: 0.00494 },
  2025: { mie: 98000, rate: 0.00494 },
  2026: { mie: 103000, rate: 0.0043 },
};

function isQuebecProvince(province) {
  if (!province) return false;
  const p = String(province).trim().toLowerCase();
  return p === "qc" || p === "pq" || p.includes("quebec");
}

function round2(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function calcCPP(employmentIncome, year, isExempt, isQuebec) {
  if (isExempt || employmentIncome <= 0) {
    return { contribution: 0, pensionableEarnings: 0 };
  }
  const table = isQuebec ? QPP_TABLE : CPP_TABLE;
  const table2 = isQuebec ? QPP2_TABLE : CPP2_TABLE;
  const cfg = table[year];
  if (!cfg) throw new Error(`CPP/QPP config missing for year ${year}`);
  const pensionableEarnings = Math.min(employmentIncome, cfg.ympe);
  const base = Math.max(0, pensionableEarnings - cfg.ybe);
  let contrib = base * cfg.rate;
  if (table2[year]) {
    const { yampe, rate2 } = table2[year];
    const additionalBase = Math.max(0, Math.min(employmentIncome, yampe) - cfg.ympe);
    contrib += additionalBase * rate2;
  }
  return {
    contribution: round2(contrib),
    pensionableEarnings: round2(pensionableEarnings),
  };
}

function calcEI(employmentIncome, year, isExempt, isQuebec) {
  if (isExempt || employmentIncome <= 0) {
    return { eiPremium: 0, insurableEarnings: 0 };
  }
  const cfg = (isQuebec ? EI_QC_TABLE : EI_FED_TABLE)[year];
  if (!cfg) throw new Error(`EI config missing for year ${year}`);
  const insurable = Math.min(employmentIncome, cfg.mie);
  return {
    eiPremium: round2(insurable * cfg.rate),
    insurableEarnings: round2(insurable),
  };
}

function calcQPIP(employmentIncome, year, isExempt) {
  if (isExempt || employmentIncome <= 0) {
    return { ppipPremium: 0, ppipInsurable: 0 };
  }
  const cfg = QPIP_TABLE[year];
  if (!cfg) throw new Error(`QPIP config missing for year ${year}`);
  const insurable = Math.min(employmentIncome, cfg.mie);
  return {
    ppipPremium: round2(insurable * cfg.rate),
    ppipInsurable: round2(insurable),
  };
}

function calculateT4(input) {
  const {
    year,
    province,
    employmentIncome,
    incomeTaxDeducted = 0,
    rppContributions = 0,
    pensionAdjustment = 0,
    rppOrDpspRegNumber = null,
    unionDues = 0,
    charitableDonations = 0,
    isCPPExempt = false,
    isEIExempt = false,
    isPPIPExempt = false,
  } = input;
  if (!year || !province || typeof employmentIncome !== "number") {
    throw new Error("year, province, and employmentIncome are required");
  }
  const quebec = isQuebecProvince(province);
  const { contribution: cppOrQppContrib, pensionableEarnings } = calcCPP(employmentIncome, year, isCPPExempt, quebec);
  const { eiPremium, insurableEarnings } = calcEI(employmentIncome, year, isEIExempt, quebec);
  let ppipPremium = 0;
  let ppipInsurable = 0;
  if (quebec) {
    const ppip = calcQPIP(employmentIncome, year, isPPIPExempt);
    ppipPremium = ppip.ppipPremium;
    ppipInsurable = ppip.ppipInsurable;
  }
  return {
    10: province,
    14: round2(employmentIncome),
    16: quebec ? 0 : cppOrQppContrib,
    17: quebec ? cppOrQppContrib : 0,
    18: eiPremium,
    20: round2(rppContributions),
    22: round2(incomeTaxDeducted),
    24: insurableEarnings,
    26: pensionableEarnings,
    44: round2(unionDues),
    46: round2(charitableDonations),
    50: rppOrDpspRegNumber,
    52: round2(pensionAdjustment),
    55: quebec ? ppipPremium : 0,
    56: quebec ? ppipInsurable : 0,
    box28: {
      cppQppExempt: !!isCPPExempt,
      eiExempt: !!isEIExempt,
      ppipExempt: !!isPPIPExempt || !quebec,
    },
  };
}

function getT4InputByKey(key) {
  const needle = String(key);
  return [...document.querySelectorAll("#t4Controls [data-t4-key]")].find((el) => el.dataset.t4Key === needle) || null;
}

function isCheckedLike(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "x" || normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
}

function setT4FieldValue(key, value) {
  const input = getT4InputByKey(key);
  if (!input) return;
  if (input.type === "checkbox") {
    const nextChecked = isCheckedLike(value);
    if (input.checked !== nextChecked) {
      input.checked = nextChecked;
    }
    return;
  }
  const next = value == null ? "" : String(value);
  if (input.value !== next) {
    input.value = next;
  }
}

function formatT4AutoAmount(value, { blankZero = false } = {}) {
  const n = round2(value);
  if (blankZero && n === 0) return "";
  return n.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function applyT4AutoCalculation() {
  const values = readT4SlipForm();
  const year = Number.parseInt(String(values.year || "").trim(), 10);
  const province = safeText(values["10"]);
  const employmentIncomeRaw = values["14"];
  const hasEmploymentIncome = !isBlank(employmentIncomeRaw);
  const employmentIncome = toNumber(employmentIncomeRaw);
  if (!Number.isFinite(year) || year < 2021 || year > 2026) return;
  if (!province) return;
  if (!hasEmploymentIncome) return;
  try {
    const t4 = calculateT4({
      year,
      province,
      employmentIncome,
      incomeTaxDeducted: toNumber(values["22"]),
      rppContributions: toNumber(values["20"]),
      pensionAdjustment: toNumber(values["52"]),
      rppOrDpspRegNumber: safeText(values["50"]) || null,
      unionDues: toNumber(values["44"]),
      charitableDonations: toNumber(values["46"]),
      isCPPExempt: !isBlank(values["28_cpp_qpp"]),
      isEIExempt: !isBlank(values["28_ei"]),
      isPPIPExempt: !isBlank(values["28_ppip"]),
    });
    setT4FieldValue("16", formatT4AutoAmount(t4[16], { blankZero: true }));
    setT4FieldValue("17", formatT4AutoAmount(t4[17], { blankZero: true }));
    setT4FieldValue("18", formatT4AutoAmount(t4[18], { blankZero: true }));
    setT4FieldValue("24", formatT4AutoAmount(t4[24], { blankZero: true }));
    setT4FieldValue("26", formatT4AutoAmount(t4[26], { blankZero: true }));
    setT4FieldValue("55", formatT4AutoAmount(t4[55]));
    setT4FieldValue("56", formatT4AutoAmount(t4[56]));
    setT4FieldValue("28_cpp_qpp", t4.box28.cppQppExempt ? "X" : "");
    setT4FieldValue("28_ei", t4.box28.eiExempt ? "X" : "");
    setT4FieldValue("28_ppip", t4.box28.ppipExempt ? "X" : "");
  } catch (error) {
    console.warn("T4 auto-calculation skipped", error);
  }
}

function readT4SlipForm() {
  const values = {};
  for (const field of document.querySelectorAll("#t4Controls [data-t4-key]")) {
    const key = field.dataset.t4Key;
    if (!key) continue;
    values[key] = field.type === "checkbox" ? (field.checked ? "X" : "") : (field.value ?? "");
  }
  return values;
}

function hydrateT4SlipForm(values = {}) {
  for (const field of document.querySelectorAll("#t4Controls [data-t4-key]")) {
    const key = field.dataset.t4Key;
    if (!key) continue;
    if (field.type === "checkbox") {
      field.checked = isCheckedLike(values[key]);
      continue;
    }
    field.value = values[key] ?? "";
  }
}

function buildT4PlacementItems(values = {}) {
  const items = [];
  const pushItem = (spec, slipIndex) => {
    const rawValue = values[spec.key];
    const value = safeText(rawValue);
    if (!value) return;
    items.push({ ...spec, value, slipIndex });
  };
  const pushBox = (box, slipIndex) => {
    if (!box.value) return;
    items.push({ ...box, slipIndex });
  };
  for (let slipIndex = 0; slipIndex < 2; slipIndex += 1) {
    const employeeLines = String(values.employeeAddress ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const employeeNameLine = employeeLines[0] ?? "";
    const employeeAddressLines = employeeLines.slice(1).join("\n");
    pushBox({ value: employeeNameLine, x1: 160, y1: 561, x2: 874, y2: 596, fontSize: 11, align: "left" }, slipIndex);
    pushBox({ value: employeeAddressLines, x1: 138, y1: 603, x2: 900, y2: 845, fontSize: 11, align: "left" }, slipIndex);
    for (const spec of T4_PREVIEW_FIELDS) {
      pushItem(spec, slipIndex);
    }
  }
  return items;
}

function renderT4Preview(data) {
  const overlay = document.getElementById("t4Overlay");
  if (!overlay) return;
  const values = data.t4Slip ?? {};
  const html = [];
  const renderBox = ({ value, x1, y1, x2, y2, fontSize = 11, align = "left" }, slipIndex) => {
    if (!value) return;
    const yShift = slipIndex * T4_PAGE.slipOffsetY;
    const py1 = y1 + yShift;
    const py2 = y2 + yShift;
    const width = x2 - x1;
    const height = py2 - py1;
    const left = (x1 / T4_PAGE.width) * 100;
    const top = (py1 / T4_PAGE.height) * 100;
    const widthPct = (width / T4_PAGE.width) * 100;
    const heightPct = (height / T4_PAGE.height) * 100;
    const classes = ["t4-text"];
    if (align === "right") classes.push("t4-right");
    if (align === "center") classes.push("t4-center");
    const lineClampValue = escapeAttr(value).replace(/\r?\n/g, "<br />");
    html.push(`<div class="${classes.join(" ")}" style="left:${left}%;top:${top}%;width:${widthPct}%;height:${heightPct}%;font-size:${fontSize}px;">${lineClampValue}</div>`);
  };
  for (const item of buildT4PlacementItems(values)) {
    renderBox(item, item.slipIndex);
  }
  overlay.innerHTML = html.join("");
}

function waitForImageReady(imgEl) {
  return new Promise((resolve, reject) => {
    if (!imgEl) { reject(new Error("Image element missing")); return; }
    if (imgEl.complete && imgEl.naturalWidth > 0) { resolve(); return; }
    const onLoad = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error("Image failed to load")); };
    const cleanup = () => { imgEl.removeEventListener("load", onLoad); imgEl.removeEventListener("error", onError); };
    imgEl.addEventListener("load", onLoad, { once: true });
    imgEl.addEventListener("error", onError, { once: true });
  });
}

function imageElementToJpegDataUrl(imgEl, quality = 0.98) {
  const w = imgEl.naturalWidth || imgEl.width;
  const h = imgEl.naturalHeight || imgEl.height;
  if (!w || !h) throw new Error("Image has no dimensions");
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(imgEl, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", quality);
}

const BMO_VOID_PAGE = { width: 2550, height: 3300 };

const BMO_VOID_PREVIEW_FIELDS = [
  { key: "transit", x1: 748, y1: 1844, x2: 960, y2: 1922, fontSize: 13, align: "center" },
  { key: "institution", x1: 1288, y1: 1844, x2: 1456, y2: 1922, fontSize: 13, align: "center" },
  { key: "account", x1: 1810, y1: 1844, x2: 2125, y2: 1922, fontSize: 13, align: "center" },
];

const BMO_VOID_NAME_ADDRESS_LAYOUT = {
  x1: 260, x2: 980, yStart: 1330, lineStep: 34, lineBoxHeight: 34,
  nameFontSize: 10, addressFontSize: 9,
};

const SCOTIA_VOID_PAGE = { width: 2479, height: 3508 };

const SCOTIA_VOID_PREVIEW_FIELDS = {
  name: { x1: 523, y1: 846, x2: 844, y2: 883, fontSize: 13, align: "left", fontWeight: "bold", color: "#111111", isTightLine: true },
  addressLine1: { x1: 524, y1: 901, x2: 1090, y2: 938, fontSize: 13, align: "left", fontWeight: "normal", color: "#111111", isTightLine: true },
  addressLine2: { x1: 524, y1: 955, x2: 1107, y2: 992, fontSize: 13, align: "left", fontWeight: "normal", color: "#111111", isTightLine: true },
  transit: { x1: 376, y1: 1377, x2: 557, y2: 1425, fontSize: 19, align: "left", fontWeight: "bold", color: "#111111", isTightLine: true },
  institution: { x1: 775, y1: 1377, x2: 845, y2: 1425, fontSize: 19, align: "left", fontWeight: "bold", color: "#111111", isTightLine: true },
  account: { x1: 1146, y1: 1377, x2: 1403, y2: 1425, fontSize: 19, align: "left", fontWeight: "bold", color: "#111111", isTightLine: true },
};

const RBC_VOID_PAGE = { width: 2595, height: 3407 };

const RBC_VOID_PREVIEW_FIELDS = [
  { key: "name", x1: 670, y1: 979, x2: 1332, y2: 1051, fontSize: 13, align: "left", fontWeight: "normal", color: "#1f1f1f" },
  { key: "transit", x1: 552, y1: 1484, x2: 774, y2: 1544, fontSize: 18, align: "left", fontWeight: "bold", color: "#2954a6" },
  { key: "institution", x1: 852, y1: 1484, x2: 1014, y2: 1544, fontSize: 18, align: "left", fontWeight: "bold", color: "#2954a6" },
  { key: "account", x1: 1219, y1: 1484, x2: 1539, y2: 1544, fontSize: 18, align: "left", fontWeight: "bold", color: "#2954a6" },
];

const TD_VOID_PAGE = { width: 2550, height: 3300 };

const TD_VOID_PREVIEW_FIELDS = [
  { key: "customerName", x1: 1048, y1: 397, x2: 1400, y2: 432, fontSize: 12, align: "left", fontWeight: "normal", color: "#111111" },
  { key: "swiftBic", x1: 1398, y1: 903, x2: 1734, y2: 936, fontSize: 9, align: "left", fontWeight: "normal", color: "#111111", isTightLine: true, tightYFactor: 0.58 },
  { key: "branchAddress", x1: 420, y1: 959, x2: 1730, y2: 1002, fontSize: 11, align: "left", fontWeight: "normal", color: "#111111", isTightLine: true },
  { key: "customerAccountNumber", x1: 630, y1: 1013, x2: 870, y2: 1045, fontSize: 10, align: "left", fontWeight: "normal", color: "#111111", isTightLine: true },
  { key: "customerAddress", x1: 470, y1: 1154, x2: 1720, y2: 1195, fontSize: 11, align: "left", fontWeight: "normal", color: "#111111", isTightLine: true },
];

const TD_VOID_DIGIT_BOX_FIELDS = [
  {
    key: "transit", fontSize: 7.5,
    boxes: [
      { x1: 1069, y1: 580, x2: 1091, y2: 611 },
      { x1: 1120, y1: 580, x2: 1140, y2: 611 },
      { x1: 1170, y1: 580, x2: 1193, y2: 611 },
      { x1: 1222, y1: 580, x2: 1242, y2: 611 },
      { x1: 1273, y1: 580, x2: 1295, y2: 611 },
    ],
  },
  {
    key: "institution", fontSize: 7.5,
    boxes: [
      { x1: 1425, y1: 580, x2: 1447, y2: 611 },
      { x1: 1476, y1: 580, x2: 1498, y2: 611 },
      { x1: 1526, y1: 580, x2: 1549, y2: 611 },
    ],
  },
  {
    key: "designation", fontSize: 7.5,
    boxes: [
      { x1: 1717, y1: 580, x2: 1739, y2: 611 },
      { x1: 1768, y1: 580, x2: 1788, y2: 611 },
      { x1: 1819, y1: 580, x2: 1839, y2: 611 },
      { x1: 1870, y1: 580, x2: 1890, y2: 611 },
    ],
  },
  {
    key: "account", fontSize: 7.5,
    boxes: [
      { x1: 2068, y1: 580, x2: 2090, y2: 611 },
      { x1: 2119, y1: 580, x2: 2139, y2: 611 },
      { x1: 2170, y1: 580, x2: 2192, y2: 611 },
      { x1: 2221, y1: 580, x2: 2243, y2: 611 },
      { x1: 2272, y1: 580, x2: 2292, y2: 611 },
      { x1: 2323, y1: 580, x2: 2345, y2: 611 },
      { x1: 2374, y1: 580, x2: 2396, y2: 611 },
    ],
  },
];

const CIBC_VOID_PAGE = { width: 2550, height: 3300 };

const CIBC_VOID_PAGE1_LAYOUT = {
  name: { x1: 368, y1: 1038, x2: 1240, y2: 1082, fontSize: 11, align: "left", fontWeight: "normal" },
  addressLine1: { x1: 368, y1: 1136, x2: 1240, y2: 1178, fontSize: 11, align: "left", fontWeight: "normal" },
  addressLine2: { x1: 368, y1: 1226, x2: 1240, y2: 1268, fontSize: 11, align: "left", fontWeight: "normal" },
  addressLine3: { x1: 368, y1: 1320, x2: 1240, y2: 1362, fontSize: 11, align: "left", fontWeight: "normal" },
  transit: { x1: 490, y1: 1530, x2: 820, y2: 1568, fontSize: 11, align: "left", fontWeight: "normal" },
  institution: { x1: 490, y1: 1623, x2: 820, y2: 1660, fontSize: 11, align: "left", fontWeight: "normal" },
  account: { x1: 490, y1: 1718, x2: 900, y2: 1756, fontSize: 11, align: "left", fontWeight: "normal" },
  date: { x1: 406, y1: 3038, x2: 792, y2: 3078, fontSize: 13, align: "center", fontWeight: "normal", noWrap: true },
};

const CIBC_VOID_CHEQUE_LAYOUT = {
  name: { x1: 646, y1: 2178, x2: 1250, y2: 2208, fontSize: 9, align: "left", fontWeight: "normal", noWrap: true },
  addressLine1: { x1: 646, y1: 2218, x2: 1250, y2: 2246, fontSize: 9, align: "left", fontWeight: "normal", noWrap: true },
  addressLine2: { x1: 646, y1: 2252, x2: 1250, y2: 2282, fontSize: 9, align: "left", fontWeight: "normal", noWrap: true },
  addressLine3: { x1: 646, y1: 2290, x2: 1250, y2: 2320, fontSize: 9, align: "left", fontWeight: "normal", noWrap: true },
  transit: { x1: 646, y1: 2606, x2: 760, y2: 2638, fontSize: 9, align: "left", fontWeight: "normal", noWrap: true },
  institution: { x1: 774, y1: 2606, x2: 860, y2: 2638, fontSize: 9, align: "left", fontWeight: "normal", noWrap: true },
  account: { x1: 868, y1: 2606, x2: 1010, y2: 2638, fontSize: 9, align: "left", fontWeight: "normal", noWrap: true },
};

const CIBC_VOID_PAGE2_LAYOUT = {
  name: { x1: 150, y1: 970, x2: 2360, y2: 1015, fontSize: 12, align: "left", fontWeight: "normal" },
  addressLine1: { x1: 150, y1: 1104, x2: 2360, y2: 1146, fontSize: 12, align: "left", fontWeight: "normal" },
  city: { x1: 150, y1: 1232, x2: 1288, y2: 1274, fontSize: 12, align: "left", fontWeight: "normal" },
  province: { x1: 1318, y1: 1232, x2: 1704, y2: 1274, fontSize: 12, align: "left", fontWeight: "normal" },
  postal: { x1: 2104, y1: 1232, x2: 2360, y2: 1274, fontSize: 12, align: "left", fontWeight: "normal" },
  branchAddress: { x1: 150, y1: 1496, x2: 2360, y2: 1540, fontSize: 12, align: "left", fontWeight: "normal" },
  branchCity: { x1: 150, y1: 1630, x2: 1288, y2: 1672, fontSize: 12, align: "left", fontWeight: "normal" },
  branchProvince: { x1: 1318, y1: 1630, x2: 1704, y2: 1672, fontSize: 12, align: "left", fontWeight: "normal" },
  branchPostal: { x1: 2104, y1: 1630, x2: 2360, y2: 1672, fontSize: 12, align: "left", fontWeight: "normal" },
  institution: { x1: 150, y1: 1760, x2: 648, y2: 1802, fontSize: 12, align: "left", fontWeight: "normal" },
  transit: { x1: 758, y1: 1760, x2: 1288, y2: 1802, fontSize: 12, align: "left", fontWeight: "normal" },
  account: { x1: 1318, y1: 1760, x2: 2360, y2: 1802, fontSize: 12, align: "left", fontWeight: "normal" },
  date: { x1: 406, y1: 2098, x2: 792, y2: 2140, fontSize: 13, align: "center", fontWeight: "normal", noWrap: true },
};

function fileToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Could not read file"));
    reader.readAsDataURL(blob);
  });
}

async function ensureImageEmbedded(imgEl, srcPath) {
  if (!imgEl) return "";
  if (String(imgEl.src || "").startsWith("data:image/")) return String(imgEl.src);
  try {
    const response = await fetch(srcPath, { credentials: "same-origin", cache: "force-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const dataUrl = await fileToDataUrl(blob);
    imgEl.src = dataUrl;
    if (typeof imgEl.decode === "function") {
      await imgEl.decode();
    }
    return dataUrl;
  } catch (error) {
    console.warn(`Embed image fallback failed for ${srcPath}`, error);
    return String(imgEl.src || "");
  }
}

async function ensureT4BackgroundEmbedded() {
  const hasPage1Bundled = typeof window.T4_BG_JPG_DATA_URL === "string" && window.T4_BG_JPG_DATA_URL.startsWith("data:image/");
  const hasPage2Bundled = typeof window.T4_BG2_JPG_DATA_URL === "string" && window.T4_BG2_JPG_DATA_URL.startsWith("data:image/");
  if (!hasPage1Bundled) {
    const img1 = document.getElementById("t4BgImage");
    const img1j = document.getElementById("t4BgImageJpg");
    if (img1) await waitForImageReady(img1).catch(() => {});
    if (img1j) await waitForImageReady(img1j).catch(() => {});
  }
  if (!hasPage2Bundled) {
    const img2 = document.getElementById("t4BgImage2");
    const img2j = document.getElementById("t4BgImage2Jpg");
    if (img2) await waitForImageReady(img2).catch(() => {});
    if (img2j) await waitForImageReady(img2j).catch(() => {});
  }
}

async function getT4BackgroundPdfDataUrl(pageNumber = 1) {
  const isSecond = pageNumber === 2;
  const bundled = isSecond ? window.T4_BG2_JPG_DATA_URL : window.T4_BG_JPG_DATA_URL;
  if (typeof bundled === "string" && bundled.startsWith("data:image/")) {
    return bundled;
  }
  let lastError = null;
  const candidates = isSecond
    ? [document.getElementById("t4BgImage2Jpg"), document.getElementById("t4BgImage2")].filter(Boolean)
    : [document.getElementById("t4BgImageJpg"), document.getElementById("t4BgImage")].filter(Boolean);
  for (const imgEl of candidates) {
    try {
      await waitForImageReady(imgEl);
      return imageElementToJpegDataUrl(imgEl, 0.98);
    } catch (error) {
      lastError = error;
      console.warn("T4 background canvas conversion failed for image", imgEl?.id, error);
    }
  }
  throw lastError || new Error("Could not prepare T4 background image");
}

async function saveT4Pdf(filename) {
  await ensureT4BackgroundEmbedded();
  const JsPdfCtor = window.jspdf?.jsPDF || window.jsPDF;
  if (typeof JsPdfCtor !== "function") {
    throw new Error("jsPDF is not available");
  }
  const bgPage1DataUrl = await getT4BackgroundPdfDataUrl(1);
  const bgPage2DataUrl = await getT4BackgroundPdfDataUrl(2);
  const data = getCurrentFormData();
  const values = data.t4Slip ?? {};
  const placements = buildT4PlacementItems(values);
  const pdf = new JsPdfCtor({ unit: "mm", format: "a4", orientation: "portrait" });
  const pageW = typeof pdf.internal?.pageSize?.getWidth === "function" ? pdf.internal.pageSize.getWidth() : pdf.internal?.pageSize?.width;
  const pageH = typeof pdf.internal?.pageSize?.getHeight === "function" ? pdf.internal.pageSize.getHeight() : pdf.internal?.pageSize?.height;
  if (!pageW || !pageH) throw new Error("Could not determine PDF page size");
  const exportW = pageW * T4_EXPORT_SCALE;
  const exportH = pageH * T4_EXPORT_SCALE;
  const exportX = (pageW - exportW) / 2;
  const exportY = (pageH - exportH) / 2;
  pdf.addImage(bgPage1DataUrl, "JPEG", exportX, exportY, exportW, exportH);
  const pxToMmX = (px) => exportX + (px / T4_PAGE.width) * exportW;
  const pxToMmY = (py) => exportY + (py / T4_PAGE.height) * exportH;
  const pxToPt = (px) => px * 0.75;
  pdf.setTextColor(17, 17, 17);
  pdf.setFont("helvetica", "bold");
  const writeText = (text, x, y, align, left, right, pdfDoc) => {
    if (align === "center") {
      const width = typeof pdfDoc.getTextWidth === "function" ? pdfDoc.getTextWidth(text) : 0;
      const cx = (left + right) / 2 - width / 2;
      pdfDoc.text(text, cx, y);
      return;
    }
    if (align === "right") {
      const width = typeof pdfDoc.getTextWidth === "function" ? pdfDoc.getTextWidth(text) : 0;
      pdfDoc.text(text, right - width, y);
      return;
    }
    pdfDoc.text(text, x, y);
  };
  for (const item of placements) {
    const yShift = item.slipIndex * T4_PAGE.slipOffsetY;
    const x1 = item.x1;
    const y1 = item.y1 + yShift;
    const x2 = item.x2;
    const y2 = item.y2 + yShift;
    const left = pxToMmX(x1);
    const top = pxToMmY(y1);
    const right = pxToMmX(x2);
    const bottom = pxToMmY(y2);
    const boxW = Math.max(1, right - left);
    const boxH = Math.max(1, bottom - top);
    const fontPt = Math.max(7, pxToPt(item.fontSize || 11));
    const fontMm = fontPt * 0.352778;
    const padX = Math.min(1.2, boxW * 0.06);
    const padTop = Math.min(1.0, boxH * 0.12);
    const lineHeight = Math.max(fontMm * 1.05, 1.4);
    pdf.setFontSize(fontPt);
    const rawLines = String(item.value ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const lines = [];
    for (const line of rawLines.length ? rawLines : [""]) {
      if (typeof pdf.splitTextToSize === "function") {
        const wrapped = pdf.splitTextToSize(line, Math.max(1, boxW - padX * 2));
        lines.push(...(wrapped.length ? wrapped : [""]));
      } else {
        lines.push(line);
      }
    }
    let y = top + padTop + fontMm * 0.82;
    for (const line of lines) {
      if (y > bottom - 0.2) break;
      writeText(line, left + padX, y, item.align, left + padX, right - padX, pdf);
      y += lineHeight;
    }
  }
  pdf.addPage("a4", "portrait");
  pdf.addImage(bgPage2DataUrl, "JPEG", exportX, exportY, exportW, exportH);
  pdf.save(filename);
  return { mode: "download" };
}

async function ensureBmoVoidBackgroundEmbedded() {
  const hasBundled = typeof window.BMO_VOID_BG_JPG_DATA_URL === "string" && window.BMO_VOID_BG_JPG_DATA_URL.startsWith("data:image/");
  if (!hasBundled) {
    await ensureImageEmbedded(elements.bmoVoidBgImage, "Bmo_Void_blank.jpg");
  }
}

async function ensureScotiaVoidBackgroundEmbedded() {
  const hasBundled = typeof window.SCOTIA_VOID_BG_JPG_DATA_URL === "string" && window.SCOTIA_VOID_BG_JPG_DATA_URL.startsWith("data:image/");
  if (!hasBundled) {
    await ensureImageEmbedded(elements.scotiaVoidBgImage, "Scotia_void_blank.jpg");
  }
}

async function ensureRbcVoidBackgroundEmbedded() {
  const hasBundled = typeof window.RBC_VOID_BG_JPG_DATA_URL === "string" && window.RBC_VOID_BG_JPG_DATA_URL.startsWith("data:image/");
  if (!hasBundled) {
    await ensureImageEmbedded(elements.rbcVoidBgImage, "RBC_void_blank.jpg");
  }
}

async function ensureTdVoidBackgroundEmbedded() {
  const hasBundled = typeof window.TD_VOID_BG_JPG_DATA_URL === "string" && window.TD_VOID_BG_JPG_DATA_URL.startsWith("data:image/");
  if (!hasBundled) {
    await ensureImageEmbedded(elements.tdVoidBgImage, "TD_void_blank.jpg");
  }
}

async function ensureCibcVoidBackgroundEmbedded() {
  const hasPage1Bundled = typeof window.CIBC_VOID_BG1_JPG_DATA_URL === "string" && window.CIBC_VOID_BG1_JPG_DATA_URL.startsWith("data:image/");
  const hasPage2Bundled = typeof window.CIBC_VOID_BG2_JPG_DATA_URL === "string" && window.CIBC_VOID_BG2_JPG_DATA_URL.startsWith("data:image/");
  if (!hasPage1Bundled) {
    await ensureImageEmbedded(elements.cibcVoidBgImage1, "CIBC_void_blank_1.jpg");
  }
  if (!hasPage2Bundled) {
    await ensureImageEmbedded(elements.cibcVoidBgImage2, "CIBC_void_blank_2.jpg");
  }
}

async function getBmoVoidBackgroundPdfDataUrl() {
  const bundled = window.BMO_VOID_BG_JPG_DATA_URL;
  if (typeof bundled === "string" && bundled.startsWith("data:image/")) return bundled;
  const src = String(elements.bmoVoidBgImage?.src || "");
  if (src.startsWith("data:image/")) return src;
  await ensureImageEmbedded(elements.bmoVoidBgImage, "Bmo_Void_blank.jpg");
  const embedded = String(elements.bmoVoidBgImage?.src || "");
  if (embedded.startsWith("data:image/")) return embedded;
  throw new Error("Could not prepare BMO void background image");
}

async function getScotiaVoidBackgroundPdfDataUrl() {
  const bundled = window.SCOTIA_VOID_BG_JPG_DATA_URL;
  if (typeof bundled === "string" && bundled.startsWith("data:image/")) return bundled;
  const src = String(elements.scotiaVoidBgImage?.src || "");
  if (src.startsWith("data:image/")) return src;
  await ensureImageEmbedded(elements.scotiaVoidBgImage, "Scotia_void_blank.jpg");
  const embedded = String(elements.scotiaVoidBgImage?.src || "");
  if (embedded.startsWith("data:image/")) return embedded;
  throw new Error("Could not prepare Scotia void background image");
}

async function getRbcVoidBackgroundPdfDataUrl() {
  const bundled = window.RBC_VOID_BG_JPG_DATA_URL;
  if (typeof bundled === "string" && bundled.startsWith("data:image/")) return bundled;
  const src = String(elements.rbcVoidBgImage?.src || "");
  if (src.startsWith("data:image/")) return src;
  await ensureImageEmbedded(elements.rbcVoidBgImage, "RBC_void_blank.jpg");
  const embedded = String(elements.rbcVoidBgImage?.src || "");
  if (embedded.startsWith("data:image/")) return embedded;
  throw new Error("Could not prepare RBC void background image");
}

async function getTdVoidBackgroundPdfDataUrl() {
  const bundled = window.TD_VOID_BG_JPG_DATA_URL;
  if (typeof bundled === "string" && bundled.startsWith("data:image/")) return bundled;
  const src = String(elements.tdVoidBgImage?.src || "");
  if (src.startsWith("data:image/")) return src;
  await ensureImageEmbedded(elements.tdVoidBgImage, "TD_void_blank.jpg");
  const embedded = String(elements.tdVoidBgImage?.src || "");
  if (embedded.startsWith("data:image/")) return embedded;
  throw new Error("Could not prepare TD void background image");
}

async function getCibcVoidBackgroundPdfDataUrl(pageNumber = 1) {
  const isSecond = pageNumber === 2;
  const bundled = isSecond ? window.CIBC_VOID_BG2_JPG_DATA_URL : window.CIBC_VOID_BG1_JPG_DATA_URL;
  if (typeof bundled === "string" && bundled.startsWith("data:image/")) return bundled;
  const imgEl = isSecond ? elements.cibcVoidBgImage2 : elements.cibcVoidBgImage1;
  const fallbackPath = isSecond ? "CIBC_void_blank_2.jpg" : "CIBC_void_blank_1.jpg";
  const src = String(imgEl?.src || "");
  if (src.startsWith("data:image/")) return src;
  await ensureImageEmbedded(imgEl, fallbackPath);
  const embedded = String(imgEl?.src || "");
  if (embedded.startsWith("data:image/")) return embedded;
  throw new Error(`Could not prepare CIBC void background image page ${pageNumber}`);
}

function buildBmoVoidPlacementItems(values = {}) {
  const items = [];
  const nameLine = safeText(values.name).toUpperCase();
  const addressLines = String(values.address ?? "").split(/\r?\n/).map((line) => safeText(line).toUpperCase()).filter(Boolean);
  const blockLines = [nameLine, addressLines[0] ?? "", addressLines[1] ?? ""];
  for (let i = 0; i < blockLines.length; i += 1) {
    const value = blockLines[i];
    if (!value) continue;
    const y1 = BMO_VOID_NAME_ADDRESS_LAYOUT.yStart + i * BMO_VOID_NAME_ADDRESS_LAYOUT.lineStep;
    items.push({
      key: i === 0 ? "name" : `address_${i}`,
      value,
      x1: BMO_VOID_NAME_ADDRESS_LAYOUT.x1,
      x2: BMO_VOID_NAME_ADDRESS_LAYOUT.x2,
      y1,
      y2: y1 + BMO_VOID_NAME_ADDRESS_LAYOUT.lineBoxHeight,
      fontSize: i === 0 ? BMO_VOID_NAME_ADDRESS_LAYOUT.nameFontSize : BMO_VOID_NAME_ADDRESS_LAYOUT.addressFontSize,
      fontWeight: i === 0 ? "bold" : "normal",
      align: "left",
    });
  }
  for (const spec of BMO_VOID_PREVIEW_FIELDS) {
    const rawValue = values[spec.key];
    const value = safeText(rawValue);
    if (!value) continue;
    items.push({ ...spec, value });
  }
  return items;
}

function readScotiaVoidForm() {
  return {
    name: elements.scotiaVoidName?.value ?? "",
    address: elements.scotiaVoidAddress?.value ?? "",
    transit: elements.scotiaVoidTransit?.value ?? "",
    institution: elements.scotiaVoidInstitution?.value ?? "",
    account: elements.scotiaVoidAccount?.value ?? "",
  };
}

function hydrateScotiaVoidForm(values = {}) {
  if (elements.scotiaVoidName) elements.scotiaVoidName.value = values.name ?? "";
  if (elements.scotiaVoidAddress) elements.scotiaVoidAddress.value = values.address ?? "";
  if (elements.scotiaVoidTransit) elements.scotiaVoidTransit.value = values.transit ?? "";
  if (elements.scotiaVoidInstitution) elements.scotiaVoidInstitution.value = values.institution ?? "";
  if (elements.scotiaVoidAccount) elements.scotiaVoidAccount.value = values.account ?? "";
}

function buildScotiaVoidPlacementItems(values = {}) {
  const items = [];
  const lines = splitUpperLines(values.address, 2);
  const valueByField = {
    name: safeText(values.name),
    addressLine1: lines[0] ?? "",
    addressLine2: lines[1] ?? "",
    transit: safeText(values.transit),
    institution: safeText(values.institution),
    account: safeText(values.account),
  };
  for (const [fieldKey, spec] of Object.entries(SCOTIA_VOID_PREVIEW_FIELDS)) {
    const value = valueByField[fieldKey];
    if (!value) continue;
    items.push({ ...spec, key: fieldKey, value });
  }
  return items;
}

function buildRbcVoidPlacementItems(values = {}) {
  const items = [];
  for (const spec of RBC_VOID_PREVIEW_FIELDS) {
    const rawValue = spec.key === "name" ? safeText(values.name).toUpperCase() : safeText(values[spec.key]);
    if (!rawValue) continue;
    items.push({ ...spec, value: rawValue });
  }
  return items;
}

function buildTdVoidPlacementItems(values = {}) {
  const items = [];
  const addDigitBoxes = (fieldSpec) => {
    const rawDigits = String(values[fieldSpec.key] ?? "").replace(/\D/g, "");
    if (!rawDigits) return;
    for (let index = 0; index < fieldSpec.boxes.length; index += 1) {
      const digit = rawDigits[index];
      if (!digit) break;
      const box = fieldSpec.boxes[index];
      items.push({
        key: `${fieldSpec.key}_${index}`, value: digit,
        x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2,
        fontSize: fieldSpec.fontSize, align: "center", fontWeight: "normal", color: "#111111", isDigitBox: true,
      });
    }
  };
  for (const fieldSpec of TD_VOID_DIGIT_BOX_FIELDS) {
    addDigitBoxes(fieldSpec);
  }
  for (const spec of TD_VOID_PREVIEW_FIELDS) {
    const rawValue = safeText(values[spec.key]);
    if (!rawValue) continue;
    items.push({ ...spec, value: rawValue.toUpperCase() });
  }
  return items;
}

function splitUpperLines(value, limit = 3) {
  return String(value ?? "").split(/\r?\n/).map((line) => safeText(line).toUpperCase()).filter(Boolean).slice(0, limit);
}

function parseCibcCityProvincePostal(value) {
  const line = safeText(value).toUpperCase().replace(/\s+/g, " ");
  if (!line) return { city: "", province: "", postal: "" };
  const canadianPostalPattern = "([A-Z][0-9][A-Z]\\s?[0-9][A-Z][0-9])";
  const cityProvincePostalMatch = line.match(new RegExp(`^(.*?)(?:,\\s*|\\s+)([A-Z]{2})\\s+${canadianPostalPattern}$`));
  if (cityProvincePostalMatch) {
    return {
      city: safeText(cityProvincePostalMatch[1]).replace(/,$/, ""),
      province: safeText(cityProvincePostalMatch[2]),
      postal: safeText(cityProvincePostalMatch[3]).replace(/\s+/, " "),
    };
  }
  const cityProvinceMatch = line.match(/^(.*?)(?:,\s*|\s+)([A-Z]{2})$/);
  if (cityProvinceMatch) {
    return {
      city: safeText(cityProvinceMatch[1]).replace(/,$/, ""),
      province: safeText(cityProvinceMatch[2]),
      postal: "",
    };
  }
  const tokenized = line.split(" ").filter(Boolean);
  if (tokenized.length >= 3) {
    const maybeProvince = tokenized[tokenized.length - 3];
    const maybePostal = `${tokenized[tokenized.length - 2]} ${tokenized[tokenized.length - 1]}`;
    if (/^[A-Z]{2}$/.test(maybeProvince) && /^[A-Z][0-9][A-Z] [0-9][A-Z][0-9]$/.test(maybePostal)) {
      return { city: tokenized.slice(0, -3).join(" "), province: maybeProvince, postal: maybePostal };
    }
  }
  return { city: line, province: "", postal: "" };
}

function buildCibcVoidPage1PlacementItems(values = {}) {
  const items = [];
  const name = safeText(values.name).toUpperCase();
  const addressLines = splitUpperLines(values.address, 3);
  const dateLabel = formatLongDate(values.date);
  const transit = safeText(values.transit);
  const institution = safeText(values.institution);
  const account = safeText(values.account);
  if (name) items.push({ ...CIBC_VOID_PAGE1_LAYOUT.name, value: name, color: "#111111" });
  if (addressLines[0]) items.push({ ...CIBC_VOID_PAGE1_LAYOUT.addressLine1, value: addressLines[0], color: "#111111" });
  if (addressLines[1]) items.push({ ...CIBC_VOID_PAGE1_LAYOUT.addressLine2, value: addressLines[1], color: "#111111" });
  if (addressLines[2]) items.push({ ...CIBC_VOID_PAGE1_LAYOUT.addressLine3, value: addressLines[2], color: "#111111" });
  if (transit) items.push({ ...CIBC_VOID_PAGE1_LAYOUT.transit, value: transit, color: "#111111" });
  if (institution) items.push({ ...CIBC_VOID_PAGE1_LAYOUT.institution, value: institution, color: "#111111" });
  if (account) items.push({ ...CIBC_VOID_PAGE1_LAYOUT.account, value: account, color: "#111111" });
  if (dateLabel) items.push({ ...CIBC_VOID_PAGE1_LAYOUT.date, value: dateLabel, color: "#111111" });
  if (name) items.push({ ...CIBC_VOID_CHEQUE_LAYOUT.name, value: name, color: "#111111" });
  if (addressLines[0]) items.push({ ...CIBC_VOID_CHEQUE_LAYOUT.addressLine1, value: addressLines[0], color: "#111111" });
  if (addressLines[1]) items.push({ ...CIBC_VOID_CHEQUE_LAYOUT.addressLine2, value: addressLines[1], color: "#111111" });
  if (addressLines[2]) items.push({ ...CIBC_VOID_CHEQUE_LAYOUT.addressLine3, value: addressLines[2], color: "#111111" });
  if (transit) items.push({ ...CIBC_VOID_CHEQUE_LAYOUT.transit, value: transit, color: "#111111" });
  if (institution) items.push({ ...CIBC_VOID_CHEQUE_LAYOUT.institution, value: institution, color: "#111111" });
  if (account) items.push({ ...CIBC_VOID_CHEQUE_LAYOUT.account, value: account, color: "#111111" });
  return items;
}

function buildCibcVoidPage2PlacementItems(values = {}) {
  const items = [];
  const name = safeText(values.name).toUpperCase();
  const addressLines = splitUpperLines(values.address, 3);
  const customerLocation = parseCibcCityProvincePostal([addressLines[1], addressLines[2]].filter(Boolean).join(" "));
  const branchLines = splitUpperLines(values.branchAddress, 3);
  const branchLocation = parseCibcCityProvincePostal([branchLines[1], branchLines[2]].filter(Boolean).join(" "));
  const dateLabel = formatLongDate(values.date);
  const transit = safeText(values.transit);
  const institution = safeText(values.institution);
  const account = safeText(values.account);
  if (name) items.push({ ...CIBC_VOID_PAGE2_LAYOUT.name, value: name, color: "#111111" });
  if (addressLines[0]) items.push({ ...CIBC_VOID_PAGE2_LAYOUT.addressLine1, value: addressLines[0], color: "#111111" });
  if (customerLocation.city) items.push({ ...CIBC_VOID_PAGE2_LAYOUT.city, value: customerLocation.city, color: "#111111" });
  if (customerLocation.province) items.push({ ...CIBC_VOID_PAGE2_LAYOUT.province, value: customerLocation.province, color: "#111111" });
  if (customerLocation.postal) items.push({ ...CIBC_VOID_PAGE2_LAYOUT.postal, value: customerLocation.postal, color: "#111111" });
  if (branchLines[0]) items.push({ ...CIBC_VOID_PAGE2_LAYOUT.branchAddress, value: branchLines[0], color: "#111111" });
  if (branchLocation.city) items.push({ ...CIBC_VOID_PAGE2_LAYOUT.branchCity, value: branchLocation.city, color: "#111111" });
  if (branchLocation.province) items.push({ ...CIBC_VOID_PAGE2_LAYOUT.branchProvince, value: branchLocation.province, color: "#111111" });
  if (branchLocation.postal) items.push({ ...CIBC_VOID_PAGE2_LAYOUT.branchPostal, value: branchLocation.postal, color: "#111111" });
  if (institution) items.push({ ...CIBC_VOID_PAGE2_LAYOUT.institution, value: institution, color: "#111111" });
  if (transit) items.push({ ...CIBC_VOID_PAGE2_LAYOUT.transit, value: transit, color: "#111111" });
  if (account) items.push({ ...CIBC_VOID_PAGE2_LAYOUT.account, value: account, color: "#111111" });
  if (dateLabel) items.push({ ...CIBC_VOID_PAGE2_LAYOUT.date, value: dateLabel, color: "#111111" });
  return items;
}

async function saveBmoVoidPdf(filename) {
  await ensureBmoVoidBackgroundEmbedded();
  const JsPdfCtor = window.jspdf?.jsPDF || window.jsPDF;
  if (typeof JsPdfCtor !== "function") throw new Error("jsPDF is not available");
  const bgDataUrl = await getBmoVoidBackgroundPdfDataUrl();
  const data = getCurrentFormData();
  const values = data.bmoVoidCheck ?? {};
  const placements = buildBmoVoidPlacementItems(values);
  const pdf = new JsPdfCtor({ unit: "mm", format: "a4", orientation: "portrait" });
  const pageW = typeof pdf.internal?.pageSize?.getWidth === "function" ? pdf.internal.pageSize.getWidth() : pdf.internal?.pageSize?.width;
  const pageH = typeof pdf.internal?.pageSize?.getHeight === "function" ? pdf.internal.pageSize.getHeight() : pdf.internal?.pageSize?.height;
  if (!pageW || !pageH) throw new Error("Could not determine PDF page size");
  pdf.addImage(bgDataUrl, "JPEG", 0, 0, pageW, pageH);
  const pxToMmX = (px) => (px / BMO_VOID_PAGE.width) * pageW;
  const pxToMmY = (py) => (py / BMO_VOID_PAGE.height) * pageH;
  const pxToPt = (px) => px * 0.75;
  pdf.setTextColor(17, 17, 17);
  const writeText = (text, x, y, align, left, right, pdfDoc) => {
    if (align === "center") { pdfDoc.text(text, (left + right) / 2, y, { align: "center" }); return; }
    if (align === "right") { pdfDoc.text(text, right, y, { align: "right" }); return; }
    pdfDoc.text(text, x, y);
  };
  for (const item of placements) {
    const left = pxToMmX(item.x1);
    const top = pxToMmY(item.y1);
    const right = pxToMmX(item.x2);
    const bottom = pxToMmY(item.y2);
    const boxW = Math.max(1, right - left);
    const boxH = Math.max(1, bottom - top);
    const fontPt = Math.max(7, pxToPt(item.fontSize || 11));
    const fontMm = fontPt * 0.352778;
    const padX = Math.min(1.2, boxW * 0.06);
    const padTop = Math.min(1.0, boxH * 0.12);
    const lineHeight = Math.max(fontMm * 1.05, 1.4);
    const fontStyle = item.fontWeight === "normal" ? "normal" : "bold";
    pdf.setFont("helvetica", fontStyle);
    pdf.setFontSize(fontPt);
    if (item.isDigitBox || item.isTightLine) {
      const text = String(item.value ?? "").split(/\r?\n/)[0].trim();
      if (!text) continue;
      const yFactor = typeof item.tightYFactor === "number" ? item.tightYFactor : item.isDigitBox ? 0.72 : 0.68;
      const y = top + boxH * yFactor;
      if (item.isDigitBox) { writeText(text, (left + right) / 2, y, "center", left, right, pdf); }
      else { const tightPadX = Math.min(0.4, boxW * 0.05); writeText(text, left + tightPadX, y, item.align, left + tightPadX, right - tightPadX, pdf); }
      continue;
    }
    const rawLines = String(item.value ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const lines = [];
    for (const line of rawLines.length ? rawLines : [""]) {
      if (typeof pdf.splitTextToSize === "function") { const wrapped = pdf.splitTextToSize(line, Math.max(1, boxW - padX * 2)); lines.push(...(wrapped.length ? wrapped : [""])); }
      else { lines.push(line); }
    }
    let y = top + padTop + fontMm * 0.82;
    for (const line of lines) {
      if (y > bottom - 0.2) break;
      writeText(line, left + padX, y, item.align, left + padX, right - padX, pdf);
      y += lineHeight;
    }
  }
  pdf.save(filename);
  return { mode: "download" };
}

async function saveScotiaVoidPdf(filename) {
  await ensureScotiaVoidBackgroundEmbedded();
  const JsPdfCtor = window.jspdf?.jsPDF || window.jsPDF;
  if (typeof JsPdfCtor !== "function") throw new Error("jsPDF is not available");
  const bgDataUrl = await getScotiaVoidBackgroundPdfDataUrl();
  const data = getCurrentFormData();
  const values = data.scotiaVoidCheck ?? {};
  const placements = buildScotiaVoidPlacementItems(values);
  const pdf = new JsPdfCtor({ unit: "mm", format: "a4", orientation: "portrait" });
  const pageW = typeof pdf.internal?.pageSize?.getWidth === "function" ? pdf.internal.pageSize.getWidth() : pdf.internal?.pageSize?.width;
  const pageH = typeof pdf.internal?.pageSize?.getHeight === "function" ? pdf.internal.pageSize.getHeight() : pdf.internal?.pageSize?.height;
  if (!pageW || !pageH) throw new Error("Could not determine PDF page size");
  pdf.addImage(bgDataUrl, "JPEG", 0, 0, pageW, pageH);
  const pxToMmX = (px) => (px / SCOTIA_VOID_PAGE.width) * pageW;
  const pxToMmY = (py) => (py / SCOTIA_VOID_PAGE.height) * pageH;
  const pxToPt = (px) => px * 0.75;
  const writeText = (text, x, y, align, left, right, pdfDoc) => {
    if (align === "center") { pdfDoc.text(text, (left + right) / 2, y, { align: "center" }); return; }
    if (align === "right") { pdfDoc.text(text, right, y, { align: "right" }); return; }
    pdfDoc.text(text, x, y);
  };
  for (const item of placements) {
    const colorHex = safeText(item.color);
    const match = colorHex.match(/^#([0-9a-f]{6})$/i);
    if (match) {
      const hex = match[1];
      pdf.setTextColor(Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16));
    } else { pdf.setTextColor(17, 17, 17); }
    const left = pxToMmX(item.x1);
    const top = pxToMmY(item.y1);
    const right = pxToMmX(item.x2);
    const bottom = pxToMmY(item.y2);
    const boxW = Math.max(1, right - left);
    const boxH = Math.max(1, bottom - top);
    const fontPt = Math.max(7, pxToPt(item.fontSize || 11));
    const fontMm = fontPt * 0.352778;
    const padX = Math.min(1.2, boxW * 0.06);
    const padTop = Math.min(1.0, boxH * 0.12);
    const lineHeight = Math.max(fontMm * 1.05, 1.4);
    const fontStyle = item.fontWeight === "normal" ? "normal" : "bold";
    pdf.setFont("helvetica", fontStyle);
    pdf.setFontSize(fontPt);
    if (item.isTightLine) {
      const text = String(item.value ?? "").split(/\r?\n/)[0].trim();
      if (!text) continue;
      const yFactor = typeof item.tightYFactor === "number" ? item.tightYFactor : 0.68;
      const y = top + boxH * yFactor;
      const tightPadX = Math.min(0.4, boxW * 0.05);
      writeText(text, left + tightPadX, y, item.align, left + tightPadX, right - tightPadX, pdf);
      continue;
    }
    const rawLines = String(item.value ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const lines = [];
    for (const line of rawLines.length ? rawLines : [""]) {
      if (typeof pdf.splitTextToSize === "function") { const wrapped = pdf.splitTextToSize(line, Math.max(1, boxW - padX * 2)); lines.push(...(wrapped.length ? wrapped : [""])); }
      else { lines.push(line); }
    }
    let y = top + padTop + fontMm * 0.82;
    for (const line of lines) {
      if (y > bottom - 0.2) break;
      writeText(line, left + padX, y, item.align, left + padX, right - padX, pdf);
      y += lineHeight;
    }
  }
  pdf.save(filename);
  return { mode: "download" };
}

async function saveRbcVoidPdf(filename) {
  await ensureRbcVoidBackgroundEmbedded();
  const JsPdfCtor = window.jspdf?.jsPDF || window.jsPDF;
  if (typeof JsPdfCtor !== "function") throw new Error("jsPDF is not available");
  const bgDataUrl = await getRbcVoidBackgroundPdfDataUrl();
  const data = getCurrentFormData();
  const values = data.rbcVoidCheck ?? {};
  const placements = buildRbcVoidPlacementItems(values);
  const pdf = new JsPdfCtor({ unit: "mm", format: "a4", orientation: "portrait" });
  const pageW = typeof pdf.internal?.pageSize?.getWidth === "function" ? pdf.internal.pageSize.getWidth() : pdf.internal?.pageSize?.width;
  const pageH = typeof pdf.internal?.pageSize?.getHeight === "function" ? pdf.internal.pageSize.getHeight() : pdf.internal?.pageSize?.height;
  if (!pageW || !pageH) throw new Error("Could not determine PDF page size");
  pdf.addImage(bgDataUrl, "JPEG", 0, 0, pageW, pageH);
  const pxToMmX = (px) => (px / RBC_VOID_PAGE.width) * pageW;
  const pxToMmY = (py) => (py / RBC_VOID_PAGE.height) * pageH;
  const pxToPt = (px) => px * 0.75;
  const writeText = (text, x, y, align, left, right, pdfDoc) => {
    if (align === "center") { pdfDoc.text(text, (left + right) / 2, y, { align: "center" }); return; }
    if (align === "right") { pdfDoc.text(text, right, y, { align: "right" }); return; }
    pdfDoc.text(text, x, y);
  };
  for (const item of placements) {
    const colorHex = safeText(item.color);
    const match = colorHex.match(/^#([0-9a-f]{6})$/i);
    if (match) {
      const hex = match[1];
      pdf.setTextColor(Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16));
    } else { pdf.setTextColor(41, 84, 166); }
    const left = pxToMmX(item.x1);
    const top = pxToMmY(item.y1);
    const right = pxToMmX(item.x2);
    const bottom = pxToMmY(item.y2);
    const boxW = Math.max(1, right - left);
    const boxH = Math.max(1, bottom - top);
    const fontPt = Math.max(7, pxToPt(item.fontSize || 11));
    const fontMm = fontPt * 0.352778;
    const padX = Math.min(1.2, boxW * 0.06);
    const padTop = Math.min(1.0, boxH * 0.12);
    const lineHeight = Math.max(fontMm * 1.05, 1.4);
    const fontStyle = item.fontWeight === "normal" ? "normal" : "bold";
    pdf.setFont("helvetica", fontStyle);
    pdf.setFontSize(fontPt);
    const rawLines = String(item.value ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const lines = [];
    for (const line of rawLines.length ? rawLines : [""]) {
      if (typeof pdf.splitTextToSize === "function") { const wrapped = pdf.splitTextToSize(line, Math.max(1, boxW - padX * 2)); lines.push(...(wrapped.length ? wrapped : [""])); }
      else { lines.push(line); }
    }
    let y = top + padTop + fontMm * 0.82;
    for (const line of lines) {
      if (y > bottom - 0.2) break;
      writeText(line, left + padX, y, item.align, left + padX, right - padX, pdf);
      y += lineHeight;
    }
  }
  pdf.save(filename);
  return { mode: "download" };
}

async function saveTdVoidPdf(filename) {
  await ensureTdVoidBackgroundEmbedded();
  const JsPdfCtor = window.jspdf?.jsPDF || window.jsPDF;
  if (typeof JsPdfCtor !== "function") throw new Error("jsPDF is not available");
  const bgDataUrl = await getTdVoidBackgroundPdfDataUrl();
  const data = getCurrentFormData();
  const values = data.tdVoidCheck ?? {};
  const placements = buildTdVoidPlacementItems(values);
  const pdf = new JsPdfCtor({ unit: "mm", format: "a4", orientation: "portrait" });
  const pageW = typeof pdf.internal?.pageSize?.getWidth === "function" ? pdf.internal.pageSize.getWidth() : pdf.internal?.pageSize?.width;
  const pageH = typeof pdf.internal?.pageSize?.getHeight === "function" ? pdf.internal.pageSize.getHeight() : pdf.internal?.pageSize?.height;
  if (!pageW || !pageH) throw new Error("Could not determine PDF page size");
  pdf.addImage(bgDataUrl, "JPEG", 0, 0, pageW, pageH);
  const pxToMmX = (px) => (px / TD_VOID_PAGE.width) * pageW;
  const pxToMmY = (py) => (py / TD_VOID_PAGE.height) * pageH;
  const pxToPt = (px) => px * 0.75;
  pdf.setTextColor(17, 17, 17);
  const writeText = (text, x, y, align, left, right, pdfDoc) => {
    if (align === "center") { pdfDoc.text(text, (left + right) / 2, y, { align: "center" }); return; }
    if (align === "right") { pdfDoc.text(text, right, y, { align: "right" }); return; }
    pdfDoc.text(text, x, y);
  };
  for (const item of placements) {
    const left = pxToMmX(item.x1);
    const top = pxToMmY(item.y1);
    const right = pxToMmX(item.x2);
    const bottom = pxToMmY(item.y2);
    const boxW = Math.max(1, right - left);
    const boxH = Math.max(1, bottom - top);
    const fontPt = Math.max(7, pxToPt(item.fontSize || 11));
    const fontMm = fontPt * 0.352778;
    const padX = Math.min(1.2, boxW * 0.06);
    const padTop = Math.min(1.0, boxH * 0.12);
    const lineHeight = Math.max(fontMm * 1.05, 1.4);
    const fontStyle = item.fontWeight === "normal" ? "normal" : "bold";
    pdf.setFont("helvetica", fontStyle);
    pdf.setFontSize(fontPt);
    if (item.isDigitBox || item.isTightLine) {
      const text = String(item.value ?? "").split(/\r?\n/)[0].trim();
      if (!text) continue;
      const yFactor = typeof item.tightYFactor === "number" ? item.tightYFactor : item.isDigitBox ? 0.72 : 0.68;
      const yPos = top + boxH * yFactor;
      if (item.isDigitBox) { writeText(text, (left + right) / 2, yPos, "center", left, right, pdf); }
      else { const tightPadX = Math.min(0.4, boxW * 0.05); writeText(text, left + tightPadX, yPos, item.align, left + tightPadX, right - tightPadX, pdf); }
      continue;
    }
    const rawLines = String(item.value ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const lines = [];
    for (const line of rawLines.length ? rawLines : [""]) {
      if (typeof pdf.splitTextToSize === "function") { const wrapped = pdf.splitTextToSize(line, Math.max(1, boxW - padX * 2)); lines.push(...(wrapped.length ? wrapped : [""])); }
      else { lines.push(line); }
    }
    let y = top + padTop + fontMm * 0.82;
    for (const line of lines) {
      if (y > bottom - 0.2) break;
      writeText(line, left + padX, y, item.align, left + padX, right - padX, pdf);
      y += lineHeight;
    }
  }
  pdf.save(filename);
  return { mode: "download" };
}

async function saveCibcVoidPdf(filename) {
  await ensureCibcVoidBackgroundEmbedded();
  const JsPdfCtor = window.jspdf?.jsPDF || window.jsPDF;
  if (typeof JsPdfCtor !== "function") throw new Error("jsPDF is not available");
  const bgPage1DataUrl = await getCibcVoidBackgroundPdfDataUrl(1);
  const bgPage2DataUrl = await getCibcVoidBackgroundPdfDataUrl(2);
  const data = getCurrentFormData();
  const values = data.cibcVoidCheck ?? {};
  const page1Placements = buildCibcVoidPage1PlacementItems(values);
  const page2Placements = buildCibcVoidPage2PlacementItems(values);
  const pdf = new JsPdfCtor({ unit: "mm", format: "a4", orientation: "portrait" });
  const pageW = typeof pdf.internal?.pageSize?.getWidth === "function" ? pdf.internal.pageSize.getWidth() : pdf.internal?.pageSize?.width;
  const pageH = typeof pdf.internal?.pageSize?.getHeight === "function" ? pdf.internal.pageSize.getHeight() : pdf.internal?.pageSize?.height;
  if (!pageW || !pageH) throw new Error("Could not determine PDF page size");
  const pxToMmX = (px) => (px / CIBC_VOID_PAGE.width) * pageW;
  const pxToMmY = (py) => (py / CIBC_VOID_PAGE.height) * pageH;
  const pxToPt = (px) => px * 0.75;
  const writeText = (text, x, y, align, left, right, pdfDoc) => {
    if (align === "center") { pdfDoc.text(text, (left + right) / 2, y, { align: "center" }); return; }
    if (align === "right") { pdfDoc.text(text, right, y, { align: "right" }); return; }
    pdfDoc.text(text, x, y);
  };
  const drawPlacementItems = (items) => {
    for (const item of items) {
      const colorHex = safeText(item.color);
      const match = colorHex.match(/^#([0-9a-f]{6})$/i);
      if (match) {
        const hex = match[1];
        pdf.setTextColor(Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16));
      } else { pdf.setTextColor(17, 17, 17); }
      const left = pxToMmX(item.x1);
      const top = pxToMmY(item.y1);
      const right = pxToMmX(item.x2);
      const bottom = pxToMmY(item.y2);
      const boxW = Math.max(1, right - left);
      const boxH = Math.max(1, bottom - top);
      const fontPt = Math.max(7, pxToPt(item.fontSize || 11));
      const fontMm = fontPt * 0.352778;
      const padX = Math.min(1.2, boxW * 0.06);
      const padTop = Math.min(1.0, boxH * 0.12);
      const lineHeight = Math.max(fontMm * 1.05, 1.4);
      const fontStyle = item.fontWeight === "normal" ? "normal" : "bold";
      pdf.setFont("helvetica", fontStyle);
      pdf.setFontSize(fontPt);
      if (item.noWrap) {
        const text = String(item.value ?? "").replace(/\r?\n/g, " ").trim();
        if (!text) continue;
        const tightPadX = Math.min(0.5, boxW * 0.05);
        const y = top + Math.max(fontMm * 0.95, boxH * 0.72);
        writeText(text, left + tightPadX, y, item.align, left + tightPadX, right - tightPadX, pdf);
        continue;
      }
      const rawLines = String(item.value ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const lines = [];
      for (const line of rawLines.length ? rawLines : [""]) {
        if (typeof pdf.splitTextToSize === "function") { const wrapped = pdf.splitTextToSize(line, Math.max(1, boxW - padX * 2)); lines.push(...(wrapped.length ? wrapped : [""])); }
        else { lines.push(line); }
      }
      let y = top + padTop + fontMm * 0.82;
      for (const line of lines) {
        if (y > bottom - 0.2) break;
        writeText(line, left + padX, y, item.align, left + padX, right - padX, pdf);
        y += lineHeight;
      }
    }
  };
  pdf.addImage(bgPage1DataUrl, "JPEG", 0, 0, pageW, pageH);
  drawPlacementItems(page1Placements);
  pdf.addPage("a4", "portrait");
  pdf.addImage(bgPage2DataUrl, "JPEG", 0, 0, pageW, pageH);
  drawPlacementItems(page2Placements);
  pdf.save(filename);
  return { mode: "download" };
}

function renderBmoVoidPreview(data) {
  if (!elements.bmoVoidOverlay) return;
  const values = data.bmoVoidCheck ?? {};
  const html = [];
  for (const item of buildBmoVoidPlacementItems(values)) {
    const width = item.x2 - item.x1;
    const height = item.y2 - item.y1;
    const left = (item.x1 / BMO_VOID_PAGE.width) * 100;
    const top = (item.y1 / BMO_VOID_PAGE.height) * 100;
    const widthPct = (width / BMO_VOID_PAGE.width) * 100;
    const heightPct = (height / BMO_VOID_PAGE.height) * 100;
    const classes = ["bmo-void-text"];
    if (item.align === "right") classes.push("bmo-right");
    if (item.align === "center") classes.push("bmo-center");
    html.push(`<div class="${classes.join(" ")}" style="left:${left}%;top:${top}%;width:${widthPct}%;height:${heightPct}%;font-size:${item.fontSize}px;font-weight:${item.fontWeight === "normal" ? 400 : 600};color:${item.color || "#2954a6"};">${escapeAttr(item.value).replace(/\r?\n/g, "<br />")}</div>`);
  }
  elements.bmoVoidOverlay.innerHTML = html.join("");
}

function renderScotiaVoidPreview(data) {
  if (!elements.scotiaVoidOverlay) return;
  const values = data.scotiaVoidCheck ?? {};
  const html = [];
  for (const item of buildScotiaVoidPlacementItems(values)) {
    const width = item.x2 - item.x1;
    const height = item.y2 - item.y1;
    const left = (item.x1 / SCOTIA_VOID_PAGE.width) * 100;
    const top = (item.y1 / SCOTIA_VOID_PAGE.height) * 100;
    const widthPct = (width / SCOTIA_VOID_PAGE.width) * 100;
    const heightPct = (height / SCOTIA_VOID_PAGE.height) * 100;
    const classes = ["scotia-void-text"];
    if (item.align === "right") classes.push("scotia-right");
    if (item.align === "center") classes.push("scotia-center");
    const previewBehavior = item.isTightLine ? "overflow:visible;white-space:nowrap;line-height:1;padding:0 1px;" : "";
    html.push(`<div class="${classes.join(" ")}" style="left:${left}%;top:${top}%;width:${widthPct}%;height:${heightPct}%;font-size:${item.fontSize}px;font-weight:${item.fontWeight === "normal" ? 400 : 600};color:${item.color || "#111111"};${previewBehavior}">${escapeAttr(item.value).replace(/\r?\n/g, "<br />")}</div>`);
  }
  elements.scotiaVoidOverlay.innerHTML = html.join("");
}

function renderRbcVoidPreview(data) {
  if (!elements.rbcVoidOverlay) return;
  const values = data.rbcVoidCheck ?? {};
  const html = [];
  for (const item of buildRbcVoidPlacementItems(values)) {
    const width = item.x2 - item.x1;
    const height = item.y2 - item.y1;
    const left = (item.x1 / RBC_VOID_PAGE.width) * 100;
    const top = (item.y1 / RBC_VOID_PAGE.height) * 100;
    const widthPct = (width / RBC_VOID_PAGE.width) * 100;
    const heightPct = (height / RBC_VOID_PAGE.height) * 100;
    const classes = ["rbc-void-text"];
    if (item.align === "right") classes.push("rbc-right");
    if (item.align === "center") classes.push("rbc-center");
    html.push(`<div class="${classes.join(" ")}" style="left:${left}%;top:${top}%;width:${widthPct}%;height:${heightPct}%;font-size:${item.fontSize}px;font-weight:${item.fontWeight === "normal" ? 400 : 600};color:${item.color || "#2954a6"};">${escapeAttr(item.value).replace(/\r?\n/g, "<br />")}</div>`);
  }
  elements.rbcVoidOverlay.innerHTML = html.join("");
}

function renderTdVoidPreview(data) {
  if (!elements.tdVoidOverlay) return;
  const values = data.tdVoidCheck ?? {};
  const html = [];
  for (const item of buildTdVoidPlacementItems(values)) {
    const width = item.x2 - item.x1;
    const height = item.y2 - item.y1;
    const left = (item.x1 / TD_VOID_PAGE.width) * 100;
    const top = (item.y1 / TD_VOID_PAGE.height) * 100;
    const widthPct = (width / TD_VOID_PAGE.width) * 100;
    const heightPct = (height / TD_VOID_PAGE.height) * 100;
    const classes = ["td-void-text"];
    if (item.align === "right") classes.push("td-right");
    if (item.align === "center") classes.push("td-center");
    const previewBehavior = item.isDigitBox
      ? "display:flex;align-items:center;justify-content:center;padding:0;line-height:1;overflow:visible;"
      : item.isTightLine ? "display:flex;align-items:center;padding:0 2px;line-height:1;overflow:visible;" : "";
    html.push(`<div class="${classes.join(" ")}" style="left:${left}%;top:${top}%;width:${widthPct}%;height:${heightPct}%;font-size:${item.fontSize}px;font-weight:${item.fontWeight === "normal" ? 400 : 600};color:${item.color || "#111111"};${previewBehavior}">${escapeAttr(item.value).replace(/\r?\n/g, "<br />")}</div>`);
  }
  elements.tdVoidOverlay.innerHTML = html.join("");
}

function renderCibcVoidOverlay(target, items) {
  if (!target) return;
  const html = [];
  for (const item of items) {
    const width = item.x2 - item.x1;
    const height = item.y2 - item.y1;
    const left = (item.x1 / CIBC_VOID_PAGE.width) * 100;
    const top = (item.y1 / CIBC_VOID_PAGE.height) * 100;
    const widthPct = (width / CIBC_VOID_PAGE.width) * 100;
    const heightPct = (height / CIBC_VOID_PAGE.height) * 100;
    const classes = ["cibc-void-text"];
    if (item.align === "right") classes.push("cibc-right");
    if (item.align === "center") classes.push("cibc-center");
    const previewBehavior = item.noWrap ? "overflow:visible;white-space:nowrap;line-height:1;padding:0 1px;" : "";
    html.push(`<div class="${classes.join(" ")}" style="left:${left}%;top:${top}%;width:${widthPct}%;height:${heightPct}%;font-size:${item.fontSize}px;font-weight:${item.fontWeight === "normal" ? 400 : 600};color:${item.color || "#111111"};${previewBehavior}">${escapeAttr(item.value).replace(/\r?\n/g, "<br />")}</div>`);
  }
  target.innerHTML = html.join("");
}

function renderCibcVoidPreview(data) {
  const values = data.cibcVoidCheck ?? {};
  renderCibcVoidOverlay(elements.cibcVoidOverlay1, buildCibcVoidPage1PlacementItems(values));
  renderCibcVoidOverlay(elements.cibcVoidOverlay2, buildCibcVoidPage2PlacementItems(values));
}

function renderStatementPreview(data) {
  const statement = data.statement ?? {};
  const [addressLine1, addressLine2] = splitAddressLines(statement.address);
  const fromTo = [safeText(statement.statementFrom), safeText(statement.statementTo)].filter(Boolean).join(" - ");
  const accountType = safeText(statement.accountType).toUpperCase();
  const layout = buildStatementPages(statement);
  const customerName = safeText(statement.name).toUpperCase();

  elements.pvStBranchAddress.textContent = statement.branchAddress ?? "";
  elements.pvStBranchAddress2.textContent = statement.branchAddress ?? "";
  elements.pvStNamePage1.textContent = customerName;
  elements.pvStAddressLine1Page1.textContent = addressLine1.toUpperCase();
  elements.pvStAddressLine2Page1.textContent = addressLine2.toUpperCase();
  elements.pvStNamePage2.textContent = customerName;
  elements.pvStAddressLine1Page2.textContent = addressLine1.toUpperCase();
  elements.pvStAddressLine2Page2.textContent = addressLine2.toUpperCase();

  elements.pvStBranchNo1.textContent = statement.branchNo ?? "";
  elements.pvStBranchNo2.textContent = statement.branchNo ?? "";
  elements.pvStAccountNo1.textContent = statement.accountNo ?? "";
  elements.pvStAccountNo2.textContent = statement.accountNo ?? "";
  elements.pvStAccountType1.textContent = accountType;
  elements.pvStAccountType2.textContent = accountType;
  elements.pvStAccountTypeFees1.textContent = accountType;
  elements.pvStAccountTypeFees2.textContent = accountType;
  elements.pvStFromTo1.textContent = fromTo;
  elements.pvStFromTo2.textContent = fromTo;

  renderStatementRows(elements.pvStRowsPage1, layout.page1Rows);
  renderStatementRows(elements.pvStRowsPage2, layout.page2Rows);
  elements.pvStTotalDebit1.textContent = formatStatementAmount(layout.page1Debit, true);
  elements.pvStTotalCredit1.textContent = formatStatementAmount(layout.page1Credit, true);
  elements.pvStTotalDebit2.textContent = formatStatementAmount(layout.page2Debit, true);
  elements.pvStTotalCredit2.textContent = formatStatementAmount(layout.page2Credit, true);
}

function renderPreview() {
  if (getDocumentType() === "t4Slip") {
    applyT4AutoCalculation();
  }
  const data = getCurrentFormData();
  const totals = calculate(data);
  const design = data.designTemplate || "classic-blue";
  const brandColor = data.brandColor || "#096250";

  elements.paystub.dataset.design = design;
  document.documentElement.style.setProperty("--brand-color", brandColor);

  updateCalculatedEarningsTable(totals.periods);
  writeRows(elements.deductionsTable, "deductions", totals.deductionRows);
  lockCalculatedDeductions();

  elements.uiPayPeriods.textContent = String(totals.periods);
  elements.uiGrossPay.textContent = `$ ${formatMoney(totals.grossThis)}`;
  elements.uiTotalDeductions.textContent = `$ ${formatMoney(totals.deductionsThis)}`;
  elements.uiNetPay.textContent = `$ ${formatMoney(totals.netThis)}`;

  const validationState = collectValidationState(data);
  applyValidationState(validationState);

  if (getDocumentType() === "payroll") {
    const missingFields = [];
    if (!safeText(data.employeeName)) missingFields.push("employee name");
    if (!safeText(data.companyName)) missingFields.push("company name");
    if (!safeText(data.payDate)) missingFields.push("pay date");
    if (!safeText(data.periodEnding)) missingFields.push("period ending");
    if (!data.earnings.length) missingFields.push("earnings rows");
    elements.uiReadiness.textContent = missingFields.length
      ? `Needs input: ${missingFields.join(", ")}`
      : "Ready to save PDF";
  } else {
    elements.uiReadiness.textContent = "";
    if (getDocumentType() === "t4Slip") {
      const t4 = data.t4Slip ?? {};
      const year = safeText(t4.year);
      const filledCount = Object.values(t4).filter((v) => !isBlank(v)).length;
      elements.uiReadiness.textContent = year
        ? `T4 preview ready${filledCount ? ` \u2022 ${filledCount} field${filledCount === 1 ? "" : "s"} filled` : ""}`
        : "Enter T4 values, then Save PDF";
    } else if (getDocumentType() === "bmoVoidCheck") {
      const bmo = data.bmoVoidCheck ?? {};
      const filledCount = Object.values(bmo).filter((v) => !isBlank(v)).length;
      elements.uiReadiness.textContent = filledCount
        ? `BMO void cheque preview ready \u2022 ${filledCount} field${filledCount === 1 ? "" : "s"} filled`
        : "Enter BMO void cheque values, then Save PDF";
    } else if (getDocumentType() === "scotiaVoidCheck") {
      const scotia = data.scotiaVoidCheck ?? {};
      const filledCount = Object.values(scotia).filter((v) => !isBlank(v)).length;
      elements.uiReadiness.textContent = filledCount
        ? `Scotia void cheque preview ready \u2022 ${filledCount} field${filledCount === 1 ? "" : "s"} filled`
        : "Enter Scotia void cheque values, then Save PDF";
    } else if (getDocumentType() === "rbcVoidCheck") {
      const rbc = data.rbcVoidCheck ?? {};
      const filledCount = Object.values(rbc).filter((v) => !isBlank(v)).length;
      elements.uiReadiness.textContent = filledCount
        ? `RBC void cheque preview ready \u2022 ${filledCount} field${filledCount === 1 ? "" : "s"} filled`
        : "Enter RBC void cheque values, then Save PDF";
    } else if (getDocumentType() === "tdVoidCheck") {
      const td = data.tdVoidCheck ?? {};
      const filledCount = Object.values(td).filter((v) => !isBlank(v)).length;
      elements.uiReadiness.textContent = filledCount
        ? `TD void cheque preview ready \u2022 ${filledCount} field${filledCount === 1 ? "" : "s"} filled`
        : "Enter TD void cheque values, then Save PDF";
    } else if (getDocumentType() === "cibcVoidCheck") {
      const cibc = data.cibcVoidCheck ?? {};
      const filledCount = Object.values(cibc).filter((v) => !isBlank(v)).length;
      elements.uiReadiness.textContent = filledCount
        ? `CIBC void cheque preview ready \u2022 ${filledCount} field${filledCount === 1 ? "" : "s"} filled`
        : "Enter CIBC void cheque values, then Save PDF";
    }
  }

  const missingCount = Object.values(validationState.missingByGroup).reduce((sum, value) => sum + value, 0);
  const fieldErrorCount = Object.keys(validationState.fieldErrors).length;
  if (missingCount || fieldErrorCount) {
    const total = missingCount + fieldErrorCount;
    setSaveStatus(`${total} item${total === 1 ? "" : "s"} need attention before final export.`, "error");
  } else {
    setSaveStatus("Ready to save PDF.", "success");
  }

  const hasPayrollLogo = payrollLogoDataUrl.startsWith("data:image/");
  elements.pvPayrollLogoImage.classList.toggle("is-hidden", !hasPayrollLogo);
  elements.pvBrandFallback.classList.toggle("is-hidden", hasPayrollLogo);
  if (hasPayrollLogo) {
    elements.pvPayrollLogoImage.src = payrollLogoDataUrl;
  } else {
    elements.pvPayrollLogoImage.removeAttribute("src");
  }
  elements.pvBrandText.textContent = data.brandText || "WILCO";
  elements.pvPeriodEnding.textContent = formatDate(data.periodEnding);
  elements.pvPayDate.textContent = formatDate(data.payDate);
  elements.pvEmployeeAddress.textContent = [data.employeeName, data.employeeAddress]
    .filter(Boolean)
    .join("\n");

  elements.pvEarningsBody.innerHTML = totals.earnings
    .map(
      (item) => `
      <tr>
        <td>${escapeAttr(item.label)}</td>
        <td>${formatMoney(item.rate)}</td>
        <td>${formatMoney(item.hours)}</td>
        <td>${formatMoney(item.periodComputed)}</td>
        <td>${formatMoney(item.ytdComputed)}</td>
      </tr>
    `
    )
    .join("");

  elements.pvGrossThis.textContent = formatMoney(totals.grossThis);
  elements.pvGrossYtd.textContent = formatMoney(totals.grossYtd);

  elements.pvDeductionsBody.innerHTML = totals.deductionRows
    .map(
      (item) => `
      <tr>
        <td>${escapeAttr(item.label)}</td>
        <td>${formatMoney(item.period)}</td>
        <td>${formatMoney(item.ytd)}</td>
      </tr>
    `
    )
    .join("");

  elements.pvBenefitsBody.innerHTML = data.benefits
    .map(
      (item) => `
      <tr>
        <td>${escapeAttr(item.label)}</td>
        <td>${formatMoney(item.period)}</td>
        <td>${formatMoney(item.ytd)}</td>
      </tr>
    `
    )
    .join("");

  elements.pvVacHours.textContent = formatMoney(data.vacHours);
  elements.pvSickHours.textContent = formatMoney(data.sickHours);
  elements.pvDepositAmount.textContent = `$ ${formatMoney(totals.netThis)}`;
  elements.pvDepositDate.textContent = formatDate(data.payDate);
  elements.pvNetThis.textContent = `$ ${formatMoney(totals.netThis)}`;
  elements.pvNetYtd.textContent = formatMoney(totals.netYtd);
  elements.pvNotes.textContent = data.notes;

  elements.pvCompanyName.textContent = data.companyName || "";
  elements.pvPayee.textContent = data.employeeName || "";
  elements.pvAmountWords.textContent = numberToWords(totals.netThis).toUpperCase();
  elements.pvAmountNumber.textContent = `$ ${formatMoney(totals.netThis)}`;

  renderEmploymentPreview(data);
  renderStatementPreview(data);
  renderScotiaPreview(data);
  renderCibcPreview(data);
  renderRbcPreview(data);
  renderBmoPreview(data);
  renderSimpliiPreview(data);
  renderNoaPreview(data);
  renderT4Preview(data);
  renderBmoVoidPreview(data);
  renderScotiaVoidPreview(data);
  renderRbcVoidPreview(data);
  renderTdVoidPreview(data);
  renderCibcVoidPreview(data);
  scheduleDraftSave();
}

function getTemplates() {
  try {
    const raw = localStorage.getItem(TEMPLATE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveTemplates(templates) {
  localStorage.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify(templates));
}

function refreshTemplateSelect() {
  const templates = getTemplates();
  elements.templateSelect.innerHTML = "";

  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = templates.length ? "Select template" : "No templates saved";
  elements.templateSelect.appendChild(defaultOption);

  for (const template of templates) {
    const option = document.createElement("option");
    option.value = template.name;
    option.textContent = template.name;
    elements.templateSelect.appendChild(option);
  }
}

function setTemplateMeta(message, isError = false) {
  if (!elements.templateMeta) return;
  elements.templateMeta.textContent = message;
  elements.templateMeta.style.color = isError ? "#8a2f2f" : "";
}

function saveCurrentTemplate() {
  const typedName = safeText(elements.templateNameInput?.value);
  const selectedName = safeText(elements.templateSelect?.value);
  const name = typedName || selectedName;
  if (!name) {
    setTemplateMeta("Enter a template name first.", true);
    return;
  }

  const templates = getTemplates();
  const payload = { name: name.trim(), data: getCurrentFormData() };
  const existingIndex = templates.findIndex((item) => item.name === payload.name);

  if (existingIndex >= 0) {
    templates[existingIndex] = payload;
  } else {
    templates.push(payload);
  }

  saveTemplates(templates);
  refreshTemplateSelect();
  elements.templateSelect.value = payload.name;
  if (elements.templateNameInput) elements.templateNameInput.value = payload.name;
  setTemplateMeta(`Saved template: ${payload.name}`);
}

function updateSelectedTemplate() {
  const name = safeText(elements.templateSelect?.value);
  if (!name) {
    setTemplateMeta("Select a template to update.", true);
    return;
  }

  const templates = getTemplates();
  const idx = templates.findIndex((item) => item.name === name);
  if (idx < 0) {
    setTemplateMeta("Template not found.", true);
    return;
  }
  templates[idx] = { ...templates[idx], data: getCurrentFormData() };
  saveTemplates(templates);
  setTemplateMeta(`Updated template: ${name}`);
}

function deleteSelectedTemplate() {
  const name = safeText(elements.templateSelect?.value);
  if (!name) {
    setTemplateMeta("Select a template to delete.", true);
    return;
  }
  if (!window.confirm(`Delete template "${name}"?`)) return;

  const next = getTemplates().filter((item) => item.name !== name);
  saveTemplates(next);
  refreshTemplateSelect();
  elements.templateSelect.value = "";
  if (elements.templateNameInput) elements.templateNameInput.value = "";
  setTemplateMeta(`Deleted template: ${name}`);
}

function loadSelectedTemplate() {
  const name = elements.templateSelect.value;
  if (!name) return;
  const template = getTemplates().find((item) => item.name === name);
  if (!template) return;
  if (elements.templateNameInput) elements.templateNameInput.value = name;
  hydrateForm(template.data);
  renderPreview();
  setTemplateMeta(`Loaded template: ${name}`);
}

function exportJson() {
  const data = getCurrentFormData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download =
    getDocumentType() === "employment"
      ? "employment-letter.json"
      : getDocumentType() === "statement"
        ? "statement.json"
      : getDocumentType() === "scotiaStatement"
        ? "scotia-statement.json"
      : getDocumentType() === "cibcStatement"
        ? "cibc-statement.json"
      : getDocumentType() === "rbcStatement"
        ? "rbc-statement.json"
      : getDocumentType() === "bmoStatement"
        ? "bmo-statement.json"
      : getDocumentType() === "simpliiStatement"
        ? "simplii-statement.json"
      : getDocumentType() === "noaStatement"
        ? "noa-statement.json"
      : getDocumentType() === "t4Slip"
        ? "t4-slip.json"
      : "payroll-statement.json";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function importJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result));
      hydrateForm(parsed);
      renderPreview();
    } catch {
      window.alert("Could not import this JSON file.");
    }
  };
  reader.readAsText(file);
}

function attachTableEvents(tableBody, tableKind) {
  if (!tableBody) return;
  tableBody.addEventListener("input", renderPreview);
  tableBody.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.classList.contains("duplicate-row")) {
      const sourceRow = target.closest("tr");
      if (!sourceRow) return;
      const values = {};
      sourceRow.querySelectorAll("[data-key]").forEach((input) => {
        const key = input.getAttribute("data-key");
        if (!key) return;
        values[key] = input.value;
      });
      if (tableKind === "scotia") {
        addScotiaRow(tableBody, values);
      } else if (tableKind === "cibc") {
        addCibcRow(tableBody, values);
      } else if (tableKind === "rbc") {
        addRbcRow(tableBody, values);
      } else if (tableKind === "bmo") {
        addBmoRow(tableBody, values);
      } else if (tableKind === "simplii") {
        addSimpliiRow(tableBody, values);
      } else if (tableKind === "noa") {
        addNoaRow(tableBody, values);
      } else if (tableKind === "statement") {
        addStatementRow(tableBody, values);
      } else if (tableKind === "earnings") {
        addRow(tableBody, "earnings", values);
      } else {
        addRow(tableBody, "benefits", values);
      }
      renderPreview();
      return;
    }
    if (!target.classList.contains("remove-row")) return;
    target.closest("tr")?.remove();
    renderPreview();
  });
}

function init() {
  loadTokenCount();

  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      localStorage.removeItem('token');
      window.location.href = '/login.html';
    });
  }

  buildControlAccordions();
  const restored = restoreDraftIfAvailable();
  if (!restored) {
    suspendDraftSave = true;
    hydrateForm(sampleData);
    suspendDraftSave = false;
  }

  const urlDocType = new URLSearchParams(window.location.search).get("docType");
  if (urlDocType) { setDocumentType(urlDocType); renderPreview(); }

  elements.addEarningBtn.addEventListener("click", () => {
    addRow(elements.earningsTable, "earnings", { label: "Allowance" });
    renderPreview();
  });

  elements.addRegularBtn.addEventListener("click", () => {
    addRow(elements.earningsTable, "earnings", { label: "Regular", rate: 0, hours: 0 });
    renderPreview();
  });

  elements.addOvertimeBtn.addEventListener("click", () => {
    addRow(elements.earningsTable, "earnings", { label: "Overtime", rate: 0, hours: 0 });
    renderPreview();
  });

  elements.addBonusBtn.addEventListener("click", () => {
    addRow(elements.earningsTable, "earnings", { label: "Bonus", rate: 0, hours: 1 });
    renderPreview();
  });

  elements.addDeductionBtn.addEventListener("click", renderPreview);

  elements.addBenefitBtn.addEventListener("click", () => {
    addRow(elements.benefitsTable, "benefits", { label: "Benefit" });
    renderPreview();
  });

  elements.addStatementRowBtn.addEventListener("click", () => {
    addStatementRow(elements.statementTransactionsTable, { date: "", description: "", debit: "", credit: "" });
    renderPreview();
  });

  elements.addScotiaRowBtn.addEventListener("click", () => {
    addScotiaRow(elements.scotiaTransactionsTable, { date: "", description: "", detail: "", withdrawn: "", deposited: "" });
    renderPreview();
  });

  elements.addCibcRowBtn.addEventListener("click", () => {
    addCibcRow(elements.cibcTransactionsTable, { date: "", description: "", detail: "", withdrawn: "", deposited: "" });
    renderPreview();
  });

  elements.addRbcRowBtn.addEventListener("click", () => {
    addRbcRow(elements.rbcTransactionsTable, { date: "", description: "", withdrawn: "", deposited: "" });
    renderPreview();
  });

  elements.addBmoRowBtn.addEventListener("click", () => {
    addBmoRow(elements.bmoTransactionsTable, { date: "", description: "", deducted: "", added: "" });
    renderPreview();
  });

  elements.addSimpliiRowBtn.addEventListener("click", () => {
    addSimpliiRow(elements.simpliiTransactionsTable, { transDate: "", effDate: "", description: "", fundsOut: "", fundsIn: "" });
    renderPreview();
  });

  elements.addNoaRowBtn.addEventListener("click", () => {
    addNoaRow(elements.noaSummaryTable, { line: "", description: "", amount: "", crdr: "" });
    renderPreview();
  });

  attachTableEvents(elements.earningsTable, "earnings");
  attachTableEvents(elements.benefitsTable, "benefits");
  attachTableEvents(elements.statementTransactionsTable, "statement");
  attachTableEvents(elements.scotiaTransactionsTable, "scotia");
  attachTableEvents(elements.cibcTransactionsTable, "cibc");
  attachTableEvents(elements.rbcTransactionsTable, "rbc");
  attachTableEvents(elements.bmoTransactionsTable, "bmo");
  attachTableEvents(elements.simpliiTransactionsTable, "simplii");
  attachTableEvents(elements.noaSummaryTable, "noa");

  for (const field of [
    elements.companyName,
    elements.brandText,
    elements.brandColor,
    elements.designTemplate,
    elements.periodEnding,
    elements.payDate,
    elements.province,
    elements.frequency,
    elements.employeeName,
    elements.employeeId,
    elements.employeeAddress,
    elements.vacHours,
    elements.sickHours,
    elements.notes,
    elements.evDate,
    elements.evEmployeeName,
    elements.evStartDate,
    elements.evEmployeeAddress,
    elements.evCompanyName,
    elements.evCompanyAddress,
    elements.evAnnualIncome,
    elements.evPosition,
    elements.crName,
    elements.crReferenceNumber,
    elements.crRequestDate,
    elements.crDob,
    elements.crSin,
    elements.crPhone,
    elements.crAddress1,
    elements.crAddress2,
    elements.crAka,
    elements.crPersonalFileNumber,
    elements.crCurrentReportedDate,
    elements.crCurrentAddress,
    elements.crCurrentCity,
    elements.crCurrentProvince,
    elements.crCurrentPostal,
    elements.crPreviousReportedDate,
    elements.crPreviousAddress,
    elements.crPreviousCity,
    elements.crPreviousProvince,
    elements.crPreviousPostal,
    elements.crCreditScore,
    elements.noaName,
    elements.noaAddress,
    elements.noaLocation,
    elements.noaSin,
    elements.noaTaxYear,
    elements.noaDateIssued,
    elements.noaRefNumber,
    elements.noaRefCode,
    elements.noaAccountNumber,
    elements.noaAnnualIncome,
    elements.noaTaxDeducted,
    elements.noaBalanceOverride,
    elements.noaBalanceOverrideCrdr,
    elements.noaCommissioner,
    elements.noaExplanation,
    elements.stName,
    elements.stAddress,
    elements.stBranchAddress,
    elements.stBranchNo,
    elements.stAccountNo,
    elements.stFrom,
    elements.stTo,
    elements.stOpeningBalance,
    elements.stAccountType,
    elements.scName,
    elements.scAddress,
    elements.scBranchAddress,
    elements.scAccountNo,
    elements.scAccountType,
    elements.scFrom,
    elements.scTo,
    elements.scOpeningBalance,
    elements.cbName,
    elements.cbAddress,
    elements.cbAccountNo,
    elements.cbBranchTransit,
    elements.cbFrom,
    elements.cbTo,
    elements.cbOpeningBalance,
    elements.cbDisclaimer,
    elements.rbName,
    elements.rbAddress,
    elements.rbAccountNo,
    elements.rbAccountType,
    elements.rbBankBranch,
    elements.rbFrom,
    elements.rbTo,
    elements.rbOpeningBalance,
    elements.bmName,
    elements.bmAddress,
    elements.bmBranchAddress,
    elements.bmBranchName,
    elements.bmTransitNo,
    elements.bmPhone,
    elements.bmPlanName,
    elements.bmAccountNo,
    elements.bmAccountType,
    elements.bmPeriodEnd,
    elements.bmOpeningBalance,
    elements.sfName,
    elements.sfAddress,
    elements.sfAccountNo,
    elements.sfFrom,
    elements.sfTo,
    elements.sfStatementDate,
    elements.sfOpeningBalance,
  ]) {
    if (!field) continue;
    field.addEventListener("input", renderPreview);
    field.addEventListener("change", renderPreview);
  }

  if (elements.t4Controls) {
    elements.t4Controls.addEventListener("input", renderPreview);
    elements.t4Controls.addEventListener("change", renderPreview);
  }

  if (elements.bmoVoidControls) {
    elements.bmoVoidControls.addEventListener("input", renderPreview);
    elements.bmoVoidControls.addEventListener("change", renderPreview);
  }
  if (elements.scotiaVoidControls) {
    elements.scotiaVoidControls.addEventListener("input", renderPreview);
    elements.scotiaVoidControls.addEventListener("change", renderPreview);
  }
  if (elements.rbcVoidControls) {
    elements.rbcVoidControls.addEventListener("input", renderPreview);
    elements.rbcVoidControls.addEventListener("change", renderPreview);
  }
  if (elements.tdVoidControls) {
    elements.tdVoidControls.addEventListener("input", renderPreview);
    elements.tdVoidControls.addEventListener("change", renderPreview);
  }
  if (elements.cibcVoidControls) {
    elements.cibcVoidControls.addEventListener("input", renderPreview);
    elements.cibcVoidControls.addEventListener("change", renderPreview);
  }

  elements.documentTypeSelect.addEventListener("change", () => {
    setDocumentType(elements.documentTypeSelect.value);
    renderPreview();
  });

  elements.templateSelect.addEventListener("change", () => {
    const selected = safeText(elements.templateSelect.value);
    if (elements.templateNameInput && selected) {
      elements.templateNameInput.value = selected;
    }
  });

  elements.printBtn.addEventListener("click", downloadPdf);
  if (elements.quickSaveBtn) {
    elements.quickSaveBtn.addEventListener("click", downloadPdf);
  }
  elements.loadSampleBtn.addEventListener("click", () => {
    const next = cloneData(sampleData);
    next.documentType = getDocumentType();
    suspendDraftSave = true;
    hydrateForm(next);
    suspendDraftSave = false;
    renderPreview();
  });

  elements.saveTemplateBtn.addEventListener("click", saveCurrentTemplate);
  elements.updateTemplateBtn.addEventListener("click", updateSelectedTemplate);
  elements.deleteTemplateBtn.addEventListener("click", deleteSelectedTemplate);
  elements.loadTemplateBtn.addEventListener("click", loadSelectedTemplate);
  elements.exportJsonBtn.addEventListener("click", exportJson);
  elements.importJson.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (file) importJson(file);
  });

  elements.evLogoFile.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      employmentLogoDataUrl = "";
      renderPreview();
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      employmentLogoDataUrl = safeText(reader.result);
      renderPreview();
    };
    reader.onerror = () => {
      employmentLogoDataUrl = "";
      window.alert("Could not read the selected logo file.");
      renderPreview();
    };
    reader.readAsDataURL(file);
  });

  if (elements.payrollLogoFile) {
    elements.payrollLogoFile.addEventListener("change", (event) => {
      const file = event.target.files?.[0];
      if (!file) {
        payrollLogoDataUrl = "";
        renderPreview();
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        payrollLogoDataUrl = safeText(reader.result);
        renderPreview();
      };
      reader.onerror = () => {
        payrollLogoDataUrl = "";
        window.alert("Could not read the selected payroll logo file.");
        renderPreview();
      };
      reader.readAsDataURL(file);
    });
  }

  refreshTemplateSelect();
  renderPreview();

}

init();

window._loadPreset = function(data) {
  suspendDraftSave = true;
  hydrateForm(data);
  suspendDraftSave = false;
  renderPreview();
};

(function applyHashPreset() {
  try {
    const hash = window.location.hash;
    const match = hash.match(/[#&]preset=([^&]*)/);
    if (!match) return;
    const decoded = decodeURIComponent(escape(atob(match[1])));
    const data = JSON.parse(decoded);
    window._loadPreset(data);
    history.replaceState(null, "", window.location.pathname + window.location.search);
  } catch (e) {}
})();
