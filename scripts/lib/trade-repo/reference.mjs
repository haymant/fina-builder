// Demo reference data for the Phoenix-first scope: issuing legal entities -> EQD desks ->
// books, distributor/hedge counterparties, users/entitlements.
export const REFERENCE = {
  parties: [
    { partyId: 'LE-FINA-UK', kind: 'LEGAL_ENTITY', name: 'Fina Markets UK Ltd', lei: '5493001KJTIIGC8Y1R12', country: 'GB' },
    { partyId: 'LE-FINA-SG', kind: 'LEGAL_ENTITY', name: 'Fina Markets Singapore Pte', lei: '549300SGFINA0000SG01', country: 'SG' },
    { partyId: 'CP-GSI', kind: 'COUNTERPARTY', name: 'Goldman Sachs International', lei: 'W22LROWP2IHZNBB6K528', country: 'GB' },
    { partyId: 'CP-JPM', kind: 'COUNTERPARTY', name: 'J.P. Morgan SE', lei: '549300ZK53CNGEEI6A29', country: 'DE' },
    { partyId: 'CP-BNP', kind: 'COUNTERPARTY', name: 'BNP Paribas', lei: 'R0MUWSFPU8MPRO8K5P83', country: 'FR' },
    { partyId: 'CP-DBS', kind: 'COUNTERPARTY', name: 'DBS Bank Ltd (Private Bank)', lei: 'ATUEL7OJR5057F2PV266', country: 'SG' },
    { partyId: 'CP-HSBC', kind: 'COUNTERPARTY', name: 'HSBC Private Bank', lei: 'MP6I5ZYZBEU3UXPYFY54', country: 'GB' },
    { partyId: 'CP-UOB', kind: 'COUNTERPARTY', name: 'UOB Private Bank', lei: 'IO66REGK3RCBAMA8HR66', country: 'SG' },
    { partyId: 'CP-JB', kind: 'COUNTERPARTY', name: 'Julius Baer', lei: 'PNWHV1W2GJ4N8NWX4M57', country: 'CH' },
    { partyId: 'CP-UBS', kind: 'COUNTERPARTY', name: 'UBS Wealth Management', lei: 'BFM8T61CT2L1QCEMIK50', country: 'CH' },
  ],
  desks: [
    { deskId: 'DESK-EQD-LDN', name: 'EQD Structured (London)', legalEntityId: 'LE-FINA-UK' },
    { deskId: 'DESK-EQD-SG', name: 'EQD Structured (Singapore)', legalEntityId: 'LE-FINA-SG' },
  ],
  books: [
    { bookId: 'PHX-EUR', name: 'Phoenix EUR (London)', deskId: 'DESK-EQD-LDN', legalEntityId: 'LE-FINA-UK', baseCurrency: 'EUR' },
    { bookId: 'PHX-USD', name: 'Phoenix USD (London)', deskId: 'DESK-EQD-LDN', legalEntityId: 'LE-FINA-UK', baseCurrency: 'USD' },
    { bookId: 'PHX-ASIA', name: 'Phoenix Asia (Singapore)', deskId: 'DESK-EQD-SG', legalEntityId: 'LE-FINA-SG', baseCurrency: 'USD' },
    { bookId: 'PHX-HEDGE', name: 'Phoenix hedge / buyback inventory', deskId: 'DESK-EQD-SG', legalEntityId: 'LE-FINA-SG', baseCurrency: 'USD' },
  ],
  users: [
    { userId: 'trash.box', name: 'Trash Box', role: 'admin', deskId: null, books: [] },
    { userId: 'alice.sg', name: 'Alice (SG structurer)', role: 'trader', deskId: 'DESK-EQD-SG', books: ['PHX-ASIA', 'PHX-HEDGE'] },
    { userId: 'eddie.ldn', name: 'Eddie (London trader)', role: 'trader', deskId: 'DESK-EQD-LDN', books: ['PHX-EUR', 'PHX-USD'] },
    { userId: 'olga.ops', name: 'Olga (Middle office)', role: 'ops', deskId: null, books: [] },
    { userId: 'victor.view', name: 'Victor (Read-only)', role: 'viewer', deskId: null, books: [] },
  ],
}
