const DOCUMENT_PRICES = {
  bank: 40,
  paystub: 35,
  t4: 40,
  noa: 40,
  void: 30
};

const PRICE_LABELS = {
  bank: 'BANK STATEMENT',
  paystub: 'PAYSTUB',
  t4: 'T4 SLIP',
  noa: 'NOA',
  void: 'VOID CHEQUE'
};

const PACKAGES = {
  balance40: {
    name: 'Add $40 Balance',
    price: 40,
    amount: 40,
    currency: 'usd',
    description: '$40 USD account balance',
    features: ['Use toward any document']
  },
  balance100: {
    name: 'Add $100 Balance',
    price: 100,
    amount: 100,
    currency: 'usd',
    description: '$100 USD account balance',
    features: ['Use toward any document']
  },
  balance200: {
    name: 'Add $200 Balance',
    price: 200,
    amount: 200,
    currency: 'usd',
    description: '$200 USD account balance',
    features: ['Use toward any document']
  },
  balance400: {
    name: 'Add $400 Balance',
    price: 400,
    amount: 400,
    currency: 'usd',
    description: '$400 USD account balance',
    features: ['Use toward any document']
  }
};

module.exports = { PACKAGES, DOCUMENT_PRICES, PRICE_LABELS };
