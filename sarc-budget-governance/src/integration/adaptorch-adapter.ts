/**
 * SARC Budget Governance — AdaptOrch Budget-Aware Adapter.
 *
 * Integrates budget governance with AdaptOrch-SARC topology routing.
 * When budget is constrained, routes to cheaper agent topologies.
 * When budget is ample, allows full-featured topologies.
 *
 * This adapter maps budget state to topology preferences:
 *   - High budget → PARALLEL (fast, expensive)
 *   - Medium budget → HIERARCHICAL (balanced)
 *   - Low budget → SEQUENTIAL (slow, cheap)
 *   - Critical budget → SEQUENTIAL with minimal agents
 */

import {
  AgentContract,
  ContractState,
  ResourceBudget,
  ResourceDimension,
  RESOURCE_DIMENSIONS,
} from "../contracts/types.js";
import { ContractStore } from "../contracts/conservation.js";

// ---------------------------------------------------------------------------
// Topology Types (mirrors AdaptOrch's TopologyKind)
// ---------------------------------------------------------------------------

export enum TopologyKind {
  SEQUENTIAL = "sequential",
  PARALLEL = "parallel",
  HIERARCHICAL = "hierarchical",
  HYBRID = "hybrid",
}

// ---------------------------------------------------------------------------
// Budget-Topology Mapping
// ---------------------------------------------------------------------------

export interface BudgetTopologyRule {
  /** Maximum utilization threshold for this topology */
  maxUtilization: number;
  /** Recommended topology when utilization is below threshold */
  topology: TopologyKind;
  /** Maximum number of agents allowed at this budget level */
  maxAgents: number;
  /** Description */
  description: string;
}

const DEFAULT_RULES: BudgetTopologyRule[] = [
  {
    maxUtilization: 0.3,
    topology: TopologyKind.PARALLEL,
    maxAgents: 8,
    description: "Ample budget — use parallel topology for speed",
  },
  {
    maxUtilization: 0.6,
    topology: TopologyKind.HIERARCHICAL,
    maxAgents: 5,
    description: "Moderate budget — use hierarchical for balance",
  },
  {
    maxUtilization: 0.8,
    topology: TopologyKind.SEQUENTIAL,
    maxAgents: 3,
    description: "Constrained budget — use sequential for efficiency",
  },
  {
    maxUtilization: 1.0,
    topology: TopologyKind.SEQUENTIAL,
    maxAgents: 1,
    description: "Critical budget — single agent, minimal cost",
  },
];

// ---------------------------------------------------------------------------
// Routing Decision
// ---------------------------------------------------------------------------

export interface BudgetRoutingDecision {
  /** Recommended topology */
  topology: TopologyKind;
  /** Maximum agents to use */
  maxAgents: number;
  /** Budget utilization that drove the decision */
  utilization: number;
  /** Whether the decision was constrained by budget */
  budgetConstrained: boolean;
  /** Reason for the decision */
  reason: string;
  /** Per-dimension utilization details */
  dimensionDetails: Record<ResourceDimension, { used: number; total: number; ratio: number }>;
}

// ---------------------------------------------------------------------------
// AdaptOrch Adapter
// ---------------------------------------------------------------------------

/**
 * Budget-aware topology routing adapter for AdaptOrch.
 *
 * This adapter provides budget governance for the topology router
 * in the AdaptOrch-SARC synthesis. It ensures that topology selection
 * respects budget constraints.
 */
export class AdaptOrchBudgetAdapter {
  private rules: BudgetTopologyRule[];

  constructor(
    private store: ContractStore,
    rules?: BudgetTopologyRule[]
  ) {
    this.rules = rules ?? DEFAULT_RULES;
  }

