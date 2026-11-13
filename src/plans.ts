import type { Account, Plan } from './types.js';

/** What a plan unlocks. Routes check these flags, never the plan name. */
export interface Features {
  /** Web push the moment a good bid is seen (free: in-app inbox + daily digest). */
  instantPush: boolean;
  /** Recent awards and price stats (free: the count only, locked). */
  awardHistory: boolean;
  /** Save your own labor rate, burden, overhead and profit for the estimator. */
  costSettings: boolean;
  /** Award / result notices on bids you saved or bid on. */
  awardWatch: boolean;
  /** Material-price and wage movement alerts. */
  priceAlerts: boolean;
  /** The cost engine (POST /api/estimate, GET /api/estimates): premium only. Free plans get 402 and no numbers. */
  estimator: boolean;
}

const FREE: Features = {
  instantPush: false, awardHistory: false, costSettings: false, awardWatch: false, priceAlerts: false, estimator: false,
};
const PRO: Features = {
  instantPush: true, awardHistory: true, costSettings: true, awardWatch: true, priceAlerts: true, estimator: true,
};

export function featuresFor(plan: Plan): Features {
  return { ...(plan === 'free' ? FREE : PRO) };
}

/**
 * The plan a request runs under. The pilot (single mode) and DEMO_MODE get everything with no
 * billing; otherwise it is whatever the account has, and nobody signed in is 'free'.
 */
export function effectivePlan(config: { authMode: 'single' | 'accounts'; demoMode: boolean }, account: Account | null): Plan {
  if (config.authMode === 'single' || config.demoMode) return 'pilot';
  return account?.plan ?? 'free';
}
