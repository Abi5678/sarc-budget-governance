/**
 * SARC Budget Governance — SARC v0.1 Integration Bridge.
 *
 * Integrates budget governance with SARC v0.1's compliance hooks.
 * SARC v0.1 enforces constraints at four enforcement sites:
 *   1. PreActionGate   → budget pre-check
 *   2. ActionMonitor   → budget monitoring during execution
 *   3. PostActionAuditor → budget usage audit
 *   4. EscalationRouter → budget violation escalation
 *
 * This bridge maps Agent Contract budget checks to SARC's enforcement
 * architecture, making budget governance a first-class constraint
 * in the SARC compliance framework.
 */

import {
  AgentContract,
  ContractContext,
  ContractState,
  ResourceBudget,
  ResourceUsage,
  zeroBudget,
} from "../contracts/types.js";
import { createRootContract } from "../contracts/factory.js";
import { lifecycle } from "../contracts/lifecycle.js";
import { ContractStore } from "../contracts/conservation.js";
import { BudgetEnforcer, BudgetDecision } from "../governance/budget-enforcer.js";
import { DelegationManager, DelegationStrategy } from "../governance/delegation.js";
import { ConstraintDriftMonitor } from "../governance/constraint-drift.js";

// ---------------------------------------------------------------------------
// SARC Compatibility Types
// ---------------------------------------------------------------------------

/**
 * SARC v0.1 constraint predicate signature.
 * Matches the Python: (context: dict) -> (satisfied: bool, details: dict)
 */
export type SarcPredicate = (context: SarcContext) => SarcPredicateResult;

export interface SarcContext {
  [key: string]: unknown;
}

export interface SarcPredicateResult {
  satisfied: boolean;
  details: Record<string, unknown>;
}

/**
 * SARC constraint specification (matches SARC v0.1 ConstraintSpec).
 */
export interface SarcConstraintSpec {
  name: string;
  description: string;
  source: "regulatory" | "organizational" | "operational" | "user";
  constraintClass: "hard" | "soft";
  predicate: SarcPredicate;
  verificationPoint: "pre_action" | "action_time" | "post_action" | "periodic";
  responseProtocol: "block" | "throttle" | "escalate" | "log_and_continue" | "rollback";
}

/**
 * SARC enforcement decision (matches SARC v0.1).
 */
export interface SarcEnforcementResult {
  decision: "allow" | "block" | "throttle" | "escalate" | "rollback";
  reason: string;
  constraintResults: Array<{
    constraintName: string;
    constraintClass: string;
    satisfied: boolean;
    details: Record<string, unknown>;
  }>;
  throttledParams?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Budget Governance Bridge
// ---------------------------------------------------------------------------

/**
 * Bridge between Agent Contracts budget governance and SARC v0.1 enforcement.
 *
 * This is the integration layer that makes budget governance work as
 * a SARC compliance constraint. It:
 *
 * 1. Creates SARC-compatible constraint predicates from budget contracts
 * 2. Maps budget enforcement results to SARC enforcement decisions
 * 3. Provides budget-aware governance hooks for the SARC agent loop
 * 4. Tracks drift in the SARC enforcement pipeline
 */
export class SarcBudgetBridge {
  private enforcer: BudgetEnforcer;
  private delegator: DelegationManager;
  private driftMonitor: ConstraintDriftMonitor;

  constructor(private store: ContractStore) {
    this.enforcer = new BudgetEnforcer(store);
    this.delegator = new DelegationManager(store);
    this.driftMonitor = new ConstraintDriftMonitor(store);
  }

  // --- SARC Constraint Creation ---

  /**
   * Create a SARC-compatible budget constraint predicate.
   *
   * This predicate checks the agent's budget contract when evaluated
   * by SARC's enforcement sites.
   */
  createBudgetConstraint(contractId: string): SarcConstraintSpec {
    return {
      name: `budget_governance_${contractId}`,
      description: "Budget governance constraint — enforces multi-dimensional resource budgets",
      source: "regulatory",
      constraintClass: "hard",
      predicate: (context: SarcContext): SarcPredicateResult => {
        return this.evaluateBudgetPredicate(contractId, context);
      },
      verificationPoint: "pre_action",
      responseProtocol: "block",
    };
  }