  /**
   * Get the recommended topology for a contract based on its budget state.
   */
  route(contractId: string): BudgetRoutingDecision {
    const contract = this.store.get(contractId);
    if (!contract) {
      return {
        topology: TopologyKind.SEQUENTIAL,
        maxAgents: 1,
        utilization: 1.0,
        budgetConstrained: true,
        reason: "Contract not found — defaulting to safest topology",
        dimensionDetails: this.emptyDimensionDetails(),
      };
    }

    if (contract.state !== ContractState.ACTIVATED) {
      return {
        topology: TopologyKind.SEQUENTIAL,
        maxAgents: 1,
        utilization: 1.0,
        budgetConstrained: true,
        reason: `Contract in ${contract.state} state — defaulting to safest topology`,
        dimensionDetails: this.emptyDimensionDetails(),
      };
    }

    // Calculate utilization across all dimensions
    const dimensionDetails = this.calculateDimensionDetails(contract);
    const maxUtilization = Math.max(
      ...Object.values(dimensionDetails).map((d) => d.ratio)
    );

    // Find the matching rule
    const rule = this.rules.find(
      (r) => maxUtilization <= r.maxUtilization
    ) ?? this.rules[this.rules.length - 1];

    return {
      topology: rule.topology,
      maxAgents: rule.maxAgents,
      utilization: maxUtilization,
      budgetConstrained: maxUtilization > 0.6,
      reason: rule.description,
      dimensionDetails,
    };
  }

  /**
   * Check if a specific topology is affordable for a contract.
   */
  canAfford(contractId: string, topology: TopologyKind): boolean {
    const decision = this.route(contractId);
    // The topology is affordable if it's at or below the recommended level
    const topologyCost = this.topologyCostRank(topology);
    const recommendedCost = this.topologyCostRank(decision.topology);
    return topologyCost <= recommendedCost;
  }

  /**
   * Get the maximum number of agents that can be afforded.
   */
  maxAffordableAgents(contractId: string): number {
    return this.route(contractId).maxAgents;
  }

  /**
   * Adjust a topology proposal based on budget constraints.
   *
   * If the proposed topology is too expensive, downgrades to
   * the most affordable topology that still makes progress.
   */
  adjustProposal(
    contractId: string,
    proposed: TopologyKind,
    proposedAgents: number
  ): BudgetRoutingDecision {
    const decision = this.route(contractId);

    if (this.canAfford(contractId, proposed)) {
      // Proposed topology is affordable — limit agents if needed
      return {
        ...decision,
        topology: proposed,
        maxAgents: Math.min(proposedAgents, decision.maxAgents),
        reason: `Proposed ${proposed} topology affordable — limited to ${Math.min(proposedAgents, decision.maxAgents)} agents`,
        budgetConstrained: proposedAgents > decision.maxAgents,
      };
    }

    // Downgrade
    return {
      ...decision,
      reason: `Downgraded from ${proposed} to ${decision.topology} due to budget constraints (utilization: ${(decision.utilization * 100).toFixed(1)}%)`,
      budgetConstrained: true,
    };
  }

  // --- Private helpers ---

  private calculateDimensionDetails(
    contract: AgentContract
  ): BudgetRoutingDecision["dimensionDetails"] {
    const details: BudgetRoutingDecision["dimensionDetails"] = {} as any;

    for (const dim of RESOURCE_DIMENSIONS) {
      const total = contract.budget[dim];
      const used = contract.usedBudget[dim] ?? 0;
      details[dim] = {
        used,
        total,
        ratio: total > 0 ? used / total : 0,
      };
    }

    return details;
  }

  private emptyDimensionDetails(): BudgetRoutingDecision["dimensionDetails"] {
    const details: BudgetRoutingDecision["dimensionDetails"] = {} as any;
    for (const dim of RESOURCE_DIMENSIONS) {
      details[dim] = { used: 0, total: 0, ratio: 0 };
    }
    return details;
  }

  private topologyCostRank(topology: TopologyKind): number {
    // Higher number = more expensive
    switch (topology) {
      case TopologyKind.SEQUENTIAL:
        return 1;
      case TopologyKind.HIERARCHICAL:
        return 2;
      case TopologyKind.HYBRID:
        return 3;
      case TopologyKind.PARALLEL:
        return 4;
      default:
        return 1;
    }
  }
}
