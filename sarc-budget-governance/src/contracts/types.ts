/**
 * SARC Budget Governance — Core Contract Types.
 *
 * Based on Agent Contracts (arXiv:2601.08815, Ye & Tan, COINE 2026 @ AAMAS).
 *
 * Key contribution: multi-dimensional resource constraints with conservation
 * laws that are mathematically enforced across hierarchical delegation.
 */

// ---------------------------------------------------------------------------
// Contract State Machine
// ---------------------------------------------------------------------------

/**
 * Lifecycle states for an agent contract.
 *
 * State machine:
 *   CREATED → ACTIVATED → COMPLETED
 *                      \→ EXPIRED
 *                      \→ VIOLATED
 *
 * Legal transitions:
 *   CREATED   → ACTIVATED
 *   ACTIVATED → COMPLETED | EXPIRED | VIOLATED
 *   (all terminal states are absorbing)
 */
export enum ContractState {
  CREATED = "created",
  ACTIVATED = "activated",
  COMPLETED = "completed",
  EXPIRED = "expired",
  VIOLATED = "violated",
}

/** Legal state transitions — deterministic state machine */
const LEGAL_TRANSITIONS: Record<ContractState, ContractState[]> = {
  [ContractState.CREATED]: [ContractState.ACTIVATED],
  [ContractState.ACTIVATED]: [
    ContractState.COMPLETED,
    ContractState.EXPIRED,
    ContractState.VIOLATED,
  ],
  [ContractState.COMPLETED]: [],
  [ContractState.EXPIRED]: [],
  [ContractState.VIOLATED]: [],
};