  /**
   * Create a SARC-compatible soft budget constraint.
   *
   * This monitors budget utilization and triggers throttling
   * when approaching limits, rather than hard blocking.
   */
  createSoftBudgetConstraint(contractId: string): SarcConstraintSpec {
    return {
      name: `soft_budget_${contractId}`,
      description: "Soft budget constraint — throttles when approaching limits",
      source: "organizational",
      constraintClass: "soft",
      predicate: (context: SarcContext): SarcPredicateResult => {
        return this.evaluateSoftBudgetPredicate(contractId, context);
      },
      verificationPoint: "pre_action",
      responseProtocol: "throttle",
    };
  }

  // --- SARC Enforcement Integration ---

  /**
   * Pre-action gate: check budget before action execution.
   *
   * Maps to SARC's PreActionGate.check() return format.
   */
  preActionGate(
    contractId: string,
    action: string,
    actionParams: Record<string, unknown>,
    sarcContext: SarcContext
  ): SarcEnforcementResult {
    // Extract proposed usage from action params
    const proposedUsage = this.extractUsage(actionParams);

    // Run budget enforcement check
    const result = this.enforcer.preActionCheck(contractId, proposedUsage);

    // Track drift
    const enforcementApplied = result.decision !== BudgetDecision.ALLOW;
    this.driftMonitor.measure(
      (sarcContext._step as number) ?? 0,
      enforcementApplied
    );

    // Map to SARC format
    return {
      decision: this.mapDecision(result.decision),
      reason: result.reason,
      constraintResults: [
        {
          constraintName: `budget_governance_${contractId}`,
          constraintClass: "hard",
          satisfied: result.decision === BudgetDecision.ALLOW,
          details: {
            remainingBudget: result.remainingBudget,
            proposedUsage,
          },
        },
      ],
      throttledParams: result.throttledParams,
    };
  }

  /**
   * Action-time monitor: track budget usage during execution.
   *
   * Maps to SARC's ActionMonitor.check() return format.
   */
  actionMonitor(
    contractId: string,
    actualUsage: ResourceUsage,
    stepNumber: number
  ): SarcEnforcementResult {
    const result = this.enforcer.recordUsage(contractId, actualUsage);

    return {
      decision: this.mapDecision(result.decision),
      reason: result.reason,
      constraintResults: [
        {
          constraintName: `budget_governance_${contractId}`,
          constraintClass: result.decision === BudgetDecision.BLOCK ? "hard" : "soft",
          satisfied: result.decision === BudgetDecision.ALLOW,
          details: {
            remainingBudget: result.remainingBudget,
            actualUsage,
          },
        },
      ],
    };
  }

  /**
   * Post-action auditor: verify budget usage after execution.
   *
   * Maps to SARC's PostActionAuditor.audit() return format.
   */
  postActionAuditor(
    contractId: string,
    expectedUsage: ResourceUsage,
    actualUsage: ResourceUsage
  ): SarcEnforcementResult {
    const result = this.enforcer.postActionAudit(
      contractId,
      expectedUsage,
      actualUsage
    );

    return {
      decision: this.mapDecision(result.decision),
      reason: result.reason,
      constraintResults: [
        {
          constraintName: `budget_audit_${contractId}`,
          constraintClass: result.decision === BudgetDecision.ESCALATE ? "hard" : "soft",
          satisfied: result.decision === BudgetDecision.ALLOW,
          details: {
            expectedUsage,
            actualUsage,
            overrun: result.decision === BudgetDecision.ESCALATE,
          },
        },
      ],
    };
  }

  // --- Budget-Aware Agent Setup ---

  /**
   * Create a budget-governed agent contract and register it with SARC.
   *
   * This is the main entry point for adding budget governance to
   * a SARC-governed agent.
   */
  createGovernedAgent(
    agentId: string,
    budget: ResourceBudget,
    options?: {
      maxDelegationDepth?: number;
      expiresAt?: number;
    }
  ): { contract: AgentContract; constraints: SarcConstraintSpec[] } {
    const contract = createRootContract(agentId, budget, {
      maxDelegationDepth: options?.maxDelegationDepth,
      expiresAt: options?.expiresAt ?? null,
    });

    // Activate the contract
    const activated = lifecycle.activate(contract);
    this.store.put(activated);

    // Create SARC-compatible constraints
    const constraints = [
      this.createBudgetConstraint(activated.contractId),
      this.createSoftBudgetConstraint(activated.contractId),
    ];

    return { contract: activated, constraints };
  }

