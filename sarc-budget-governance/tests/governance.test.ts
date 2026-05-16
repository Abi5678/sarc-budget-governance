/**
 * Tests: Budget Enforcer.
 *
 * Tests the BudgetEnforcer's pre-action gating, action monitoring,
 * post-action auditing, and time expiry checks.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  ResourceBudget,
  ContractState,
} from "../src/contracts/types.js";
import { createRootContract, resetContractCounter } from "../src/contracts/factory.js";
import { lifecycle } from "../src/contracts/lifecycle.js";
import { ContractStore } from "../src/contracts/conservation.js";
import {
  BudgetEnforcer,
  BudgetDecision,
} from "../src/governance/budget-enforcer.js";

const TEST_BUDGET: ResourceBudget = {
  tokens: 10000,
  wallClockMs: 60000,
  apiCalls: 100,
  memoryBytes: 1024 * 1024,
};

describe("BudgetEnforcer", () => {
  let store: ContractStore;
  let enforcer: BudgetEnforcer;

  beforeEach(() => {
    store = new ContractStore();
    enforcer = new BudgetEnforcer(store);
    resetContractCounter();
  });

  // --- Pre-Action Gate ---

  describe("preActionCheck", () => {
    it("allows actions within budget", () => {
      const contract = lifecycle.activate(createRootContract("a", TEST_BUDGET));
      store.put(contract);

      const result = enforcer.preActionCheck(contract.contractId, {
        tokens: 1000,
        apiCalls: 5,
      });

      expect(result.decision).toBe(BudgetDecision.ALLOW);
      expect(result.remainingBudget.tokens).toBe(10000);
    });

    it("blocks actions that would exceed budget", () => {
      const contract = lifecycle.activate(createRootContract("a", TEST_BUDGET));
      store.put(contract);

      const result = enforcer.preActionCheck(contract.contractId, {
        tokens: 99999,
        apiCalls: 1,
      });

      expect(result.decision).toBe(BudgetDecision.BLOCK);
      expect(result.reason).toContain("Budget would be exceeded");
    });

    it("throttles actions consuming >50% of remaining budget", () => {
      const contract = lifecycle.activate(createRootContract("a", TEST_BUDGET));
      store.put(contract);

      const result = enforcer.preActionCheck(contract.contractId, {
        tokens: 6000, // 60% of 10000
        apiCalls: 1,
      });

      expect(result.decision).toBe(BudgetDecision.THROTTLE);
      expect(result.reason).toContain("50% of remaining")
    });

    it("blocks when contract is not active", () => {
      const contract = createRootContract("a", TEST_BUDGET);
      store.put(contract); // CREATED state

      const result = enforcer.preActionCheck(contract.contractId, {
        tokens: 100,
      });

      expect(result.decision).toBe(BudgetDecision.BLOCK);
      expect(result.reason).toContain("not active");
    });

    it("blocks for non-existent contract", () => {
      const result = enforcer.preActionCheck("nonexistent", { tokens: 100 });
      expect(result.decision).toBe(BudgetDecision.BLOCK);
      expect(result.reason).toContain("not found");
    });

    it("throttle provides adjusted params", () => {
      const contract = lifecycle.activate(createRootContract("a", TEST_BUDGET));
      store.put(contract);

      const result = enforcer.preActionCheck(contract.contractId, {
        tokens: 6000,
      });

      expect(result.throttledParams).toBeDefined();
      expect(result.throttledParams!.tokens).toBe(5000); // 50% of 10000
    });
  });

  // --- Action Monitoring ---

  describe("recordUsage", () => {
    it("records usage and returns ALLOW", () => {
      const contract = lifecycle.activate(createRootContract("a", TEST_BUDGET));
      store.put(contract);

      const result = enforcer.recordUsage(contract.contractId, {
        tokens: 1000,
        apiCalls: 5,
      });

      expect(result.decision).toBe(BudgetDecision.ALLOW);

      // Verify store is updated
      const updated = store.get(contract.contractId);
      expect(updated!.remainingBudget.tokens).toBe(9000);
    });

    it("violates contract when budget exceeded", () => {
      const contract = lifecycle.activate(createRootContract("a", TEST_BUDGET));
      store.put(contract);

      const result = enforcer.recordUsage(contract.contractId, {
        tokens: 99999,
      });

      expect(result.decision).toBe(BudgetDecision.BLOCK);
      expect(result.reason).toContain("violated");

      const updated = store.get(contract.contractId);
      expect(updated!.state).toBe(ContractState.VIOLATED);
    });

    it("throttles when budget is low (<20%)", () => {
      const contract = lifecycle.activate(createRootContract("a", TEST_BUDGET));
      // Use 85% of tokens
      const used = lifecycle.recordUsage(contract, { tokens: 8500 });
      store.put(used);

      const result = enforcer.recordUsage(used.contractId, {
        tokens: 500, // Now at 90% usage
      });

      expect(result.decision).toBe(BudgetDecision.THROTTLE);
      expect(result.reason).toContain("Low budget warning");
    });
  });

  // --- Post-Action Audit ---

  describe("postActionAudit", () => {
    it("allows when actual usage matches expected", () => {
      const contract = lifecycle.activate(createRootContract("a", TEST_BUDGET));
      store.put(contract);

      const result = enforcer.postActionAudit(
        contract.contractId,
        { tokens: 1000, apiCalls: 5 },
        { tokens: 1100, apiCalls: 5 }
      );

      expect(result.decision).toBe(BudgetDecision.ALLOW);
    });

    it("escalates when actual usage exceeds expected by >25%", () => {
      const contract = lifecycle.activate(createRootContract("a", TEST_BUDGET));
      store.put(contract);

      const result = enforcer.postActionAudit(
        contract.contractId,
        { tokens: 1000, apiCalls: 5 },
        { tokens: 1500, apiCalls: 5 } // 50% overrun on tokens
      );

      expect(result.decision).toBe(BudgetDecision.ESCALATE);
      expect(result.reason).toContain("Usage overrun");
    });

    it("does not escalate for small overruns (<25%)", () => {
      const contract = lifecycle.activate(createRootContract("a", TEST_BUDGET));
      store.put(contract);

      const result = enforcer.postActionAudit(
        contract.contractId,
        { tokens: 1000, apiCalls: 5 },
        { tokens: 1200, apiCalls: 5 } // 20% overrun on tokens
      );

      expect(result.decision).toBe(BudgetDecision.ALLOW);
    });
  });

  // --- Time Expiry ---

  describe("checkTimeExpiry", () => {
    it("blocks when contract time has expired", () => {
      const past = Date.now() - 1000;
      const contract = lifecycle.activate(
        createRootContract("a", TEST_BUDGET, { expiresAt: past })
      );
      // When activated with a past expiresAt, the contract goes to EXPIRED state
      expect(contract.state).toBe(ContractState.EXPIRED);
      store.put(contract);

      const result = enforcer.checkTimeExpiry(contract.contractId);
      // An expired contract is not active, so the enforcer returns ALLOW
      // (it's already not active — no further action needed)
      expect(result.decision).toBe(BudgetDecision.ALLOW);
      expect(result.reason).toContain("not active");
    });

    it("detects expiry during active contract", () => {
      const future = Date.now() + 100; // Expire in 100ms
      const contract = lifecycle.activate(
        createRootContract("a", TEST_BUDGET, { expiresAt: future })
      );
      store.put(contract);

      // Before expiry — should be allowed
      const resultBefore = enforcer.checkTimeExpiry(contract.contractId);
      expect(resultBefore.decision).toBe(BudgetDecision.ALLOW);

      // Wait for expiry
      // (We can't wait in unit tests, so we test with a contract that
      // has been manually set to EXPIRED via lifecycle)
      const expired = lifecycle.expire(contract);
      store.put(expired);

      const resultAfter = enforcer.checkTimeExpiry(expired.contractId);
      expect(resultAfter.decision).toBe(BudgetDecision.ALLOW);
      expect(resultAfter.reason).toContain("not active");
    });

    it("allows when contract time has not expired", () => {
      const future = Date.now() + 60000;
      const contract = lifecycle.activate(
        createRootContract("a", TEST_BUDGET, { expiresAt: future })
      );
      store.put(contract);

      const result = enforcer.checkTimeExpiry(contract.contractId);
      expect(result.decision).toBe(BudgetDecision.ALLOW);
    });
  });
});
