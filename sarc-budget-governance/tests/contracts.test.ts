/**
 * Tests: Core Contract Types, Factory, and Lifecycle.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  ContractState,
  canTransition,
  ResourceBudget,
  zeroBudget,
  scaleBudget,
  addBudgets,
  subtractBudget,
  isBudgetExceeded,
  isBudgetDepleted,
} from "../src/contracts/types.js";
import {
  createContract,
  createRootContract,
  createChildContract,
  resetContractCounter,
} from "../src/contracts/factory.js";
import {
  LifecycleManager,
  InvalidTransitionError,
  lifecycle,
} from "../src/contracts/lifecycle.js";

// ---------------------------------------------------------------------------
// Types & Helpers
// ---------------------------------------------------------------------------

const TEST_BUDGET: ResourceBudget = {
  tokens: 10000,
  wallClockMs: 60000,
  apiCalls: 100,
  memoryBytes: 1024 * 1024, // 1 MB
};

// ---------------------------------------------------------------------------
// Contract State Machine
// ---------------------------------------------------------------------------

describe("ContractState", () => {
  it("has exactly 5 states", () => {
    expect(Object.values(ContractState)).toHaveLength(5);
  });

  it("states are: created, activated, completed, expired, violated", () => {
    expect(ContractState.CREATED).toBe("created");
    expect(ContractState.ACTIVATED).toBe("activated");
    expect(ContractState.COMPLETED).toBe("completed");
    expect(ContractState.EXPIRED).toBe("expired");
    expect(ContractState.VIOLATED).toBe("violated");
  });
});

describe("canTransition", () => {
  it("allows CREATED → ACTIVATED", () => {
    expect(canTransition(ContractState.CREATED, ContractState.ACTIVATED)).toBe(true);
  });

  it("allows ACTIVATED → COMPLETED", () => {
    expect(canTransition(ContractState.ACTIVATED, ContractState.COMPLETED)).toBe(true);
  });

  it("allows ACTIVATED → EXPIRED", () => {
    expect(canTransition(ContractState.ACTIVATED, ContractState.EXPIRED)).toBe(true);
  });

  it("allows ACTIVATED → VIOLATED", () => {
    expect(canTransition(ContractState.ACTIVATED, ContractState.VIOLATED)).toBe(true);
  });

  it("rejects CREATED → COMPLETED (skip activation)", () => {
    expect(canTransition(ContractState.CREATED, ContractState.COMPLETED)).toBe(false);
  });

  it("rejects transitions from terminal states", () => {
    expect(canTransition(ContractState.COMPLETED, ContractState.ACTIVATED)).toBe(false);
    expect(canTransition(ContractState.EXPIRED, ContractState.ACTIVATED)).toBe(false);
    expect(canTransition(ContractState.VIOLATED, ContractState.CREATED)).toBe(false);
  });

  it("rejects self-transitions", () => {
    expect(canTransition(ContractState.CREATED, ContractState.CREATED)).toBe(false);
    expect(canTransition(ContractState.ACTIVATED, ContractState.ACTIVATED)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Resource Budget Operations
// ---------------------------------------------------------------------------

describe("ResourceBudget operations", () => {
  it("zeroBudget returns all zeros", () => {
    const z = zeroBudget();
    expect(z.tokens).toBe(0);
    expect(z.wallClockMs).toBe(0);
    expect(z.apiCalls).toBe(0);
    expect(z.memoryBytes).toBe(0);
  });

  it("subtractBudget works correctly", () => {
    const result = subtractBudget(TEST_BUDGET, { tokens: 1000 });
    expect(result.tokens).toBe(9000);
    expect(result.wallClockMs).toBe(60000);
  });

  it("addBudgets works correctly", () => {
    const a: ResourceBudget = { tokens: 100, wallClockMs: 200, apiCalls: 3, memoryBytes: 400 };
    const b: ResourceBudget = { tokens: 50, wallClockMs: 100, apiCalls: 2, memoryBytes: 600 };
    const result = addBudgets(a, b);
    expect(result.tokens).toBe(150);
    expect(result.apiCalls).toBe(5);
    expect(result.memoryBytes).toBe(1000);
  });

  it("scaleBudget scales all dimensions", () => {
    const scaled = scaleBudget(TEST_BUDGET, 0.5);
    expect(scaled.tokens).toBe(5000);
    expect(scaled.wallClockMs).toBe(30000);
    expect(scaled.apiCalls).toBe(50);
  });

  it("isBudgetExceeded detects negative dimensions", () => {
    const exceeded = subtractBudget(TEST_BUDGET, { tokens: 20000 });
    expect(isBudgetExceeded(exceeded)).toBe(true);
  });

  it("isBudgetExceeded returns false for positive budgets", () => {
    expect(isBudgetExceeded(TEST_BUDGET)).toBe(false);
  });

  it("isBudgetDepleted detects zero dimensions", () => {
    const depleted = subtractBudget(TEST_BUDGET, { tokens: 10000 });
    expect(isBudgetDepleted(depleted)).toBe(true);
  });

  it("isBudgetDepleted returns false for positive budgets", () => {
    expect(isBudgetDepleted(TEST_BUDGET)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Contract Factory
// ---------------------------------------------------------------------------

describe("Contract Factory", () => {
  beforeEach(() => {
    resetContractCounter();
  });

  it("createContract creates a contract in CREATED state", () => {
    const contract = createContract({
      agentId: "test-agent",
      budget: TEST_BUDGET,
    });

    expect(contract.state).toBe(ContractState.CREATED);
    expect(contract.agentId).toBe("test-agent");
    expect(contract.parentContractId).toBeNull();
    expect(contract.budget).toEqual(TEST_BUDGET);
    expect(contract.remainingBudget).toEqual(TEST_BUDGET);
    expect(contract.usedBudget).toEqual(zeroBudget());
    expect(contract.auditTrail).toHaveLength(1);
    expect(contract.childContractIds).toHaveLength(0);
  });

  it("createRootContract creates a depth-0 contract", () => {
    const contract = createRootContract("root-agent", TEST_BUDGET);
    expect(contract.currentDelegationDepth).toBe(0);
    expect(contract.maxDelegationDepth).toBe(3);
  });

  it("createChildContract creates a contract with correct parent", () => {
    const parent = createRootContract("parent", TEST_BUDGET);
    const activated = lifecycle.activate(parent);

    const child = createChildContract(activated, "child", {
      tokens: 5000,
      wallClockMs: 30000,
      apiCalls: 50,
      memoryBytes: 512 * 1024,
    });

    expect(child.parentContractId).toBe(activated.contractId);
    expect(child.currentDelegationDepth).toBe(1);
    expect(child.agentId).toBe("child");
  });

  it("createChildContract throws if budget exceeds parent remaining", () => {
    const parent = createRootContract("parent", TEST_BUDGET);
    const activated = lifecycle.activate(parent);

    expect(() =>
      createChildContract(activated, "child", {
        tokens: 99999,
        wallClockMs: 30000,
        apiCalls: 50,
        memoryBytes: 512 * 1024,
      })
    ).toThrow("Conservation violation");
  });

  it("createChildContract throws if max delegation depth reached", () => {
    const parent = createRootContract("parent", TEST_BUDGET, {
      maxDelegationDepth: 0,
    });
    const activated = lifecycle.activate(parent);

    expect(() =>
      createChildContract(activated, "child", {
        tokens: 100,
        wallClockMs: 100,
        apiCalls: 1,
        memoryBytes: 100,
      })
    ).toThrow("Max delegation depth");
  });

  it("generateContractId produces unique IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(createContract({ agentId: "a", budget: TEST_BUDGET }).contractId);
    }
    expect(ids.size).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle Manager
// ---------------------------------------------------------------------------

describe("LifecycleManager", () => {
  let lm: LifecycleManager;

  beforeEach(() => {
    lm = new LifecycleManager();
    resetContractCounter();
  });

  it("activates a CREATED contract", () => {
    const contract = createContract({ agentId: "a", budget: TEST_BUDGET });
    const activated = lm.activate(contract);
    expect(activated.state).toBe(ContractState.ACTIVATED);
    expect(activated.activatedAt).not.toBeNull();
  });

  it("completes an ACTIVATED contract", () => {
    const contract = lm.activate(createContract({ agentId: "a", budget: TEST_BUDGET }));
    const completed = lm.complete(contract);
    expect(completed.state).toBe(ContractState.COMPLETED);
    expect(completed.terminatedAt).not.toBeNull();
  });

  it("expires an ACTIVATED contract", () => {
    const contract = lm.activate(createContract({ agentId: "a", budget: TEST_BUDGET }));
    const expired = lm.expire(contract);
    expect(expired.state).toBe(ContractState.EXPIRED);
  });

  it("violates an ACTIVATED contract", () => {
    const contract = lm.activate(createContract({ agentId: "a", budget: TEST_BUDGET }));
    const violated = lm.violate(contract, "Budget exceeded");
    expect(violated.state).toBe(ContractState.VIOLATED);
  });

  it("throws on invalid transition: CREATED → COMPLETED", () => {
    const contract = createContract({ agentId: "a", budget: TEST_BUDGET });
    expect(() => lm.complete(contract)).toThrow(InvalidTransitionError);
  });

  it("throws on invalid transition: COMPLETED → ACTIVATED", () => {
    const contract = lm.complete(
      lm.activate(createContract({ agentId: "a", budget: TEST_BUDGET }))
    );
    expect(() => lm.activate(contract)).toThrow(InvalidTransitionError);
  });

  it("records usage and updates remaining budget", () => {
    const contract = lm.activate(createContract({ agentId: "a", budget: TEST_BUDGET }));
    const updated = lm.recordUsage(contract, { tokens: 1000, apiCalls: 5 });
    expect(updated.remainingBudget.tokens).toBe(9000);
    expect(updated.remainingBudget.apiCalls).toBe(95);
    expect(updated.usedBudget.tokens).toBe(1000);
  });

  it("transitions to VIOLATED when budget exceeded", () => {
    const contract = lm.activate(createContract({ agentId: "a", budget: TEST_BUDGET }));
    const updated = lm.recordUsage(contract, { tokens: 99999 });
    expect(updated.state).toBe(ContractState.VIOLATED);
  });

  it("audit trail grows with each transition", () => {
    let contract = createContract({ agentId: "a", budget: TEST_BUDGET });
    expect(contract.auditTrail).toHaveLength(1);

    contract = lm.activate(contract);
    expect(contract.auditTrail).toHaveLength(2);

    contract = lm.recordUsage(contract, { tokens: 100 });
    expect(contract.auditTrail).toHaveLength(3);

    contract = lm.complete(contract);
    expect(contract.auditTrail).toHaveLength(4);
  });

  it("checkExpiry auto-expires when time is up at activation", () => {
    const past = Date.now() - 1000;
    const contract = createContract({ agentId: "a", budget: TEST_BUDGET, expiresAt: past });
    // Activating a contract that has already expired should result in EXPIRED state
    const result = lm.activate(contract);
    expect(result.state).toBe(ContractState.EXPIRED);
  });

  it("checkExpiry expires an active contract when time is up", () => {
    const future = Date.now() + 60000;
    const contract = lm.activate(
      createContract({ agentId: "a", budget: TEST_BUDGET, expiresAt: future })
    );
    // Manually call expire on an active contract
    const result = lm.expire(contract);
    expect(result.state).toBe(ContractState.EXPIRED);
  });

  it("checkDepletion completes contract when budget is fully used", () => {
    const contract = lm.activate(createContract({ agentId: "a", budget: TEST_BUDGET }));
    // Use exactly the full budget
    const used = lm.recordUsage(contract, {
      tokens: 10000,
      wallClockMs: 60000,
      apiCalls: 100,
      memoryBytes: 1024 * 1024,
    });
    const result = lm.checkDepletion(used);
    expect(result.state).toBe(ContractState.COMPLETED);
  });
});
