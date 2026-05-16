/**
 * SARC Budget Governance — Main Entry Point.
 *
 * Re-exports all public APIs from the budget governance module.
 */

// Core contract types
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
} from "./contracts/types.js";

// Contract factory
export {
  createContract,
  createRootContract,
  createChildContract,
  generateContractId,
  resetContractCounter,
} from "./contracts/factory.js";

// Lifecycle management
export {
  LifecycleManager,
  lifecycle,
  InvalidTransitionError,
  ContractExpiredError,
  ContractViolatedError,
  BudgetExceededError,
} from "./contracts/lifecycle.js";

// Conservation law enforcement
export { ContractStore } from "./contracts/conservation.js";

// Budget enforcement
export {
  BudgetEnforcer,
  BudgetDecision,
  BudgetEnforcementResult,
} from "./governance/budget-enforcer.js";

// Delegation management
export {
  DelegationManager,
  DelegationStrategy,
  DelegationPlan,
  DelegationResult,
} from "./governance/delegation.js";

// Constraint drift detection
export {
  ConstraintDriftMonitor,
  DriftMeasurement,
  DriftAnalysis,
  DriftCorrection,
  DriftThresholds,
} from "./governance/constraint-drift.js";

// SARC v0.1 integration
export {
  SarcBudgetBridge,
  SarcPredicate,
  SarcContext,
  SarcPredicateResult,
  SarcConstraintSpec,
  SarcEnforcementResult,
} from "./integration/sarc-bridge.js";

// AdaptOrch integration
export {
  AdaptOrchBudgetAdapter,
  TopologyKind,
  BudgetTopologyRule,
  BudgetRoutingDecision,
} from "./integration/adaptorch-adapter.js";
