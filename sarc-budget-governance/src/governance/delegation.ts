/**
 * SARC Budget Governance — Hierarchical Budget Delegation.
 *
 * Implements the delegation pattern from arXiv:2601.08815:
 * - Parent contracts delegate sub-budgets to child contracts
 * - Conservation laws are enforced at delegation time
 * - Delegation depth is bounded to prevent infinite recursion
 * - Circular delegation is detected and prevented
 */

import {
  AgentContract,
  DelegationRequest,
  ResourceBudget,
  scaleBudget,
} from "../contracts/types.js";
import { createChildContract, createContract } from "../contracts/factory.js";
import { lifecycle } from "../contracts/lifecycle.js";
import { ContractStore } from "../contracts/conservation.js";

// ---------------------------------------------------------------------------
// Delegation Strategy
// ---------------------------------------------------------------------------

/**
 * Strategy for how to split a parent's budget among children.
 */
export enum DelegationStrategy {
  /** Equal split: each child gets an equal share */
  EQUAL = "equal",
  /** Proportional split: allocate by weight */
  PROPORTIONAL = "proportional",
  /** Priority split: first child gets priority, remainder to others */
  PRIORITY = "priority",
  /** Conservative: reserve a fraction for the parent, delegate the rest */
  CONSERVATIVE = "conservative",
}

export interface DelegationPlan {
  parentContractId: string;
  strategy: DelegationStrategy;
  children: {
    agentId: string;
    budget: ResourceBudget;
    weight?: number;
  }[];
  /** Fraction of budget reserved for the parent (0-1) */
  parentReserve: number;
}

// ---------------------------------------------------------------------------
// Delegation Result
// ---------------------------------------------------------------------------

export interface DelegationResult {
  success: boolean;
  parentContractId: string;
  childContracts: AgentContract[];
  reason?: string;
  /** Conservation proof for the delegation */
  conservationHeld: boolean;
}

// ---------------------------------------------------------------------------
// Delegation Manager
// ---------------------------------------------------------------------------

/**
 * Manages hierarchical budget delegation with conservation law enforcement.
 */
export class DelegationManager {
  constructor(private store: ContractStore) {}

  /**
   * Delegate from a parent contract to create child contracts.
   *
   * Steps:
   * 1. Verify parent is active
   * 2. Calculate child budgets based on strategy
   * 3. Pre-check conservation laws
   * 4. Create and activate child contracts
   * 5. Update parent's remaining budget
   * 6. Register all contracts
   *
   * @throws Error if delegation would violate conservation
   */
  delegate(plan: DelegationPlan): DelegationResult {
    const parent = this.store.get(plan.parentContractId);
    if (!parent) {
      return {
        success: false,
        parentContractId: plan.parentContractId,
        childContracts: [],
        reason: `Parent contract ${plan.parentContractId} not found`,
        conservationHeld: false,
      };
    }

    if (parent.state !== "activated") {
      return {
        success: false,
        parentContractId: plan.parentContractId,
        childContracts: [],
        reason: `Parent contract is in ${parent.state} state (must be activated)`,
        conservationHeld: false,
      };
    }

    // Calculate child budgets
    const childBudgets = this.calculateBudgets(parent, plan);

    // Pre-check conservation
    const totalChildBudget = childBudgets.reduce(
      (sum, cb) => ({
        tokens: sum.tokens + cb.budget.tokens,
        wallClockMs: sum.wallClockMs + cb.budget.wallClockMs,
        apiCalls: sum.apiCalls + cb.budget.apiCalls,
        memoryBytes: sum.memoryBytes + cb.budget.memoryBytes,
      }),
      { tokens: 0, wallClockMs: 0, apiCalls: 0, memoryBytes: 0 }
    );

    // Verify against parent's REMAINING budget (not total)
    for (const dim of ["tokens", "wallClockMs", "apiCalls", "memoryBytes"] as const) {
      if (totalChildBudget[dim] > parent.remainingBudget[dim]) {
        return {
          success: false,
          parentContractId: plan.parentContractId,
          childContracts: [],
          reason: `Conservation violation: total child ${dim} (${totalChildBudget[dim]}) exceeds parent remaining (${parent.remainingBudget[dim]})`,
          conservationHeld: false,
        };
      }
    }

    // Create and activate child contracts
    const childContracts: AgentContract[] = [];
    for (const childPlan of childBudgets) {
      try {
        const child = createChildContract(
          parent,
          childPlan.agentId,
          childPlan.budget
        );
        const activated = lifecycle.activate(child);
        childContracts.push(activated);

        // Register child
        this.store.put(activated);
      } catch (err: any) {
        // Rollback any created children
        for (const created of childContracts) {
          this.store.delete(created.contractId);
        }
        return {
          success: false,
          parentContractId: plan.parentContractId,
          childContracts: [],
          reason: `Failed to create child contract: ${err.message}`,
          conservationHeld: false,
        };
      }
    }

    // Update parent: record delegated budget as used
    const delegationUsage = {
      tokens: totalChildBudget.tokens,
      wallClockMs: totalChildBudget.wallClockMs,
      apiCalls: totalChildBudget.apiCalls,
      memoryBytes: totalChildBudget.memoryBytes,
    };

    const updatedParent = lifecycle.recordUsage(parent, delegationUsage);
    updatedParent.childContractIds = childContracts.map((c) => c.contractId);
    this.store.put(updatedParent);

    // Verify conservation post-delegation
    const conservationProof = this.store.verifyConservation(plan.parentContractId);

    return {
      success: true,
      parentContractId: plan.parentContractId,
      childContracts,
      conservationHeld: conservationProof.conserved,
    };
  }