  /**
   * Delegate budget to a child agent within the SARC framework.
   */
  delegateToChild(
    parentContractId: string,
    childAgentId: string,
    childBudget: ResourceBudget
  ): { contract: AgentContract; constraints: SarcConstraintSpec[] } | { error: string } {
    const result = this.delegator.delegateSingle(
      parentContractId,
      childAgentId,
      childBudget
    );

    if (!result.success) {
      return { error: result.reason ?? "Delegation failed" };
    }

    const childContract = result.childContracts[0];
    const constraints = [
      this.createBudgetConstraint(childContract.contractId),
      this.createSoftBudgetConstraint(childContract.contractId),
    ];

    return { contract: childContract, constraints };
  }

  /**
   * Get the drift analysis for the current trajectory.
   */
  getDriftAnalysis() {
    return this.driftMonitor.analyze();
  }

  /**
   * Get the underlying store for direct access.
   */
  getStore(): ContractStore {
    return this.store;
  }

  // --- Private helpers ---

  private evaluateBudgetPredicate(
    contractId: string,
    context: SarcContext
  ): SarcPredicateResult {
    const contract = this.store.get(contractId);
    if (!contract) {
      return {
        satisfied: false,
        details: { error: "Contract not found" },
      };
    }

    if (contract.state !== ContractState.ACTIVATED) {
      return {
        satisfied: false,
        details: {
          state: contract.state,
          reason: "Contract not active",
        },
      };
    }

    const proposedUsage = this.extractUsage(
      (context._action_params as Record<string, unknown>) ?? {}
    );
    const result = this.enforcer.preActionCheck(contractId, proposedUsage);

    return {
      satisfied: result.decision === BudgetDecision.ALLOW,
      details: {
        remainingBudget: result.remainingBudget,
        proposedUsage,
        decision: result.decision,
      },
    };
  }

  private evaluateSoftBudgetPredicate(
    contractId: string,
    context: SarcContext
  ): SarcPredicateResult {
    const contract = this.store.get(contractId);
    if (!contract) {
      return { satisfied: false, details: { error: "Contract not found" } };
    }

    // Check utilization across dimensions
    const utilization = {
      tokens: contract.budget.tokens > 0
        ? (contract.usedBudget.tokens ?? 0) / contract.budget.tokens
        : 0,
      wallClockMs: contract.budget.wallClockMs > 0
        ? (contract.usedBudget.wallClockMs ?? 0) / contract.budget.wallClockMs
        : 0,
      apiCalls: contract.budget.apiCalls > 0
        ? (contract.usedBudget.apiCalls ?? 0) / contract.budget.apiCalls
        : 0,
      memoryBytes: contract.budget.memoryBytes > 0
        ? (contract.usedBudget.memoryBytes ?? 0) / contract.budget.memoryBytes
        : 0,
    };

    const maxUtil = Math.max(...Object.values(utilization));
    const satisfied = maxUtil < 0.8; // Soft threshold at 80%

    return {
      satisfied,
      details: {
        utilization,
        maxUtilization: maxUtil,
        threshold: 0.8,
      },
    };
  }

  private extractUsage(
    params: Record<string, unknown>
  ): ResourceUsage {
    return {
      tokens: (params.tokens as number) ?? (params.budget as number) ?? 0,
      wallClockMs: (params.wallClockMs as number) ?? 0,
      apiCalls: (params.apiCalls as number) ?? 1,
      memoryBytes: (params.memoryBytes as number) ?? 0,
    };
  }

  private mapDecision(
    decision: BudgetDecision
  ): SarcEnforcementResult["decision"] {
    switch (decision) {
      case BudgetDecision.ALLOW:
        return "allow";
      case BudgetDecision.BLOCK:
        return "block";
      case BudgetDecision.THROTTLE:
        return "throttle";
      case BudgetDecision.ESCALATE:
        return "escalate";
      default:
        return "block";
    }
  }
}
