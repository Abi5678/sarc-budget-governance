/**
 * SARC Budget Governance — Budget Enforcer.
 *
 * Runtime budget checking at execution hooks, modeled after SARC v0.1's
 * four enforcement sites (PreActionGate, ActionMonitor, PostActionAuditor,
 * EscalationRouter).
 *
 * The BudgetEnforcer integrates with SARC's governance architecture by
 * injecting budget constraints as compliance checks at structurally
 * guaranteed enforcement points.
 */

import {
  AgentContract,
  ContractContext,
  ContractState,
  ResourceBudget,
  ResourceUsage,
  isBudgetExceeded,
  subtractBudget,
} from "../contracts/types.js";
import { lifecycle } from "../contracts/lifecycle.js";
import { ContractStore } from "../contracts/conservation.js";

// ---------------------------------------------------------------------------
// Enforcement Decision
// ---------------------------------------------------------------------------

export enum BudgetDecision {
  ALLOW = "allow",
  BLOCK = "block",
  THROTTLE = "throttle",
  ESCALATE = "escalate",
}

export interface BudgetEnforcementResult {
  decision: BudgetDecision;
  reason: string;
  remainingBudget: ResourceBudget;
  contractId: string;
  /** If throttled, the adjusted action parameters */
  throttledParams?: Record<string, unknown>;
  /** Usage that would result if action proceeds */
  projectedUsage?: ResourceUsage;
}

// ---------------------------------------------------------------------------
// Budget Enforcer
// ---------------------------------------------------------------------------

/**
 * Runtime budget enforcement integrated with SARC's enforcement sites.
 *
 * Usage:
 *   const enforcer = new BudgetEnforcer(store);
 *   const result = enforcer.preActionCheck(contractId, proposedUsage);
 *   if (result.decision === BudgetDecision.ALLOW) { ... proceed ... }
 */
export class BudgetEnforcer {
  constructor(private store: ContractStore) {}

  /**
   * Pre-action gate: check if a proposed action fits within the budget.
   *
   * This is the primary safety gate, analogous to SARC's PreActionGate.
   * - If the action would exceed budget → BLOCK
   * - If the action would consume >50% of remaining budget → THROTTLE
   * - Otherwise → ALLOW
   */
  preActionCheck(
    contractId: string,
    proposedUsage: ResourceUsage,
    context?: Partial<ContractContext>
  ): BudgetEnforcementResult {
    const contract = this.store.get(contractId);
    if (!contract) {
      return {
        decision: BudgetDecision.BLOCK,
        reason: `Contract ${contractId} not found`,
        remainingBudget: { tokens: 0, wallClockMs: 0, apiCalls: 0, memoryBytes: 0 },
        contractId,
      };
    }

    // Contract must be active
    if (contract.state !== ContractState.ACTIVATED) {
      return {
        decision: BudgetDecision.BLOCK,
        reason: `Contract is in ${contract.state} state (not active)`,
        remainingBudget: contract.remainingBudget,
        contractId,
      };
    }

    // Calculate projected remaining
    const projected = subtractBudget(contract.remainingBudget, proposedUsage);

    // Hard constraint: budget exceeded → BLOCK
    if (isBudgetExceeded(projected)) {
      const exceededDim = this.findExceededDimension(contract.remainingBudget, proposedUsage);
      return {
        decision: BudgetDecision.BLOCK,
        reason: `Budget would be exceeded: ${exceededDim}`,
        remainingBudget: contract.remainingBudget,
        contractId,
        projectedUsage: proposedUsage,
      };
    }

    // Soft constraint: consuming >50% of remaining → THROTTLE
    const throttleThreshold = 0.5;
    const throttleDimension = this.findThrottleDimension(
      contract.remainingBudget,
      proposedUsage,
      throttleThreshold
    );

    if (throttleDimension) {
      const throttled = this.throttleUsage(
        contract.remainingBudget,
        proposedUsage,
        throttleDimension,
        throttleThreshold
      );
      return {
        decision: BudgetDecision.THROTTLE,
        reason: `Action would consume >${throttleThreshold * 100}% of remaining ${throttleDimension}`,
        remainingBudget: contract.remainingBudget,
        contractId,
        throttledParams: throttled,
        projectedUsage: proposedUsage,
      };
    }

    return {
      decision: BudgetDecision.ALLOW,
      reason: "Within budget",
      remainingBudget: contract.remainingBudget,
      contractId,
      projectedUsage: proposedUsage,
    };
  }