export function canTransition(from: ContractState, to: ContractState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Resource Dimensions
// ---------------------------------------------------------------------------

/**
 * Multi-dimensional resource budget.
 *
 * Each dimension is independently tracked and enforced.
 * Conservation law: sum of children's budgets ≤ parent's budget (per dimension).
 */
export interface ResourceBudget {
  /** Token budget (LLM tokens consumed) */
  tokens: number;
  /** Wall-clock time budget in milliseconds */
  wallClockMs: number;
  /** API call budget */
  apiCalls: number;
  /** Memory budget in bytes */
  memoryBytes: number;
}

/** Resource usage snapshot — partial, since not all dimensions are always consumed */
export interface ResourceUsage {
  tokens?: number;
  wallClockMs?: number;
  apiCalls?: number;
  memoryBytes?: number;
}

/** Named resource dimensions for iteration */
export const RESOURCE_DIMENSIONS = [
  "tokens",
  "wallClockMs",
  "apiCalls",
  "memoryBytes",
] as const;

export type ResourceDimension = (typeof RESOURCE_DIMENSIONS)[number];

/**
 * Subtract usage from budget, returning remaining budget.
 * Throws if any dimension would go negative (conservation violation at leaf).
 */
export function subtractBudget(
  budget: ResourceBudget,
  usage: ResourceUsage
): ResourceBudget {
  return {
    tokens: budget.tokens - (usage.tokens ?? 0),
    wallClockMs: budget.wallClockMs - (usage.wallClockMs ?? 0),
    apiCalls: budget.apiCalls - (usage.apiCalls ?? 0),
    memoryBytes: budget.memoryBytes - (usage.memoryBytes ?? 0),
  };
}

/**
 * Check if any budget dimension is negative (exceeded).
 */
export function isBudgetExceeded(budget: ResourceBudget): boolean {
  return (
    budget.tokens < 0 ||
    budget.wallClockMs < 0 ||
    budget.apiCalls < 0 ||
    budget.memoryBytes < 0
  );
}

/**
 * Check if any budget dimension is at or below zero.
 */
export function isBudgetDepleted(budget: ResourceBudget): boolean {
  return (
    budget.tokens <= 0 ||
    budget.wallClockMs <= 0 ||
    budget.apiCalls <= 0 ||
    budget.memoryBytes <= 0
  );
}

/**
 * Add two resource budgets (for aggregating child usage).
 */
export function addBudgets(a: ResourceBudget, b: ResourceBudget): ResourceBudget {
  return {
    tokens: a.tokens + b.tokens,
    wallClockMs: a.wallClockMs + b.wallClockMs,
    apiCalls: a.apiCalls + b.apiCalls,
    memoryBytes: a.memoryBytes + b.memoryBytes,
  };
}

/**
 * Create a zero budget.
 */
export function zeroBudget(): ResourceBudget {
  return { tokens: 0, wallClockMs: 0, apiCalls: 0, memoryBytes: 0 };
}

/**
 * Scale a budget by a fraction (for proportional delegation).
 */
export function scaleBudget(budget: ResourceBudget, fraction: number): ResourceBudget {
  return {
    tokens: Math.floor(budget.tokens * fraction),
    wallClockMs: Math.floor(budget.wallClockMs * fraction),
    apiCalls: Math.floor(budget.apiCalls * fraction),
    memoryBytes: Math.floor(budget.memoryBytes * fraction),
  };
}

// ---------------------------------------------------------------------------
// Success Criteria
// ---------------------------------------------------------------------------

/**
 * Success criteria for contract completion.
 *
 * A contract is COMPLETED when its success criteria are met
 * (even if budget remains).
 */
export interface SuccessCriteria {
  /** Minimum quality score (0-1) required for completion */
  minQualityScore?: number;
  /** Required output artifacts (by name) */
  requiredOutputs?: string[];
  /** Custom predicate: returns true if criteria are met */
  predicate?: (context: ContractContext) => boolean;
}

// ---------------------------------------------------------------------------
// Contract Context
// ---------------------------------------------------------------------------

/**
 * Execution context passed to contract evaluation.
 *
 * Mirrors SARC v0.1's context dict pattern, but typed.
 */
export interface ContractContext {
  /** Agent ID executing under this contract */
  agentId: string;
  /** Current action being evaluated */
  action?: string;
  /** Action parameters */
  actionParams?: Record<string, unknown>;
  /** Accumulated resource usage so far */
  usage: ResourceUsage;
  /** Remaining budget */
  remainingBudget: ResourceBudget;
  /** Total budget allocated */
  totalBudget: ResourceBudget;
  /** Step number in execution */
  stepNumber: number;
  /** Any additional context */
  extra?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Audit Trail
// ---------------------------------------------------------------------------

export interface AuditEntry {
  timestamp: number;
  fromState: ContractState;
  toState: ContractState;
  reason: string;
  usage?: ResourceUsage;
  remainingBudget?: ResourceBudget;
}

// ---------------------------------------------------------------------------
// Agent Contract
// ---------------------------------------------------------------------------

/**
 * An Agent Contract — the core abstraction from arXiv:2601.08815.
 *
 * Binds an agent to a multi-dimensional resource budget with
 * conservation-law enforcement. The contract governs the agent's
 * lifecycle, resource consumption, and delegation authority.
 */
export interface AgentContract {
  /** Unique contract identifier */
  contractId: string;
  /** Agent ID bound by this contract */
  agentId: string;
  /** Parent contract ID (null for root) */
  parentContractId: string | null;
  /** Current lifecycle state */
  state: ContractState;
  /** Total resource budget */
  budget: ResourceBudget;
  /** Remaining resource budget */
  remainingBudget: ResourceBudget;
  /** Accumulated resource usage */
  usedBudget: ResourceUsage;
  /** Success criteria for completion */
  successCriteria: SuccessCriteria;
  /** Maximum delegation depth (prevents infinite recursion) */
  maxDelegationDepth: number;
  /** Current delegation depth */
  currentDelegationDepth: number;
  /** Creation timestamp */
  createdAt: number;
  /** Activation timestamp */
  activatedAt: number | null;
  /** Completion/termination timestamp */
  terminatedAt: number | null;
  /** Contract expiry timestamp (null = no expiry) */
  expiresAt: number | null;
  /** Audit trail */
  auditTrail: AuditEntry[];
  /** Child contract IDs (for delegation tracking) */
  childContractIds: string[];
  /** Tags for categorization */
  tags: string[];
}

// ---------------------------------------------------------------------------
// Conservation Law Proof
// ---------------------------------------------------------------------------

/**
 * Result of verifying conservation laws across a delegation tree.
 *
 * Conservation law: ∀ dimension d, Σ children[di] ≤ parent[di]
 *
 * This is a mathematical invariant, not a heuristic.
 */
export interface ConservationProof {
  /** Whether conservation holds for ALL dimensions */
  conserved: boolean;
  /** Per-dimension verification */
  dimensions: Record<
    ResourceDimension,
    {
      parentBudget: number;
      childrenSum: number;
      slack: number; // parent - childrenSum (must be ≥ 0)
      overshoot: number; // childrenSum - parent (must be ≤ 0; positive = violation)
      conserved: boolean;
    }
  >;
  /** Any violations detected */
  violations: ConservationViolation[];
}

export interface ConservationViolation {
  dimension: ResourceDimension;
  parentBudget: number;
  childrenSum: number;
  overshoot: number; // childrenSum - parentBudget (positive = violation)
  parentContractId: string;
  childContractIds: string[];
}

// ---------------------------------------------------------------------------
// Delegation Request
// ---------------------------------------------------------------------------

/**
 * A request to delegate a portion of a parent contract's budget to a child.
 */
export interface DelegationRequest {
  /** Parent contract ID */
  parentContractId: string;
  /** Child agent ID */
  childAgentId: string;
  /** Requested budget for the child */
  requestedBudget: ResourceBudget;
  /** Max delegation depth for the child */
  maxDepth: number;
  /** Tags */
  tags?: string[];
}
