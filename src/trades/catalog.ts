import type { Profile } from '../types.js';

/**
 * Trade templates: pick a trade at sign-up and get its keywords + NAICS codes, so nobody has to
 * write a config file. buildProfile() (src/profile/build.ts) merges the chosen trades into a Profile.
 */
export interface Trade {
  id: string; // lowercase slug, stored in Profile.trades
  label: string; // shown in the picker
  blurb: string; // one line under the label
  naics: { strong: string[]; related: string[] };
  keywords: Profile['keywords'];
}

/** STUB (foundation): one trade, the keyword and NAICS lists the pilot runs on (config/lm-electric.json). */
export const TRADES: Trade[] = [
  {
    id: 'electrical',
    label: 'Electrical',
    blurb: 'Power, lighting, fire alarm, low voltage, controls',
    naics: { strong: ['238210'], related: ['238220', '236220', '236210', '237130', '238990', '561621'] },
    keywords: {
      strong: [
        'electric*', 'lighting', 'light fixture*', 'led', 'led conversion', 'wiring', 'rewir*', 'switchgear',
        'switchboard*', 'panelboard*', 'electrical panel*', 'transformer*', 'generator*', 'standby power',
        'ev charg*', 'charging station*', 'fire alarm*', 'low voltage', 'plc', 'scada', 'motor control*', 'conduit',
        'service upgrade', 'power distribution', 'solar', 'photovoltaic', 'street light*', 'traffic signal*',
        'intercom*', 'sports lighting', 'field lighting', 'emergency power',
      ],
      related: [
        'hvac', 'controls', 'pump station*', 'lift station*', 'well repair', 'booster pump*', 'boiler*', 'chiller*',
        'elevator*', 'camera*', 'cctv', 'surveillance', 'access control', 'pa system', 'public address',
        'data cabling', 'cabling', 'fiber', 'metering', 'water heater*', 'fire protection', 'fire detection',
        'security system*', 'door operator*',
      ],
      general: [
        'upgrade*', 'renovation*', 'remodel*', 'improvement*', 'replacement', 'repair*', 'installation',
        'modernization', 'tenant improvement*', 'rehabilitation', 'retrofit*', 'construction',
      ],
      otherTrades: [
        'roofing', 'reroof*', 'roof replacement', 'paving', 'pavement', 'seal coat*', 'slurry seal', 'striping',
        'asphalt', 'concrete', 'flooring', 'carpet', 'painting', 'landscap*', 'fence', 'fencing', 'sewer',
        'water main', 'drainage', 'rip rap', 'trail', 'sidewalk*', 'ada site', 'spillway', 'pipeline', 'culvert',
      ],
      exclude: [
        'janitorial', 'custodial', 'food', 'meat', 'dairy', 'produce', 'bread', 'vending', 'consulting',
        'consultant*', 'legal', 'audit*', 'lobbying', 'grant writing', 'software', 'saas', 'insurance', 'actuarial',
        'marketing', 'printing', 'furniture', 'uniform*', 'jackets', 'fish food', 'mowing', 'weed control',
        'chemical*', 'vehicle*', 'truck', 'trailer*', 'plows', 'kiosk*', 'surplus', 'security officer*',
        'guard service*', 'courier', 'traffic control services', 'strategic plan', 'feasibility', 'study',
        'exhibit design', 'architectural services', 'engineering services', 'surveying', 'concession', 'workbooks',
        'learning material', 'technical assistance', 'elderly', 'medical', 'pharmacy', 'recruitment', 'preschool',
        'director', 'photo processing', 'scale calibration', 'wifi services', 'tip management', 'customer portal',
      ],
    },
  },
];

export function getTrade(id: string): Trade | null {
  return TRADES.find((t) => t.id === id) ?? null;
}