  /**
   * Action-time monitoring: record actual usage and check for drift.
   *
   * This is analogous to SARC's ActionMonitor. It updates the contract's
   * usage tracking and checks for cumulative budget drift.
   */
  recordUsage(contractId: string, usage: ResourceUsage): BudgetEnforcementResult {
    const contract = this.store.get(contractId);
    if (!contract) {
      return {
        decision: BudgetDecision.BLOCK,
        reason: `Contract ${contractId} not found`,
        remainingBudget: { tokens: 0, wallClockMs: 0, apiCalls: 0, memoryBytes: 0 },
        contractId,
      };
    }

    const updated = lifecycle.recordUsage(contract, usage);
    this.store.put(updated);

    if (updated.state === ContractState.VIOLATED) {
      return {
        decision: BudgetDecision.BLOCK,
        reason: "Budget exceeded — contract violated",
        remainingBudget: updated.remainingBudget,
        contractId,
        projectedUsage: usage,
      };
    }

    // Check if budget is getting low (<20% remaining on any dimension)
    const lowBudgetDim = this.findLowBudgetDimension(updated.remainingBudget, updated.budget, 0.2);
    if (lowBudgetDim) {
      return {
        decision: BudgetDecision.THROTTLE,
        reason: `Low budget warning: ${lowBudgetDim} below 20% of total`,
        remainingBudget: updated.remainingBudget,
        contractId,
        projectedUsage: usage,
      };
    }

    return {
      decision: BudgetDecision.ALLOW,
      reason: "Usage recorded",
      remainingBudget: updated.remainingBudget,
      contractId,
      projectedUsage: usage,
    };
  }

  /**
   * Post-action audit: verify that actual usage matches expected usage.
   *
   * This is analogous to SARC's PostActionAuditor. It detects cases
   * where an action consumed more resources than expected.
   */
  postActionAudit(
    contractId: string,
    expectedUsage: ResourceUsage,
    actualUsage: ResourceUsage
  ): BudgetEnforcementResult {
    const contract = this.store.get(contractId);
    if (!contract) {
      return {
        decision: BudgetDecision.BLOCK,
        reason: `Contract ${contractId} not found`,
        remainingBudget: { tokens: 0, wallClockMs: 0, apiCalls: 0, memoryBytes: 0 },
        contractId,
      };
    }

    // Check for usage overrun (actual > expected by >25%)
    const overrunDim = this.findOverrunDimension(expectedUsage, actualUsage, 1.25);
    if (overrunDim) {
      return {
        decision: BudgetDecision.ESCALATE,
        reason: `Usage overrun on ${overrunDim}: actual exceeded expected by >25%`,
        remainingBudget: contract.remainingBudget,
        contractId,
        projectedUsage: actualUsage,
      };
    }

    return {
      decision: BudgetDecision.ALLOW,
      reason: "Usage within expected bounds",
      remainingBudget: contract.remainingBudget,
      contractId,
      projectedUsage: actualUsage,
    };
  }

