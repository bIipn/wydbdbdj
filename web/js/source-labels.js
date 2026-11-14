// The bid boards as the app names them: ONE table. A new board in src/sources/index.ts (ALL_SOURCES) gets one
// line here and nothing else in web/ (test/source-seams.test.ts checks the ids match). The card itself shows the
// bid's own sourceName from the server; this table is for the Browse "Source" filter and the cost check.
//   id     = src/types.ts SourceId
//   label  = the filter chip
//   state  = where the board's bids are ('US' = nationwide)
//   owner  = optional: who owns the job, prefilled in the cost check "from the bid" (src/cost/defaults.ts OwnerType)

export const SOURCE_LABELS = [
  { id: 'nevadaepro', label: 'NevadaEPro', state: 'NV' },
  { id: 'ngem', label: 'NGEM', state: 'NV' },
  { id: 'questcdn', label: 'QuestCDN', state: 'NV' },
  { id: 'douglascounty', label: 'Douglas County', state: 'NV', owner: 'nv_local' },
  { id: 'samgov', label: 'SAM.gov', state: 'US', owner: 'federal' },
  { id: 'caleprocure', label: 'Cal eProcure', state: 'CA', owner: 'ca_state' },
  { id: 'caltrans', label: 'Caltrans', state: 'CA', owner: 'caltrans' },
  { id: 'opengov', label: 'OpenGov', state: 'US' },
  { id: 'laramp', label: 'LA City', state: 'CA', owner: 'ca_local' },
  { id: 'sfbids', label: 'San Francisco', state: 'CA', owner: 'ca_local' },
  { id: 'oregonbuys', label: 'OregonBuys', state: 'OR' },
  { id: 'commbuys', label: 'COMMBUYS', state: 'MA' },
  { id: 'bidbuy', label: 'BidBuy Illinois', state: 'IL' },
  { id: 'njstart', label: 'NJSTART', state: 'NJ' },
  { id: 'nycrecord', label: 'NYC City Record', state: 'NY' },
  { id: 'txesbd', label: 'Texas ESBD', state: 'TX' },
  { id: 'flmfmp', label: 'MyFloridaMarketPlace', state: 'FL' },
  { id: 'usac470', label: 'E-Rate Form 470', state: 'US' },
];

/** The cost check's "owner from the bid" prefill, by board (only boards whose owner is always the same kind). */
export const OWNER_FROM_SOURCE = Object.fromEntries(SOURCE_LABELS.filter((s) => s.owner).map((s) => [s.id, s.owner]));
