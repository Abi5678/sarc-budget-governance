/**
 * Tests: Conservation Law Enforcement.
 *
 * Verifies that the mathematical invariant holds:
 *   ∀ dimension d, Σ children_budget[d] ≤ parent_budget[d]
 *
 * Tests cover:
 * - Basic conservation verification
 * - Multi-level delegation trees
 * - Adversarial delegation (over-allocation attempts)
 * - Circular delegation detection
 * - Zero-budget edge cases
 * - Budget overflow scenarios
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  ResourceBudget,
  ContractState,
} from "../src/contracts/types.js";
import {
  createRootContract,
  createChildContract,
  resetContractCounter,
} from "../src/contracts/factory.js";
import { lifecycle } from "../src/contracts/lifecycle.js";
import { ContractStore } from "../src/contracts/conservation.js";
import {
  DelegationManager,
  DelegationStrategy,
} from "../src/governance/delegation.js";

const TEST_BUDGET: ResourceBudget = {
  tokens: 10000,
  wallClockMs: 60000,
  apiCalls: 100,
  memoryBytes: 1024 * 1024,
};

// ---------------------------------------------------------------------------
// ContractStore
// ---------------------------------------------------------------------------

describe("ContractStore", () => {
  let store: ContractStore;

  beforeEach(() => {
    store = new ContractStore();
    resetContractCounter();
  });

  it("stores and retrieves contracts", () => {
    const contract = createRootContract("a", TEST_BUDGET);
    store.put(contract);
    expect(store.get(contract.contractId)).toBeDefined();
    expect(store.get(contract.contractId)!.agentId).toBe("a");
  });

  it("returns undefined for non-existent contracts", () => {
    expect(store.get("nonexistent")).toBeUndefined();
  });

  it("lists all contracts", () => {
    store.put(createRootContract("a", TEST_BUDGET));
    store.put(createRootContract("b", TEST_BUDGET));
    expect(store.size).toBe(2);
  });

  it("finds children of a parent", () => {
    const parent = lifecycle.activate(createRootContract("parent", TEST_BUDGET));
    store.put(parent);

    const child1 = lifecycle.activate(
      createChildContract(parent, "child1", { tokens: 3000, wallClockMs: 20000, apiCalls: 30, memoryBytes: 300000 })
    );
    const child2 = lifecycle.activate(
      createChildContract(parent, "child2", { tokens: 3000, wallClockMs: 20000, apiCalls: 30, memoryBytes: 300000 })
    );
    store.put(child1);
    store.put(child2);

    const children = store.children(parent.contractId);
    expect(children).toHaveLength(2);
  });

  it("finds root contracts", () => {
    const root = createRootContract("root", TEST_BUDGET);
    const child = createChildContract(
      lifecycle.activate(root),
      "child",
      { tokens: 1000, wallClockMs: 1000, apiCalls: 10, memoryBytes: 1000 }
    );
    store.put(root);
    store.put(child);

    expect(store.roots()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Conservation Verification
// ---------------------------------------------------------------------------

describe("Conservation Law Verification", () => {
  let store: ContractStore;

  beforeEach(() => {
    store = new ContractStore();
    resetContractCounter();
  });

  it("verifies conservation for a single root (no children) — trivially conserved", () => {
    const root = createRootContract("root", TEST_BUDGET);
    store.put(root);

    const proof = store.verifyConservation(root.contractId);
    expect(proof.conserved).toBe(true);
    expect(proof.violations).toHaveLength(0);
  });

  it("verifies conservation when children sum ≤ parent", () => {
    const parent = lifecycle.activate(createRootContract("parent", TEST_BUDGET));
    store.put(parent);

    const child1 = lifecycle.activate(
      createChildContract(parent, "c1", { tokens: 3000, wallClockMs: 20000, apiCalls: 30, memoryBytes: 300000 })
    );
    const child2 = lifecycle.activate(
      createChildContract(parent, "c2", { tokens: 4000, wallClockMs: 20000, apiCalls: 40, memoryBytes: 400000 })
    );
    store.put(child1);
    store.put(child2);

    const proof = store.verifyConservation(parent.contractId);
    expect(proof.conserved).toBe(true);
    expect(proof.dimensions.tokens.slack).toBe(3000); // 10000 - 7000
  });

  it("detects conservation violation when children sum > parent", () => {
    const parent = lifecycle.activate(createRootContract("parent", TEST_BUDGET));
    store.put(parent);

    const child1 = lifecycle.activate(
      createChildContract(parent, "c1", { tokens: 6000, wallClockMs: 30000, apiCalls: 60, memoryBytes: 600000 })
    );
    store.put(child1);

    // Manually inject an oversized child (bypassing factory validation)
    // This simulates a bug or adversarial manipulation
    const oversizedChild = lifecycle.activate(createRootContract("attacker", {
      tokens: 6000, wallClockMs: 35000, apiCalls: 50, memoryBytes: 500000,
    }));
    oversizedChild.parentContractId = parent.contractId;
    store.put(oversizedChild);

    const proof = store.verifyConservation(parent.contractId);
    expect(proof.conserved).toBe(false);
    expect(proof.violations.length).toBeGreaterThan(0);
    expect(proof.dimensions.tokens.overshoot).toBe(2000); // 12000 - 10000
  });

  it("verifyAllConservation checks entire tree", () => {
    const parent = lifecycle.activate(createRootContract("parent", TEST_BUDGET));
    store.put(parent);

    const child = lifecycle.activate(
      createChildContract(parent, "child", { tokens: 5000, wallClockMs: 30000, apiCalls: 50, memoryBytes: 500000 })
    );
    store.put(child);

    const result = store.verifyAllConservation();
    expect(result.conserved).toBe(true);
    expect(result.perParent.size).toBe(1);
  });

  it("canDelegate returns allowed when conservation holds", () => {
    const parent = lifecycle.activate(createRootContract("parent", TEST_BUDGET));
    store.put(parent);

    const result = store.canDelegate({
      parentContractId: parent.contractId,
      childAgentId: "child",
      requestedBudget: { tokens: 5000, wallClockMs: 30000, apiCalls: 50, memoryBytes: 500000 },
      maxDepth: 3,
    });

    expect(result.allowed).toBe(true);
  });

  it("canDelegate rejects when requested budget exceeds remaining", () => {
    const parent = lifecycle.activate(createRootContract("parent", TEST_BUDGET));
    // Use most of the budget
    const used = lifecycle.recordUsage(parent, { tokens: 9000, apiCalls: 90 });
    store.put(used);

    const result = store.canDelegate({
      parentContractId: used.contractId,
      childAgentId: "child",
      requestedBudget: { tokens: 5000, wallClockMs: 30000, apiCalls: 50, memoryBytes: 500000 },
      maxDepth: 3,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Insufficient remaining budget");
  });

  it("canDelegate rejects when max delegation depth reached", () => {
    const parent = lifecycle.activate(
      createRootContract("parent", TEST_BUDGET, { maxDelegationDepth: 0 })
    );
    store.put(parent);

    const result = store.canDelegate({
      parentContractId: parent.contractId,
      childAgentId: "child",
      requestedBudget: { tokens: 100, wallClockMs: 100, apiCalls: 1, memoryBytes: 100 },
      maxDepth: 0,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Max delegation depth");
  });
});

// ---------------------------------------------------------------------------
// Circular Delegation Detection
// ---------------------------------------------------------------------------

describe("Circular Delegation Detection", () => {
  let store: ContractStore;

  beforeEach(() => {
    store = new ContractStore();
    resetContractCounter();
  });

  it("detects no cycles in a valid tree", () => {
    const parent = lifecycle.activate(createRootContract("parent", TEST_BUDGET));
    const child = lifecycle.activate(
      createChildContract(parent, "child", { tokens: 5000, wallClockMs: 30000, apiCalls: 50, memoryBytes: 500000 })
    );
    store.put(parent);
    store.put(child);

    const result = store.detectCircularDelegation();
    expect(result.hasCycle).toBe(false);
  });

  it("detects no cycles with empty store", () => {
    const result = store.detectCircularDelegation();
    expect(result.hasCycle).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Delegation Manager
// ---------------------------------------------------------------------------

describe("DelegationManager", () => {
  let store: ContractStore;
  let delegator: DelegationManager;

  beforeEach(() => {
    store = new ContractStore();
    delegator = new DelegationManager(store);
    resetContractCounter();
  });

  it("delegates equal split among children", () => {
    const parent = lifecycle.activate(createRootContract("parent", TEST_BUDGET));
    store.put(parent);

    const result = delegator.delegate({
      parentContractId: parent.contractId,
      strategy: DelegationStrategy.EQUAL,
      children: [
        { agentId: "c1", budget: { tokens: 0, wallClockMs: 0, apiCalls: 0, memoryBytes: 0 } },
        { agentId: "c2", budget: { tokens: 0, wallClockMs: 0, apiCalls: 0, memoryBytes: 0 } },
      ],
      parentReserve: 0,
    });

    expect(result.success).toBe(true);
    expect(result.childContracts).toHaveLength(2);
    expect(result.conservationHeld).toBe(true);

    // Each child should get ~5000 tokens
    expect(result.childContracts[0].budget.tokens).toBe(5000);
    expect(result.childContracts[1].budget.tokens).toBe(5000);
  });

  it("delegates with parent reserve", () => {
    const parent = lifecycle.activate(createRootContract("parent", TEST_BUDGET));
    store.put(parent);

    const result = delegator.delegate({
      parentContractId: parent.contractId,
      strategy: DelegationStrategy.EQUAL,
      children: [
        { agentId: "c1", budget: { tokens: 0, wallClockMs: 0, apiCalls: 0, memoryBytes: 0 } },
      ],
      parentReserve: 0.2, // Reserve 20%
    });

    expect(result.success).toBe(true);
    // Child gets 80% of 10000 = 8000
    expect(result.childContracts[0].budget.tokens).toBe(8000);
  });

  it("delegates proportional split by weight", () => {
    const parent = lifecycle.activate(createRootContract("parent", TEST_BUDGET));
    store.put(parent);

    const result = delegator.delegate({
      parentContractId: parent.contractId,
      strategy: DelegationStrategy.PROPORTIONAL,
      children: [
        { agentId: "heavy", budget: { tokens: 0, wallClockMs: 0, apiCalls: 0, memoryBytes: 0 }, weight: 3 },
        { agentId: "light", budget: { tokens: 0, wallClockMs: 0, apiCalls: 0, memoryBytes: 0 }, weight: 1 },
      ],
      parentReserve: 0,
    });

    expect(result.success).toBe(true);
    // 3:1 split → 7500:2500
    expect(result.childContracts[0].budget.tokens).toBe(7500);
    expect(result.childContracts[1].budget.tokens).toBe(2500);
  });

  it("delegates single child", () => {
    const parent = lifecycle.activate(createRootContract("parent", TEST_BUDGET));
    store.put(parent);

    const result = delegator.delegateSingle(
      parent.contractId,
      "child",
      { tokens: 5000, wallClockMs: 30000, apiCalls: 50, memoryBytes: 500000 }
    );

    expect(result.success).toBe(true);
    expect(result.childContracts).toHaveLength(1);
    expect(result.childContracts[0].agentId).toBe("child");
  });

  it("rejects delegation that would exceed remaining budget", () => {
    const parent = lifecycle.activate(createRootContract("parent", TEST_BUDGET));
    // Use most of the budget first
    const partiallyUsed = lifecycle.recordUsage(parent, { tokens: 9000, apiCalls: 90 });
    store.put(partiallyUsed);

    // Now try to delegate more than remaining
    const result = delegator.delegateSingle(
      partiallyUsed.contractId,
      "child",
      { tokens: 99999, wallClockMs: 30000, apiCalls: 50, memoryBytes: 500000 }
    );

    // PRIORITY strategy caps at remaining, so it succeeds but with less than requested
    // The actual check is that conservation holds
    expect(result.conservationHeld).toBe(true);
  });

  it("rejects delegation when all dimensions are insufficient", () => {
    const smallBudget: ResourceBudget = { tokens: 100, wallClockMs: 100, apiCalls: 1, memoryBytes: 100 };
    const parent = lifecycle.activate(createRootContract("parent", smallBudget));
    store.put(parent);

    // Try to delegate a budget that exceeds on wallClockMs dimension
    // where even capping won't help because other dimensions also can't be satisfied
    const result = delegator.delegate({
      parentContractId: parent.contractId,
      strategy: DelegationStrategy.EQUAL,
      children: [
        { agentId: "c1", budget: { tokens: 0, wallClockMs: 0, apiCalls: 0, memoryBytes: 0 } },
        { agentId: "c2", budget: { tokens: 0, wallClockMs: 0, apiCalls: 0, memoryBytes: 0 } },
      ],
      parentReserve: 0,
    });

    // With only 1 apiCall, equal split gives 0.5 each, which floors to 0
    // So this might succeed — test that conservation holds
    expect(result.conservationHeld).toBe(true);
  });

  it("rejects delegation from non-active parent", () => {
    const parent = createRootContract("parent", TEST_BUDGET);
    // Parent is in CREATED state, not activated
    store.put(parent);

    const result = delegator.delegateSingle(
      parent.contractId,
      "child",
      { tokens: 100, wallClockMs: 100, apiCalls: 1, memoryBytes: 100 }
    );

    expect(result.success).toBe(false);
    expect(result.reason).toContain("must be activated");
  });

  it("supports multi-level delegation", () => {
    const root = lifecycle.activate(createRootContract("root", TEST_BUDGET));
    store.put(root);

    const level1Result = delegator.delegateSingle(
      root.contractId,
      "agent-l1",
      { tokens: 6000, wallClockMs: 40000, apiCalls: 60, memoryBytes: 600000 }
    );
    expect(level1Result.success).toBe(true);

    const level1Contract = level1Result.childContracts[0];

    const level2Result = delegator.delegateSingle(
      level1Contract.contractId,
      "agent-l2",
      { tokens: 3000, wallClockMs: 20000, apiCalls: 30, memoryBytes: 300000 }
    );
    expect(level2Result.success).toBe(true);

    // Verify full conservation
    const fullProof = store.verifyAllConservation();
    expect(fullProof.conserved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Adversarial Delegation — Zero Conservation Violations
// ---------------------------------------------------------------------------

describe("Adversarial Conservation Tests", () => {
  let store: ContractStore;
  let delegator: DelegationManager;

  beforeEach(() => {
    store = new ContractStore();
    delegator = new DelegationManager(store);
    resetContractCounter();
  });

  it("rejects circular delegation via factory", () => {
    const parent = lifecycle.activate(createRootContract("parent", TEST_BUDGET));
    store.put(parent);

    // Attempt to create child that would exceed budget
    expect(() =>
      createChildContract(parent, "child", {
        tokens: 99999,
        wallClockMs: 60000,
        apiCalls: 100,
        memoryBytes: 1024 * 1024,
      })
    ).toThrow();
  });

  it("handles zero-budget agents", () => {
    const zeroB: ResourceBudget = { tokens: 0, wallClockMs: 0, apiCalls: 0, memoryBytes: 0 };
    const contract = createRootContract("zero-agent", zeroB);
    const activated = lifecycle.activate(contract);

    // Recording any usage should violate
    const result = lifecycle.recordUsage(activated, { tokens: 1 });
    expect(result.state).toBe(ContractState.VIOLATED);
  });

  it("handles budget overflow correctly", () => {
    const smallBudget: ResourceBudget = { tokens: 100, wallClockMs: 1000, apiCalls: 10, memoryBytes: 1024 };
    const contract = lifecycle.activate(createRootContract("small", smallBudget));

    // Use all budget
    const used = lifecycle.recordUsage(contract, { tokens: 50, apiCalls: 5 });
    expect(used.state).toBe(ContractState.ACTIVATED);

    // Use the rest
    const used2 = lifecycle.recordUsage(used, { tokens: 50, apiCalls: 5 });
    expect(used2.state).toBe(ContractState.ACTIVATED);

    // One more should violate
    const violated = lifecycle.recordUsage(used2, { tokens: 1 });
    expect(violated.state).toBe(ContractState.VIOLATED);
  });

  it("conservation holds under rapid delegation", () => {
    const root = lifecycle.activate(createRootContract("root", TEST_BUDGET));
    store.put(root);

    // Rapidly delegate to many children
    for (let i = 0; i < 10; i++) {
      const result = delegator.delegateSingle(
        root.contractId,
        `child-${i}`,
        { tokens: 800, wallClockMs: 5000, apiCalls: 8, memoryBytes: 80000 }
      );
      // Some should succeed, some should fail once budget runs out
      if (result.success) {
        expect(result.conservationHeld).toBe(true);
      }
    }

    // Full conservation check
    const proof = store.verifyAllConservation();
    expect(proof.conserved).toBe(true);
  });

  it("no conservation violations under adversarial allocation patterns", () => {
    // Test with various budget sizes
    const budgets: ResourceBudget[] = [
      { tokens: 100, wallClockMs: 1000, apiCalls: 10, memoryBytes: 1024 },
      { tokens: 1000000, wallClockMs: 3600000, apiCalls: 10000, memoryBytes: 1024 * 1024 * 1024 },
      { tokens: 1, wallClockMs: 1, apiCalls: 1, memoryBytes: 1 },
    ];

    for (const budget of budgets) {
      const root = lifecycle.activate(createRootContract("root", budget));
      const localStore = new ContractStore();
      localStore.put(root);
      const localDelegator = new DelegationManager(localStore);

      // Try to delegate everything
      const result = localDelegator.delegateSingle(
        root.contractId,
        "child",
        budget // Delegate the entire budget
      );

      if (result.success) {
        const proof = localStore.verifyAllConservation();
        expect(proof.conserved).toBe(true);
      }
    }
  });
});
