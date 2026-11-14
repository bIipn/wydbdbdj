import { describe, expect, it } from 'vitest';
import { isTradeWork, keepTradeWork, type TradeWorkInput } from '../src/sources/relevance.js';

/**
 * isTradeWork on REAL listings: every title below is copied verbatim from the first responses of the new boards
 * (2026-11-14, the scanner's User-Agent; kept outside the repo as first/*.out, the builders turn them into
 * fixtures). The expected answer was decided by reading each title, not by running the code: KEEP = work a
 * contractor could do, or unclear (the rule: anything unclear is kept); DROP = clearly not contractor work.
 * Category and codes are the board's own fields for that row, where the board gives them.
 */
type Case = [board: string, input: TradeWorkInput | string, keep: boolean];

const KEEP = true;
const DROP = false;

const CASES: Case[] = [
  // --- Texas ESBD (texas.out): title + the row's nigpCodes ---
  ['tx', 'Linen Laundry Services for El Paso State Supported Living Center', DROP],
  ['tx', '302-27-256842 FY27 Sumuri TALINO Intel Workstation-IFB', DROP],
  ['tx', { title: 'Micromobility Services', codes: { nigp: ['95841', '97550', '97514', '07120'] } }, KEEP], // 958 is not all non-trade: unclear
  ['tx', { title: 'Course and Program Development Services', codes: { nigp: ['92091', '92416', '91838'] } }, DROP],
  ['tx', 'Jersey Village Generator Maintennance Services', KEEP],
  ['tx', { title: 'Sierra Blanca Maintenance Facility Fabric Salt Shed, El Paso District', codes: { nigp: ['90925-Building Construction, Prefabricated (All Types)'] } }, KEEP],
  ['tx', 'Cathodic Inspection Services', KEEP], // unclear
  ['tx', 'AUTOMATIC PASSENGER COUNTER (APC) SYSTEM FOR CONCHO VALLEY TRANSIT DISTRICT', KEEP], // unclear
  ['tx', 'Blanket Contract for Marketing Services', DROP],
  ['tx', 'As Needed Heat Treatment Bed Bug Eradication Brenham State Supported Living Center', DROP],
  ['tx', { title: 'Enterprise Fraud Risk Program', codes: { nigp: ['20811', '92045', '92047', '92014', '91890', '91871', '91832', '91821'] } }, DROP],
  ['tx', 'Traffic Control Services, Statewide', KEEP], // unclear: flagging crews work on construction sites
  ['tx', 'Aluminum Stock Trailer', DROP],
  ['tx', 'Removal and Disposal of Deceased Animals within TxDOT San Antonio District', DROP],
  ['tx', 'RFPCSP-730-UofH-3160 University of Houston Cullen Security Cameras FY27', KEEP],
  ['tx', { title: 'CSP # 754 Mitte HVAC Renovation - 2026', codes: { nigp: ['94155', '91450'] } }, KEEP],
  ['tx', { title: 'TDCJ - Water Treatment Plant for Memorial', codes: { nigp: ['89016', '89067', '91360', '96896'] } }, KEEP],
  ['tx', { title: 'UT Dallas Convergence Accelerator', codes: { nigp: ['90900', '90927', '91100', '91400', '95826'] } }, KEEP],
  ['tx', { title: 'Secondary Ticket Market Inventory Partners', codes: { nigp: ['86000', '96153'] } }, DROP],
  ['tx', 'IFB 2027-B03 Countywide Dumpsters', DROP],
  ['tx', 'Unarmed security guard services for San Antonio State Hospital', DROP],

  // --- MyFloridaMarketPlace (florida-ok.out): title + the row's type as category ---
  ['fl', { title: 'St Pete Campus Fire Alarm Replacement', category: 'Agency Decision' }, KEEP],
  ['fl', 'Janitorial Services for Chiefland Maintenance Complex', DROP],
  ['fl', { title: 'Criminal Justice, Mental Health, and Substance Abuse Reinvestment Grant Program', category: 'Grant Opportunities' }, DROP],
  ['fl', 'DISTRICT 1 HQ HVAC IMPROVEMENTS', KEEP],
  ['fl', 'Statewide Roof Maintenance, Repair, and Replacement Services', KEEP],
  ['fl', 'ITB-26-0010B Chester Sims Nurse Call System Replacement', KEEP], // low-voltage installation
  ['fl', 'Florida State Hospital Elevator Maintenance and Repair', KEEP],
  ['fl', 'Electrical Maintenenace and Repair Services', KEEP],
  ['fl', 'ITB-27-002B- Bennett Lochinvar Boiler #2 Replacement', KEEP],
  ['fl', 'Laboratory Analysis on Water Treatment Plants, Wastewater Treatment Plants, and Groundwater Monitor', DROP],
  ['fl', 'Awning and Sunshade Installation for Miami-Dade County Health Dept', KEEP],
  ['fl', 'DJJ ITB 26/27 008 Lawn Care Services - Pine Hills', KEEP],
  ['fl', 'Total Vehicle Upfitting Services', DROP],
  ['fl', 'Joshua Creek West 26/27 Grazing Lease', DROP],
  ['fl', 'Tacachale Refuse Removal', DROP],
  ['fl', 'PUBLIC ANNOUNCEMENT FOR HOGLE BOILERS (PHASE II) ITB-27-055', KEEP],
  ['fl', 'Herbicide Treatment Services - Myakka State Forest', KEEP], // unclear (weed control is landscaping work)
  ['fl', 'Microscope Imaging System', DROP],
  ['fl', 'Corn Crib 26/27 Timber Sale', DROP],
  ['fl', 'TRAINING AMMUNITION', DROP],
  ['fl', '42878 - Purchase and Delivery of Corrugated Aluminum Pipe', KEEP], // unclear: a supply, the scorer decides
  ['fl', 'District-Wide Mowing, Landscape Maintenance, and Debris Removal Services', KEEP],
  ['fl', 'Traffic Signals Replacement', KEEP],
  ['fl', 'I-4 Polk County Rest Areas TPAS Retrofit', KEEP],
  ['fl', 'PUBLIC ANNOUNCEMENT FOR Wartmann Interior Painting Project ITB-27-075', KEEP],
  ['fl', 'INVITATION TO BID (ITB) FOR ADRD CURRICULUM REVIEW SERVICES', DROP],
  ['fl', '2027 Overhead Sign Structure Replacements', KEEP],
  ['fl', 'ITB 27B-003 Econfina Creek Site Prep for Reforestation and Habitat Restoration', KEEP],
  ['fl', 'Actuarial Services for the Stanley G. Tate Florida Prepaid College Program', DROP],
  ['fl', 'Audit and Accounting Services for the Florida Prepaid College Board, Stanley G. Tate Florida Prepaid', DROP],
  ['fl', 'Learning Management System', DROP],
  ['fl', 'Compensation Analysis and Market Pay Study', DROP],
  ['fl', 'PUBLIC ANNOUNCEMENT FOR Settles Gym Window Replacements-RFP-27-052', KEEP],
  ['fl', 'PUBLIC ANNOUNCEMENT FOR Existing McClure Demolition & Beautification-RFP-27-068', KEEP],
  ['fl', 'PUBLIC ANNOUNCEMENT FOR HVAC CONTROL UPGRADES (PHASE II) RFP-27-047', KEEP],
  ['fl', 'PUBLIC ANNOUNCEMENT FOR FOOTBALL FIELD IRRIGATION REPLACEMENT RFP-27-041', KEEP],
  ['fl', 'Continuing Architectural/Engineering (A/E) Services - Region 3', DROP],
  ['fl', 'Workforce Ongoing Temporary Disaster-Recovery Staffing', DROP],
  ['fl', 'Private Service of Process', DROP],

  // --- LA RAMP (lacity.out), SF (sf.out), NYC City Record (nyc.out): title + the row's category ---
  ['la', { title: 'VISION ZERO PHASE 2H, BACKLOG REDUCTION PHASE 3 & REAP 2.0 TRAFFIC SIGNAL IMPROVEMENTS', category: 'Construction' }, KEEP],
  ['la', { title: '146861 MOTOR, 150HP, 720RPM', category: 'Commodity' }, DROP],
  ['sf', { title: 'EXT TIS | Emerging Technologies RFQ', category: 'Personal Services' }, DROP],
  ['sf', { title: 'OCA | TC99421 Tech Marketplace 3.0 mLBE SetAsides', category: 'Personal Services' }, DROP],
  ['nyc', { title: 'APPOINTED', category: 'Changes in Personnel' }, DROP],

  // --- OregonBuys (oregon.out) ---
  ['or', '2026.104-ITB Printing Services for Solid Waste & Recycling', DROP],
  ['or', 'Residential Treatment', DROP],
  ['or', 'SOLE SOURCE NOTICE - BOARD Application Support Services', DROP],
  ['or', 'RFQ 2026-85 Mill Park Playground Improvements', KEEP],
  ['or', 'NOT A BID/ OREGON FORWARD Suitability Determination Notice Cornerstone, Janitorial Services', DROP],
  ['or', 'Group Medical Insurance and Pharmacy Drug Coverage Benefit Services', DROP],
  ['or', 'GNA Thunder Cat Environmental Planning Services-Umpqua NF', DROP],
  ['or', 'CRW RFQ for Purpose of Establishing Multiple On Call Flagging and Traffic Control Service Contracts', KEEP], // unclear
  ['or', 'Turkey, Cooked Whole Multi-Muscle', DROP],
  ['or', 'Fresh Produce Bid', DROP],
  ['or', 'Invitation to Bid - Westport Road Improvement Project', KEEP],
  ['or', 'Chicken Strips Raw', DROP],
  ['or', 'ITB - Marion County Courthouse Parking Structure Refurbishment', KEEP],
  ['or', 'Oregon Land Use Hearings Officer Services', DROP],
  ['or', 'RFQ No. 2627-11-001 - On-Call Water System Engineering Services', DROP],
  ['or', 'Intermediate RFP for Facilitation of Strategic Plan', DROP],
  ['or', 'AP for Collaborative Peer-to-Peer Learning Annotation Tool (PCS# 263000-02153-AP)', DROP],
  ['or', 'Alternative Competitive Procurement for Ambient AI Documentation Tool (PCS# 230000-00414-AP)', DROP],
  ['or', 'BULK BIOMASS FUEL PELLETS', DROP],

  // --- COMMBUYS (commbuys.out) ---
  ['ma', 'LEGAL AD ONLY  FY27 ON CALL SERVICE PROVIDER FOR COMMERCIAL KITCHEN EQUIPMENT MAINTENANCE AND REPAIR', KEEP],
  ['ma', '27DSFJF1 | Special Education Transportation', DROP],
  ['ma', 'FFY2027 COUNTER-UNMANNED AIRCRAFT SYSTEMS GRANT PROGRAM', DROP],
  ['ma', "HG&E Contract #27-04 - Hydraulic Structures' Maintnenace & Repairs Annual Contract", KEEP],
  ['ma', 'FY27 Fall Surplus Equipment Auction', DROP],
  ['ma', 'FocalPoint Web-Based Record Information Search Platform', DROP],
  ['ma', 'A26CN05R Design Build (DB) Services for GL B Branch Short Term Accessibility Station Improvements', KEEP],
  ['ma', 'MGC Outside Counsel Services RFR', DROP],
  ['ma', 'Sleepy Hollow Culvert Replacement', KEEP],
  ['ma', 'Quincy Housing Authority Sawyer Towers Roof Replacement', KEEP],
  ['ma', 'Request for Qualifications for Architectural & Building Related Professional Engineering Services, F', DROP],
  ['ma', 'PRF76 ITIL Certification Training RFQ', DROP],
  ['ma', 'Request for Qualifications for Trade Contractors for Salt Shed Replacement Project, File no. COC-RFQ', KEEP],
  ['ma', 'Shrewsbury Police Department Repairs-Invitation for Bids', KEEP],
  ['ma', '2027 Tree Work: Line Clearing and Tree Removals', KEEP],
  ['ma', 'RFQ27-004 Independent Inspection Services', KEEP], // unclear
  ['ma', 'NBHA-26-153 On-Call Electric', KEEP],

  // --- BidBuy Illinois (bidbuy.out) ---
  ['il', 'AGR-ISF-Ambulance Services', DROP],
  ['il', 'IDNR - World Shooting Complex 20x40 Unit Lease - Building 5- Space 501', DROP],
  ['il', 'RR-25-2034 - EWO #1 Offsetting CO #1 - ATP #1 - Systemwide Structural Rehabilitation', KEEP],
  ['il', 'I-16-4669 - CO #45 - ATP #72 - Rdwy and Bridge Construct,IL390 and I490 Intchange', KEEP],
  ['il', 'JPMC Change Order Notice for Small Package Delivery', DROP],
  ['il', 'DHS-SP-Ludeman - Deli-Style Salads Annual Contract FY27/28', DROP],
  ['il', 'DHS MURRAY - IFB PUBLIC ANNOUNCEMENT SYSTEM REPAIR AND REPLACE', KEEP],
  ['il', 'ISAC - 2027 Education Matters (EM) Conference venue', DROP],
  ['il', 'CHANGE ORDER NOTICE - Bar Coded Evidence Analysis Statistics and Tracking Software', DROP],
  ['il', 'DHS IFB AMHC AFC Carpet Removal and Epoxy Flooring Install', KEEP],
  ['il', 'CHANGE ORDER NOTICE: Black Hawk SHS Museum Window Dormer Repairs & Replacements', KEEP],
  ['il', 'CHANGE ORDER NOTICE OLE BODY CAMS', DROP],
  ['il', 'DCI-SOCOM-Training Munitions', DROP],
  ['il', 'AGR-County Fairs-Horse Testing', DROP],
  ['il', 'DMH IFB CMHC Closet Doors', KEEP],
  ['il', 'JPMC SOURCEWELL RFP 122226 FIREARMS AND AMMUNITION WITH RELATED SUPPLIES AND SERVICES', DROP],

  // --- NJSTART (njstart.out) ---
  ['nj', 'T3151 Workforce Development Case Management Solution', DROP],
  ['nj', 'T2314 - NJKiDS Application Maintenance and Support for NJ ACSES', DROP],
  ['nj', 'T2789 Bucket Truck, Minimum 19,500 lb. GVWR Crew Cab and Chassis, DRW, 4WD with Maximum 10.5 Foot Se', DROP],
  ['nj', 'T2949 - Fiscal Intermediary and Financial Cash and Counseling Services: DHS', DROP],
  ['nj', 'T2621 - NJDEP Remedial Investigation and Design Services', DROP],
  ['nj', 'T2774 - Front End Mail Receipt & Pre-Processing Services - DORES', DROP],
  ['nj', 'T1628 Enhanced Motor Vehicle Inspection Maintenance System', DROP],
  ['nj', 'T1901 - Telephonic - Tobacco Cessation Counseling (DOH) REBID', DROP],
  ['nj', 'T2775 - Data Entry/Verification Services - Division of Revenue and Enterprise Services', DROP],
  ['nj', 'T0946 - New Jersey Behavioral Risk Factor Survey', DROP],
  ['nj', 'T3165 - Naloxone, 4mg Nasal Spray, FDA-Approved, for the New Jersey Department of Human Services', DROP],
  ['nj', 'T1954 - Professional Auctioneer Services for Vehicles and Heavy Equipment - DSS', DROP],
  ['nj', 'T0200 - Mailroom Equipment, Accessories, Supplies and Maintenance', DROP],
  ['nj', 'T2679 - Employee Benefits: Pharmacy Benefits Management', DROP],

  // --- Cal eProcure (fiscal-grid.out) ---
  ['ca', 'UCLA Center for Health Sciences Fire Sprinkler Retrofit | School of Medicine,(5th & 6th floor) No. 906032', KEEP],
  ['ca', 'C5613433-D Grease Trap and Septic Tank Pumping Services', KEEP],
  ['ca', 'C5613445-D American Sign Language (ASL) In-Person Interpreting (IPI) Services', DROP],
  ['ca', 'C26645003 Roof Replacement Weaverville Joss House, Visitor Center', KEEP],
  ['ca', 'WANTED TO LEASE BY THE STATE OF CALIFORNIA - Woodland', DROP],
  ['ca', 'Invitation For Bid P2675010, Analytical Testing Services', DROP],
  ['ca', '79050750-Telesign Service Platform', DROP],
  ['ca', '1026-006: California Geological Survey (CGS) Style Guide', DROP],
  ['ca', 'P2640008: Generator Maintenance and Repairs, at the Salmon Conservation and Research Facility (main and interim facilities), Fresno County, California', KEEP],
  ['ca', 'IFB 08A4047, Elevator Maintenance in San Bernardino County', KEEP],
  ['ca', 'Dam Safety Engineering Services ¿ Southern California', DROP],
  ['ca', 'IFB No.133885 Fence and Gate Repair - Multiple Locations, Multiple Locations', KEEP],
  ['ca', 'IFB Scheduled and On-call Trash Collection, Hauling, and Disposal Services, Los Angeles County', DROP],
  ['ca', 'IFB 02A2547 - Multi-provider On-Call, and As-Needed Title and Escrow Services in Tehama County', DROP],
  ['ca', 'Modify existing drainage, replace lighting systems, and install TMS.', KEEP],
  ['ca', 'IFB #RW2611009 Bulk Wheat Flour', DROP],
  ['ca', 'IFB 26-E0016 Translation and Intrepretation Services', DROP],
  ['ca', '2CA08061 - Replacing Heating, Ventilation and Air Conditioning (HVAC) Units Services **Small Business Bidders ONLY**', KEEP],
  ['ca', 'CONTRACT NUMBER: 26-334792; AUGMENTATION OF ELECTRICAL SERVICE CAPACITY, DEPARTMENT OF STATE HOSPITALS, NAPA STATE HOSPITAL, NAPA, NAPA COUNTY, CALIFORNIA, PROJECT NUMBER: 14109', KEEP],
  ['ca', 'Construct maintenance station.', KEEP],
  ['ca', 'Landscape planting.', KEEP],
];

