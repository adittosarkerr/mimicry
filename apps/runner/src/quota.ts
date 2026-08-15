import { createQuota } from '@mimic/core';
import { config } from './config.js';
import { store } from './store.js';

/**
 * The free plan's daily allowance, bound to this runner's store.
 *
 * The counting and the plans live in `@mimic/core`, so the deployed site
 * reports the same numbers the runner enforces. Whether the cap actually
 * refuses a run is this side's decision, from `MIMIC_ENFORCE_QUOTA`.
 */

const quota = createQuota(store, { enforce: config.enforceQuota });

export const planFor = quota.planFor;
export const quotaFor = quota.quotaFor;
export const recordRun = quota.recordRun;
export const checkQuota = quota.checkQuota;

export { PLANS, today, type PlanName, type QuotaState, type QuotaVerdict } from '@mimic/core';
