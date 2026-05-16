/**
 * SARC Budget Governance — Contract Lifecycle State Machine.
 *
 * Formal state machine: CREATE → ACTIVATE → COMPLETE/EXPIRE/VIOLATE
 * All transitions are logged to the audit trail.
 * Terminal states are absorbing (no further transitions).
 */

import {
  AgentContract,
  AuditEntry,
  ContractContext,
  ContractState,
  ResourceUsage,
  SuccessCriteria,
  canTransition,
  isBudgetDepleted,
  isBudgetExceeded,
  subtractBudget,
} from "./types.js";

// ---------------------------------------------------------------------------
// Lifecycle Errors
// ---------------------------------------------------------------------------

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: ContractState,
    public readonly to: ContractState,
    public readonly contractId: string
  ) {
    super(
      `Invalid transition: ${from} → ${to} on contract ${contractId}`
    );
    this.name = "InvalidTransitionError";
  }
}

export class ContractExpiredError extends Error {
  constructor(public readonly contractId: string) {
    super(`Contract ${contractId} has expired`);
    this.name = "ContractExpiredError";
  }
}

export class ContractViolatedError extends Error {
  constructor(
    public readonly contractId: string,
    public readonly reason: string
  ) {
    super(`Contract ${contractId} violated: ${reason}`);
    this.name = "ContractViolatedError";
  }
}

export class BudgetExceededError extends Error {
  constructor(
    public readonly contractId: string,
    public readonly dimension: string,
    public readonly used: number,
    public readonly budget: number
  ) {
    super(
      `Budget exceeded on contract ${contractId}: ${dimension} used=${used} budget=${budget}`
    );
    this.name = "BudgetExceededError";
  }
}

// ---------------------------------------------------------------------------
// Lifecycle Manager
// ---------------------------------------------------------------------------

/**
 * Manages contract lifecycle transitions.
 *
 * This is a pure function-based approach: each method returns a new
 * contract object with the updated state. The caller is responsible
 * for persisting the change (e.g., in a ContractStore).
 */
export class LifecycleManager {
  /**
   * Activate a CREATED contract.
   *
   * @throws InvalidTransitionError if contract is not in CREATED state
   */
  activate(contract: AgentContract, now = Date.now()): AgentContract {
    this.assertTransition(contract, ContractState.ACTIVATED);

    // Check for expiry — if already expired at activation time,
    // transition directly to EXPIRED (skip ACTIVATED since it was never active)
    if (contract.expiresAt !== null && now >= contract.expiresAt) {
      const entry: AuditEntry = {
        timestamp: now,
        fromState: contract.state,
        toState: ContractState.EXPIRED,
        reason: "Contract expired before activation",
        remainingBudget: { ...contract.remainingBudget },
      };
      return {
        ...contract,
        state: ContractState.EXPIRED,
        terminatedAt: now,
        auditTrail: [...contract.auditTrail, entry],
      };
    }

    const entry: AuditEntry = {
      timestamp: now,
      fromState: contract.state,
      toState: ContractState.ACTIVATED,
      reason: "Contract activated",
      remainingBudget: { ...contract.remainingBudget },
    };

    return {
      ...contract,
      state: ContractState.ACTIVATED,
      activatedAt: now,
      auditTrail: [...contract.auditTrail, entry],
    };
  }

  /**
   * Complete an ACTIVATED contract.
   *
   * Optionally checks success criteria before completion.
   *
   * @throws InvalidTransitionError if contract is not in ACTIVATED state
   */
  complete(
    contract: AgentContract,
    context?: ContractContext,
    now = Date.now()
  ): AgentContract {
    this.assertTransition(contract, ContractState.COMPLETED);

    // Check success criteria if provided
    if (context && contract.successCriteria.predicate) {
      if (!contract.successCriteria.predicate(context)) {
        throw new Error(
          `Success criteria not met for contract ${contract.contractId}`
        );
      }
    }

    const entry: AuditEntry = {
      timestamp: now,
      fromState: contract.state,
      toState: ContractState.COMPLETED,
      reason: "Contract completed successfully",
      usage: { ...contract.usedBudget },
      remainingBudget: { ...contract.remainingBudget },
    };

    return {
      ...contract,
      state: ContractState.COMPLETED,
      terminatedAt: now,
      auditTrail: [...contract.auditTrail, entry],
    };
  }

  /**
   * Expire an ACTIVATED contract (time-based termination).
   *
   * @throws InvalidTransitionError if contract is not in ACTIVATED state
   */
  expire(contract: AgentContract, now = Date.now()): AgentContract {
    this.assertTransition(contract, ContractState.EXPIRED);

    const entry: AuditEntry = {
      timestamp: now,
      fromState: contract.state,
      toState: ContractState.EXPIRED,
      reason: "Contract expired (time boundary reached)",
      usage: { ...contract.usedBudget },
      remainingBudget: { ...contract.remainingBudget },
    };

    return {
      ...contract,
      state: ContractState.EXPIRED,
      terminatedAt: now,
      auditTrail: [...contract.auditTrail, entry],
    };
  }