const asInput = (x: TradeWorkInput | string): TradeWorkInput => (typeof x === 'string' ? { title: x } : x);

describe('isTradeWork on real listings from the new boards (2026-11-14)', () => {
  it(`has at least 60 real titles (${CASES.length})`, () => {
    expect(CASES.length).toBeGreaterThanOrEqual(60);
    expect(CASES.filter(([, , k]) => k).length).toBeGreaterThan(30);
    expect(CASES.filter(([, , k]) => !k).length).toBeGreaterThan(30);
  });

  it.each(CASES.map(([board, input, keep]) => [board, asInput(input).title, keep, input] as const))(
    '%s: %s → keep %s', (_board, _title, keep, input) => {
      const answer = isTradeWork(asInput(input));
      expect(answer.keep, answer.why).toBe(keep);
      expect(answer.why).toMatch(/\S/);
    },
  );
});

describe('isTradeWork: the order of the rules', () => {
  it('a trade word in the title beats a non-trade word ("Electrical … Services" stays)', () => {
    expect(isTradeWork({ title: 'Generator Maintenance Services' })).toEqual({ keep: true, why: 'trade word: generator' });
  });

  it('a non-trade word beats a construction word in the title', () => {
    expect(isTradeWork({ title: 'Janitorial Services for the Maintenance Building' })).toEqual({ keep: false, why: 'not trade work: janitorial' });
  });

  it("the board's construction category wins over everything", () => {
    expect(isTradeWork({ title: 'Software for the Courthouse', category: 'Construction' })).toEqual({ keep: true, why: 'board category: Construction' });
  });

  it('a construction NIGP class keeps; codes only drop when every code is non-trade and the words are silent', () => {
    expect(isTradeWork({ title: 'Annual contract', codes: { nigp: ['91400'] } }).keep).toBe(true);
    expect(isTradeWork({ title: 'Annual contract', codes: { nigp: ['91832', '92045'] } })).toEqual({ keep: false, why: 'commodity codes: 918, 920' });
    expect(isTradeWork({ title: 'Annual contract', codes: { nigp: ['91832', '93639'] } }).keep).toBe(true); // one unknown class: unclear
    expect(isTradeWork({ title: 'Lighting retrofit', codes: { nigp: ['92045'] } }).keep).toBe(true); // the words come first
  });

  it('UNSPSC: segment 72 keeps, a non-trade segment drops a silent title', () => {
    expect(isTradeWork({ title: 'Annual contract', codes: { unspsc: ['72101500'] } }).keep).toBe(true);
    expect(isTradeWork({ title: 'Annual contract', codes: { unspsc: ['43231500'] } }).keep).toBe(false);
  });

  it('a trade word in the description keeps a title that says nothing', () => {
    expect(isTradeWork({ title: 'Project 26-0041', description: 'Replace the switchgear at the pump plant' }).keep).toBe(true);
  });

  it('anything unclear is kept', () => {
    expect(isTradeWork({ title: 'RFQ 26-0041' })).toEqual({ keep: true, why: 'unclear: kept' });
    expect(isTradeWork({ title: '' })).toEqual({ keep: true, why: 'unclear: kept' });
  });

  it('keepTradeWork filters and counts', () => {
    const rows = [{ t: 'Roof Replacement' }, { t: 'Fresh Produce Bid' }, { t: 'RFQ 1' }];
    expect(keepTradeWork(rows, (r) => ({ title: r.t }))).toEqual({ kept: [{ t: 'Roof Replacement' }, { t: 'RFQ 1' }], left: 1 });
  });
});

