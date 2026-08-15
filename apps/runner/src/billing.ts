import { createBilling } from '@mimic/core';
import { store } from './store.js';

/**
 * The payment sandbox, bound to whichever store this runner is using.
 *
 * The rules themselves live in `@mimic/core` so the deployed site can apply the
 * identical ones without a runner to ask. This file exists only to hand them a
 * store and keep the names the routes already import.
 */

const billing = createBilling(store);

export const addPaymentMethod = billing.addPaymentMethod;
export const listPaymentMethods = billing.listPaymentMethods;
export const removePaymentMethod = billing.removePaymentMethod;
export const setDefaultMethod = billing.setDefaultMethod;
export const charge = billing.charge;
export const listInvoices = billing.listInvoices;
export const subscribe = billing.subscribe;
export const cancelSubscription = billing.cancelSubscription;
export const listSubscriptions = billing.listSubscriptions;

export {
  GATEWAYS,
  SANDBOX_NOTICE,
  formatMinor,
  gatewayFor,
  issueOtp,
  verifyOtp,
  type AddMethodInput,
  type ChargeInput,
  type Gateway,
  type IssuedChallenge,
  type SubscribeResult,
} from '@mimic/core';
