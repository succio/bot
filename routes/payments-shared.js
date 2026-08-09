const PACKAGES = {
  month1: {
    name: '1 Month Statement',
    price: 35,
    credits: 1,
    currency: 'usd',
    description: '1 monthly bank statement',
    features: ['All major Canadian banks', 'Carry-over balance across months', 'Add custom transactions', 'Auto calculations']
  },
  month3: {
    name: '3 Month Statement',
    price: 100,
    credits: 3,
    currency: 'usd',
    description: '3 consecutive monthly statements',
    features: ['All major Canadian banks', 'Carry-over balance across months', 'Add custom transactions', 'Auto calculations']
  },
  month6: {
    name: '6 Month Statement',
    price: 200,
    credits: 6,
    currency: 'usd',
    description: '6 consecutive monthly statements',
    features: ['All major Canadian banks', 'Carry-over balance across months', 'Add custom transactions', 'Auto calculations']
  },
  addondoc: {
    name: 'Additional Document',
    price: 35,
    credits: 1,
    currency: 'usd',
    description: 'One additional document type',
    features: ['Paystubs', 'Void Cheque', 'CRA Notice of Assessment', 'T4 Slip']
  }
};

module.exports = { PACKAGES };
