/**
 * SARC Budget Governance — Contracts barrel export.
 */

export {
  ContractState,
  ResourceBudget,
  ResourceUsage,
  ResourceDimension,
  RESOURCE_DIMENSIONS,
  SuccessCriteria,
  ContractContext,
  AuditEntry,
  AgentContract,
  ConservationProof,
  ConservationViolation,
  DelegationRequest,
  canTransition,
  subtractBudget,
  isBudgetExceeded,
  isBudgetDepleted,
  addBudgets,
  zeroBudget,
  scaleBudget,
} from "./types.js";

export {
  createContract,
  createRootContract,
  createChildContract,
  generateContractId,
  resetContractCounter,
} from "./factory.js";

export {
  LifecycleManager,
  lifecycle,
  InvalidTransitionError,
  ContractExpiredError,
  ContractViolatedError,
  BudgetExceededError,
} from "./lifecycle.js";

export { ContractStore } from "./conservation.js";
