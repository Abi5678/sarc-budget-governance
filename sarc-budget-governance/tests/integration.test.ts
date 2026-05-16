/**
 * Tests: SARC Integration Bridge.
 *
 * Tests the SarcBudgetBridge that integrates budget governance
 * with SARC v0.1's enforcement architecture.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  ResourceBudget,
  ContractState,
} from "../src/contracts/types.js";
import { resetContractCounter } from "../src/contracts/factory.js";
import { lifecycle } from "../src/contracts/lifecycle.js";
import { ContractStore } from "../src/contracts/conservation.js";
import {
  SarcBudgetBridge,
  SarcConstraintSpec,
} from "../src/integration/sarc-bridge.js";
import {
  AdaptOrchBudgetAdapter,
  TopologyKind,
} from "../src/integration/adaptorch-adapter.js";

const TEST_BUDGET: ResourceBudget = {
  tokens: 10000,
  wallClockMs: 60000,
  apiCalls: 100,
  memoryBytes: 1024 * 1024,
};

describe("SarcBudgetBridge", () => {
  let store: ContractStore;
  let bridge: SarcBudgetBridge;

  beforeEach(() => {
    store = new ContractStore();
    bridge = new SarcBudgetBridge(store);
    resetContractCounter();
  });

  describe("createGovernedAgent", () => {
    it("creates a budget-governed agent with SARC constraints", () => {
      const result = bridge.createGovernedAgent("agent-1", TEST_BUDGET);

      expect(result.contract.state).toBe(ContractState.ACTIVATED);
      expect(result.constraints).toHaveLength(2);

      // Hard budget constraint
      expect(result.constraints[0].name).toContain("budget_governance");
      expect(result.constraints[0].constraintClass).toBe("hard");
      expect(result.constraints[0].verificationPoint).toBe("pre_action");

      // Soft budget constraint
      expect(result.constraints[1].name).toContain("soft_budget");
      expect(result.constraints[1].constraintClass).toBe("soft");
    });
  });

  describe("preActionGate", () => {
    it("allows within-budget actions", () => {
      const { contract } = bridge.createGovernedAgent("agent-1", TEST_BUDGET);

      const result = bridge.preActionGate(
        contract.contractId,
        "generate_text",
        { tokens: 1000, apiCalls: 1 },
        {}
      );

      expect(result.decision).toBe("allow");
    });

    it("blocks over-budget actions", () => {
      const { contract } = bridge.createGovernedAgent("agent-1", TEST_BUDGET);

      const result = bridge.preActionGate(
        contract.contractId,
        "generate_text",
        { tokens: 99999 },
        {}
      );

      expect(result.decision).toBe("block");
    });

    it("returns constraint results in SARC format", () => {
      const { contract } = bridge.createGovernedAgent("agent-1", TEST_BUDGET);

      const result = bridge.preActionGate(
        contract.contractId,
        "generate_text",
        { tokens: 1000 },
        {}
      );

      expect(result.constraintResults).toHaveLength(1);
      expect(result.constraintResults[0].satisfied).toBe(true);
    });
  });

  describe("actionMonitor", () => {
    it("records usage via SARC action monitor", () => {
      const { contract } = bridge.createGovernedAgent("agent-1", TEST_BUDGET);

      const result = bridge.actionMonitor(contract.contractId, {
        tokens: 1000,
        apiCalls: 5,
      }, 1);

      expect(result.decision).toBe("allow");
    });
  });

  describe("postActionAuditor", () => {
    it("detects usage overruns", () => {
      const { contract } = bridge.createGovernedAgent("agent-1", TEST_BUDGET);

      const result = bridge.postActionAuditor(
        contract.contractId,
        { tokens: 1000, apiCalls: 5 },
        { tokens: 2000, apiCalls: 5 } // 100% overrun
      );

      expect(result.decision).toBe("escalate");
    });
  });

  describe("delegateToChild", () => {
    it("delegates budget to child agents", () => {
      const { contract } = bridge.createGovernedAgent("parent", TEST_BUDGET);

      const childResult = bridge.delegateToChild(
        contract.contractId,
        "child",
        { tokens: 5000, wallClockMs: 30000, apiCalls: 50, memoryBytes: 500000 }
      );

      if ("error" in childResult) {
        expect.fail(`Delegation failed: ${childResult.error}`);
      }

      expect(childResult.contract.agentId).toBe("child");
      expect(childResult.constraints).toHaveLength(2);
    });

    it("rejects over-budget delegation", () => {
      const { contract } = bridge.createGovernedAgent("parent", TEST_BUDGET);

      const childResult = bridge.delegateToChild(
        contract.contractId,
        "child",
        { tokens: 99999, wallClockMs: 30000, apiCalls: 50, memoryBytes: 500000 }
      );

      expect("error" in childResult).toBe(true);
    });
  });

  describe("SARC constraint predicates", () => {
    it("hard budget predicate evaluates correctly", () => {
      const { contract, constraints } = bridge.createGovernedAgent("a", TEST_BUDGET);

      const hardConstraint = constraints[0];
      const result = hardConstraint.predicate({
        _action_params: { tokens: 1000 },
      });

      expect(result.satisfied).toBe(true);
    });

    it("hard budget predicate rejects when over budget", () => {
      const { contract, constraints } = bridge.createGovernedAgent("a", TEST_BUDGET);

      const hardConstraint = constraints[0];
      const result = hardConstraint.predicate({
        _action_params: { tokens: 99999 },
      });

      expect(result.satisfied).toBe(false);
    });

    it("soft budget predicate warns at high utilization", () => {
      const { contract, constraints } = bridge.createGovernedAgent("a", TEST_BUDGET);

      // Use 85% of budget
      lifecycle.recordUsage(contract, { tokens: 8500 });
      store.put(contract);

      const softConstraint = constraints[1];
      const result = softConstraint.predicate({});

      expect(result.satisfied).toBe(false);
      expect(result.details.threshold).toBe(0.8);
    });
  });
});

// ---------------------------------------------------------------------------
// AdaptOrch Budget Adapter
// ---------------------------------------------------------------------------

describe("AdaptOrchBudgetAdapter", () => {
  let store: ContractStore;
  let adapter: AdaptOrchBudgetAdapter;

  beforeEach(() => {
    store = new ContractStore();
    adapter = new AdaptOrchBudgetAdapter(store);
    resetContractCounter();
  });

  it("routes to PARALLEL when budget is ample", () => {
    const contract = lifecycle.activate(createRootContract("a", TEST_BUDGET));
    store.put(contract);

    const decision = adapter.route(contract.contractId);
    expect(decision.topology).toBe(TopologyKind.PARALLEL);
    expect(decision.budgetConstrained).toBe(false);
  });

  it("routes to HIERARCHICAL at moderate utilization", () => {
    const contract = lifecycle.activate(createRootContract("a", TEST_BUDGET));
    const used = lifecycle.recordUsage(contract, { tokens: 5000 }); // 50%
    store.put(used);

    const decision = adapter.route(used.contractId);
    expect(decision.topology).toBe(TopologyKind.HIERARCHICAL);
  });

  it("routes to SEQUENTIAL at high utilization", () => {
    const contract = lifecycle.activate(createRootContract("a", TEST_BUDGET));
    const used = lifecycle.recordUsage(contract, { tokens: 7000 }); // 70%
    store.put(used);

    const decision = adapter.route(used.contractId);
    expect(decision.topology).toBe(TopologyKind.SEQUENTIAL);
  });

  it("routes to single-agent SEQUENTIAL at critical utilization", () => {
    const contract = lifecycle.activate(createRootContract("a", TEST_BUDGET));
    const used = lifecycle.recordUsage(contract, { tokens: 9500 }); // 95%
    store.put(used);

    const decision = adapter.route(used.contractId);
    expect(decision.topology).toBe(TopologyKind.SEQUENTIAL);
    expect(decision.maxAgents).toBe(1);
  });

  it("canAfford checks if topology is within budget", () => {
    const contract = lifecycle.activate(createRootContract("a", TEST_BUDGET));
    store.put(contract);

    expect(adapter.canAfford(contract.contractId, TopologyKind.PARALLEL)).toBe(true);
    expect(adapter.canAfford(contract.contractId, TopologyKind.SEQUENTIAL)).toBe(true);
  });

  it("adjustProposal downgrades topology when needed", () => {
    const contract = lifecycle.activate(createRootContract("a", TEST_BUDGET));
    const used = lifecycle.recordUsage(contract, { tokens: 7000 }); // 70%
    store.put(used);

    const adjusted = adapter.adjustProposal(
      used.contractId,
      TopologyKind.PARALLEL,
      8
    );

    expect(adjusted.topology).toBe(TopologyKind.SEQUENTIAL);
    expect(adjusted.budgetConstrained).toBe(true);
  });

  it("adjustProposal limits agents when topology is affordable", () => {
    const contract = lifecycle.activate(createRootContract("a", TEST_BUDGET));
    store.put(contract);

    const adjusted = adapter.adjustProposal(
      contract.contractId,
      TopologyKind.PARALLEL,
      100 // Way too many agents
    );

    expect(adjusted.topology).toBe(TopologyKind.PARALLEL);
    expect(adjusted.maxAgents).toBeLessThanOrEqual(8);
    expect(adjusted.budgetConstrained).toBe(true);
  });

  it("handles non-existent contract safely", () => {
    const decision = adapter.route("nonexistent");
    expect(decision.topology).toBe(TopologyKind.SEQUENTIAL);
    expect(decision.maxAgents).toBe(1);
    expect(decision.budgetConstrained).toBe(true);
  });
});