  /**
   * Mark an ACTIVATED contract as VIOLATED.
   *
   * This occurs when a budget dimension is exceeded or a conservation
   * law is broken.
   *
   * @throws InvalidTransitionError if contract is not in ACTIVATED state
   */
  violate(
    contract: AgentContract,
    reason: string,
    now = Date.now()
  ): AgentContract {
    this.assertTransition(contract, ContractState.VIOLATED);

    const entry: AuditEntry = {
      timestamp: now,
      fromState: contract.state,
      toState: ContractState.VIOLATED,
      reason: `Contract violated: ${reason}`,
      usage: { ...contract.usedBudget },
      remainingBudget: { ...contract.remainingBudget },
    };

    return {
      ...contract,
      state: ContractState.VIOLATED,
      terminatedAt: now,
      auditTrail: [...contract.auditTrail, entry],
    };
  }

  /**
   * Record resource usage against an active contract.
   *
   * Returns the updated contract with adjusted remaining budget.
   * If any dimension is exceeded, the contract transitions to VIOLATED.
   *
   * @throws Error if contract is not in ACTIVATED state
   */
  recordUsage(
    contract: AgentContract,
    usage: ResourceUsage,
    now = Date.now()
  ): AgentContract {
    if (contract.state !== ContractState.ACTIVATED) {
      throw new Error(
        `Cannot record usage on contract in ${contract.state} state`
      );
    }

    // Check expiry first
    if (contract.expiresAt !== null && now >= contract.expiresAt) {
      return this.expire(contract, now);
    }

    // Calculate new remaining budget
    const newRemaining = subtractBudget(contract.remainingBudget, usage);
    const newUsed: ResourceUsage = {
      tokens: (contract.usedBudget.tokens ?? 0) + (usage.tokens ?? 0),
      wallClockMs: (contract.usedBudget.wallClockMs ?? 0) + (usage.wallClockMs ?? 0),
      apiCalls: (contract.usedBudget.apiCalls ?? 0) + (usage.apiCalls ?? 0),
      memoryBytes: (contract.usedBudget.memoryBytes ?? 0) + (usage.memoryBytes ?? 0),
    };

    // If budget exceeded, transition to VIOLATED
    if (isBudgetExceeded(newRemaining)) {
      // Find which dimension was violated
      const dim = newRemaining.tokens < 0 ? "tokens"
        : newRemaining.wallClockMs < 0 ? "wallClockMs"
        : newRemaining.apiCalls < 0 ? "apiCalls"
        : "memoryBytes";

      const violatedContract = {
        ...contract,
        remainingBudget: newRemaining,
        usedBudget: newUsed,
      };

      return this.violate(
        violatedContract,
        `Budget exceeded: ${dim} (remaining: ${newRemaining[dim as keyof typeof newRemaining]})`,
        now
      );
    }

    const entry: AuditEntry = {
      timestamp: now,
      fromState: contract.state,
      toState: contract.state, // Same state, just recording usage
      reason: "Resource usage recorded",
      usage,
      remainingBudget: { ...newRemaining },
    };

    return {
      ...contract,
      remainingBudget: newRemaining,
      usedBudget: newUsed,
      auditTrail: [...contract.auditTrail, entry],
    };
  }

  /**
   * Check if a contract should expire based on time.
   */
  checkExpiry(contract: AgentContract, now = Date.now()): AgentContract {
    if (
      contract.state === ContractState.ACTIVATED &&
      contract.expiresAt !== null &&
      now >= contract.expiresAt
    ) {
      return this.expire(contract, now);
    }
    return contract;
  }

  /**
   * Check if a contract's budget is depleted (all dimensions at 0).
   * If depleted and still activated, complete it (budget fully used = success).
   */
  checkDepletion(contract: AgentContract, now = Date.now()): AgentContract {
    if (
      contract.state === ContractState.ACTIVATED &&
      isBudgetDepleted(contract.remainingBudget)
    ) {
      return this.complete(contract, undefined, now);
    }
    return contract;
  }

  // --- Private helpers ---

  private assertTransition(
    contract: AgentContract,
    targetState: ContractState
  ): void {
    if (!canTransition(contract.state, targetState)) {
      throw new InvalidTransitionError(
        contract.state,
        targetState,
        contract.contractId
      );
    }
  }
}

// Singleton for convenience
export const lifecycle = new LifecycleManager();