  /**
   * Delegate a single child from a parent with a specific budget.
   */
  delegateSingle(
    parentContractId: string,
    childAgentId: string,
    childBudget: ResourceBudget
  ): DelegationResult {
    return this.delegate({
      parentContractId,
      strategy: DelegationStrategy.PRIORITY,
      children: [{ agentId: childAgentId, budget: childBudget }],
      parentReserve: 0,
    });
  }

  /**
   * Auto-delegate: split parent budget equally among N children.
   */
  delegateEqual(
    parentContractId: string,
    childAgentIds: string[],
    parentReserve = 0.1
  ): DelegationResult {
    return this.delegate({
      parentContractId,
      strategy: DelegationStrategy.EQUAL,
      children: childAgentIds.map((id) => ({ agentId: id, budget: { tokens: 0, wallClockMs: 0, apiCalls: 0, memoryBytes: 0 } })),
      parentReserve,
    });
  }

  // --- Private helpers ---

  private calculateBudgets(
    parent: AgentContract,
    plan: DelegationPlan
  ): { agentId: string; budget: ResourceBudget }[] {
    // Reserve budget for parent
    const available = scaleBudget(parent.remainingBudget, 1 - plan.parentReserve);

    switch (plan.strategy) {
      case DelegationStrategy.EQUAL:
        return this.equalSplit(available, plan.children);

      case DelegationStrategy.PROPORTIONAL:
        return this.proportionalSplit(available, plan.children);

      case DelegationStrategy.PRIORITY:
        return this.prioritySplit(available, plan.children);

      case DelegationStrategy.CONSERVATIVE:
        // Conservative = equal split with 20% parent reserve
        return this.equalSplit(
          scaleBudget(parent.remainingBudget, 0.8),
          plan.children
        );

      default:
        return this.equalSplit(available, plan.children);
    }
  }

  private equalSplit(
    available: ResourceBudget,
    children: DelegationPlan["children"]
  ): { agentId: string; budget: ResourceBudget }[] {
    const n = children.length;
    if (n === 0) return [];
    const fraction = 1 / n;
    return children.map((child) => ({
      agentId: child.agentId,
      budget: scaleBudget(available, fraction),
    }));
  }

  private proportionalSplit(
    available: ResourceBudget,
    children: DelegationPlan["children"]
  ): { agentId: string; budget: ResourceBudget }[] {
    const totalWeight = children.reduce((sum, c) => sum + (c.weight ?? 1), 0);
    return children.map((child) => ({
      agentId: child.agentId,
      budget: scaleBudget(available, (child.weight ?? 1) / totalWeight),
    }));
  }

  private prioritySplit(
    available: ResourceBudget,
    children: DelegationPlan["children"]
  ): { agentId: string; budget: ResourceBudget }[] {
    const results: { agentId: string; budget: ResourceBudget }[] = [];
    let remaining = { ...available };

    for (const child of children) {
      const requested = child.budget;
      const allocated: ResourceBudget = {
        tokens: Math.min(requested.tokens, remaining.tokens),
        wallClockMs: Math.min(requested.wallClockMs, remaining.wallClockMs),
        apiCalls: Math.min(requested.apiCalls, remaining.apiCalls),
        memoryBytes: Math.min(requested.memoryBytes, remaining.memoryBytes),
      };
      results.push({ agentId: child.agentId, budget: allocated });
      remaining = {
        tokens: remaining.tokens - allocated.tokens,
        wallClockMs: remaining.wallClockMs - allocated.wallClockMs,
        apiCalls: remaining.apiCalls - allocated.apiCalls,
        memoryBytes: remaining.memoryBytes - allocated.memoryBytes,
      };
    }

    return results;
  }
}
