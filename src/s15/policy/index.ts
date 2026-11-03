/** Protected S15 authority API. Import this entry from trusted host composition only; S14 remains the default runtime. */
export type * from './types';
export { openPolicyService } from './service';
export { PolicyError } from './validation';
export { createRecurringRules } from './recurring';
export type { RecurringFrequency, RecurringRuleOptions, RecurringRuleProposal, RecurringRules } from './recurring';