describe('isTradeWork: real titles the first live runs kept as "unclear" (2026-11-14 review)', () => {
  it.each([
    ['Vegetables Frozen, Assorted'], // BidBuy
    ['Colt Rifles & Accessories'], // Cal eProcure
    ['RFP 2026-07 Salesforce, Data 360, and MuleSoft Services'], // OpenGov
    ['Live Catfish'], // Cal eProcure
    ['Psychiatry Services'], // OpenGov
    ['Breastfeeding Support'], // OpenGov
  ])('drops %s', (title) => {
    expect(isTradeWork({ title }).keep).toBe(false);
  });

  it('A&E (design) services are dropped even when they name the trade (OpenGov, West Sacramento)', () => {
    expect(isTradeWork({ title: 'Architectural and Engineering (A&E) Services for a Recreation Center Lighting Upgrade' }).keep).toBe(false);
  });

  it('a timber sale is dropped even though its title names a road (MFMP)', () => {
    expect(isTradeWork({ title: 'Sandhill Road 26/27 Timber Sale' })).toEqual({ keep: false, why: 'not contractor work: timber sale' });
  });

  it('elevator and conveyance maintenance is kept under SF\'s "Personal Services" category', () => {
    expect(isTradeWork({ title: 'As-Needed Airport Conveyance Maintenance', category: 'Personal Services' }))
      .toEqual({ keep: true, why: 'construction word: conveyance' });
    expect(isTradeWork({ title: 'Florida State Hospital Elevator Maintenance and Repair' }).keep).toBe(true);
  });
});
