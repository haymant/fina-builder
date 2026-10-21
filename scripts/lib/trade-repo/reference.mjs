// Demo reference data: legal entity -> desk -> book hierarchy, counterparties, users/entitlements.
export const REFERENCE = {
  parties: [
    { partyId: 'LE-FINA-UK', kind: 'LEGAL_ENTITY', name: 'Fina Markets UK Ltd', lei: '5493001KJTIIGC8Y1R12', country: 'GB' },
    { partyId: 'LE-FINA-SG', kind: 'LEGAL_ENTITY', name: 'Fina Markets Singapore Pte', lei: '549300SGFINA0000SG01', country: 'SG' },
    { partyId: 'CP-GSI', kind: 'COUNTERPARTY', name: 'Goldman Sachs International', lei: 'W22LROWP2IHZNBB6K528', country: 'GB' },
    { partyId: 'CP-JPM', kind: 'COUNTERPARTY', name: 'J.P. Morgan SE', lei: '549300ZK53CNGEEI6A29', country: 'DE' },
    { partyId: 'CP-BNP', kind: 'COUNTERPARTY', name: 'BNP Paribas', lei: 'R0MUWSFPU8MPRO8K5P83', country: 'FR' },
    { partyId: 'CP-DBS', kind: 'COUNTERPARTY', name: 'DBS Bank Ltd', lei: 'ATUEL7OJR5057F2PV266', country: 'SG' },
    { partyId: 'CP-HSBC', kind: 'COUNTERPARTY', name: 'HSBC Bank plc', lei: 'MP6I5ZYZBEU3UXPYFY54', country: 'GB' },
    { partyId: 'CP-BLK', kind: 'COUNTERPARTY', name: 'BlackRock Fund Advisors', lei: '5493001LN0KVXPKQXL27', country: 'US' },
    { partyId: 'CP-CITI', kind: 'COUNTERPARTY', name: 'Citigroup Global Markets', lei: 'XKZZ2JZF41MRHTR1V493', country: 'GB' },
    { partyId: 'CP-UBS', kind: 'COUNTERPARTY', name: 'UBS AG', lei: 'BFM8T61CT2L1QCEMIK50', country: 'CH' },
  ],
  desks: [
    { deskId: 'DESK-RATES', name: 'Rates', legalEntityId: 'LE-FINA-UK' },
    { deskId: 'DESK-FX', name: 'FX', legalEntityId: 'LE-FINA-SG' },
    { deskId: 'DESK-EQD', name: 'Equity Derivatives', legalEntityId: 'LE-FINA-UK' },
    { deskId: 'DESK-CREDIT', name: 'Credit', legalEntityId: 'LE-FINA-UK' },
  ],
  books: [
    { bookId: 'RATES-GBP', name: 'Rates GBP Swaps', deskId: 'DESK-RATES', legalEntityId: 'LE-FINA-UK', baseCurrency: 'GBP' },
    { bookId: 'RATES-USD', name: 'Rates USD Swaps', deskId: 'DESK-RATES', legalEntityId: 'LE-FINA-UK', baseCurrency: 'USD' },
    { bookId: 'FX-ASIA', name: 'FX Asia Forwards', deskId: 'DESK-FX', legalEntityId: 'LE-FINA-SG', baseCurrency: 'USD' },
    { bookId: 'EQD-FLOW', name: 'EQD Flow Options', deskId: 'DESK-EQD', legalEntityId: 'LE-FINA-UK', baseCurrency: 'USD' },
    { bookId: 'EQD-EXOTICS', name: 'EQD Exotics (Phoenix)', deskId: 'DESK-EQD', legalEntityId: 'LE-FINA-UK', baseCurrency: 'USD' },
    { bookId: 'CREDIT-IG', name: 'Credit IG CDS', deskId: 'DESK-CREDIT', legalEntityId: 'LE-FINA-UK', baseCurrency: 'EUR' },
  ],
  users: [
    { userId: 'trash.box', name: 'Trash Box', role: 'admin', deskId: null, books: [] },
    { userId: 'alice.rates', name: 'Alice (Rates trader)', role: 'trader', deskId: 'DESK-RATES', books: ['RATES-GBP', 'RATES-USD'] },
    { userId: 'eddie.eqd', name: 'Eddie (EQD trader)', role: 'trader', deskId: 'DESK-EQD', books: ['EQD-FLOW', 'EQD-EXOTICS'] },
    { userId: 'olga.ops', name: 'Olga (Middle office)', role: 'ops', deskId: null, books: [] },
    { userId: 'victor.view', name: 'Victor (Read-only)', role: 'viewer', deskId: null, books: [] },
  ],
}