  /**
   * Check if a contract's time budget has expired.
   */
  checkTimeExpiry(contractId: string): BudgetEnforcementResult {
    const contract = this.store.get(contractId);
    if (!contract) {
      return {
        decision: BudgetDecision.BLOCK,
        reason: `Contract ${contractId} not found`,
        remainingBudget: { tokens: 0, wallClockMs: 0, apiCalls: 0, memoryBytes: 0 },
        contractId,
      };
    }

    if (contract.state !== ContractState.ACTIVATED) {
      return {
        decision: BudgetDecision.ALLOW,
        reason: `Contract in ${contract.state} state (not active)`,
        remainingBudget: contract.remainingBudget,
        contractId,
      };
    }

    const updated = lifecycle.checkExpiry(contract);
    if (updated.state !== contract.state) {
      this.store.put(updated);
      return {
        decision: BudgetDecision.BLOCK,
        reason: "Contract expired (time boundary reached)",
        remainingBudget: updated.remainingBudget,
        contractId,
      };
    }

    return {
      decision: BudgetDecision.ALLOW,
      reason: "Time budget OK",
      remainingBudget: contract.remainingBudget,
      contractId,
    };
  }

  // --- Private helpers ---

  private findExceededDimension(
    remaining: ResourceBudget,
    proposed: ResourceUsage
  ): string {
    if ((proposed.tokens ?? 0) > remaining.tokens) return "tokens";
    if ((proposed.wallClockMs ?? 0) > remaining.wallClockMs) return "wallClockMs";
    if ((proposed.apiCalls ?? 0) > remaining.apiCalls) return "apiCalls";
    if ((proposed.memoryBytes ?? 0) > remaining.memoryBytes) return "memoryBytes";
    return "unknown";
  }

  private findThrottleDimension(
    remaining: ResourceBudget,
    proposed: ResourceUsage,
    threshold: number
  ): string | null {
    if (
      remaining.tokens > 0 &&
      (proposed.tokens ?? 0) / remaining.tokens > threshold
    )
      return "tokens";
    if (
      remaining.wallClockMs > 0 &&
      (proposed.wallClockMs ?? 0) / remaining.wallClockMs > threshold
    )
      return "wallClockMs";
    if (
      remaining.apiCalls > 0 &&
      (proposed.apiCalls ?? 0) / remaining.apiCalls > threshold
    )
      return "apiCalls";
    if (
      remaining.memoryBytes > 0 &&
      (proposed.memoryBytes ?? 0) / remaining.memoryBytes > threshold
    )
      return "memoryBytes";
    return null;
  }

  private throttleUsage(
    remaining: ResourceBudget,
    proposed: ResourceUsage,
    dimension: string,
    threshold: number
  ): Record<string, unknown> {
    // Cap the proposed usage at the threshold percentage of remaining
    const capped = { ...proposed };
    const dimKey = dimension as keyof ResourceUsage;
    const remainingKey = dimension as keyof ResourceBudget;
    const maxAllowed = Math.floor(remaining[remainingKey] * threshold);
    if ((capped[dimKey] ?? 0) > maxAllowed) {
      (capped as any)[dimKey] = maxAllowed;
    }
    return capped as unknown as Record<string, unknown>;
  }

  private findLowBudgetDimension(
    remaining: ResourceBudget,
    total: ResourceBudget,
    threshold: number
  ): string | null {
    if (total.tokens > 0 && remaining.tokens / total.tokens < threshold)
      return "tokens";
    if (total.wallClockMs > 0 && remaining.wallClockMs / total.wallClockMs < threshold)
      return "wallClockMs";
    if (total.apiCalls > 0 && remaining.apiCalls / total.apiCalls < threshold)
      return "apiCalls";
    if (total.memoryBytes > 0 && remaining.memoryBytes / total.memoryBytes < threshold)
      return "memoryBytes";
    return null;
  }

  private findOverrunDimension(
    expected: ResourceUsage,
    actual: ResourceUsage,
    ratio: number
  ): string | null {
    for (const dim of ["tokens", "wallClockMs", "apiCalls", "memoryBytes"] as const) {
      const exp = expected[dim] ?? 0;
      const act = actual[dim] ?? 0;
      if (exp > 0 && act / exp > ratio) return dim;
    }
    return null;
  }
}
