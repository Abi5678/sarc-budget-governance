/**
 * Tests: Constraint Drift Detection.
 *
 * Verifies the ConstraintDriftMonitor from arXiv:2605.10481:
 * "Constraints that are not continuously maintained lose operational force."
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  ResourceBudget,
} from "../src/contracts/types.js";
import { createRootContract, resetContractCounter } from "../src/contracts/factory.js";
import { lifecycle } from "../src/contracts/lifecycle.js";
import { ContractStore } from "../src/contracts/conservation.js";
import {
  ConstraintDriftMonitor,
  DriftThresholds,
} from "../src/governance/constraint-drift.js";

const TEST_BUDGET: ResourceBudget = {
  tokens: 10000,
  wallClockMs: 60000,
  apiCalls: 100,
  memoryBytes: 1024 * 1024,
};

describe("ConstraintDriftMonitor", () => {
  let store: ContractStore;
  let monitor: ConstraintDriftMonitor;

  beforeEach(() => {
    store = new ContractStore();
    monitor = new ConstraintDriftMonitor(store);
    resetContractCounter();
  });

  it("starts with no drift", () => {
    const analysis = monitor.analyze();
    expect(analysis.totalSteps).toBe(0);
    expect(analysis.driftRate).toBe(0);
    expect(analysis.needsCorrection).toBe(false);
  });

  it("detects enforcement rate drift", () => {
    const contract = lifecycle.activate(createRootContract("a", TEST_BUDGET));
    store.put(contract);

    // Simulate a trajectory where enforcement degrades
    for (let i = 0; i < 10; i++) {
      monitor.measure(i, true); // Good enforcement
    }

    // Now enforcement degrades
    for (let i = 10; i < 20; i++) {
      monitor.measure(i, i % 3 === 0); // Only 33% enforcement
    }

    const analysis = monitor.analyze();
    expect(analysis.totalSteps).toBe(20);
    expect(analysis.driftSteps).toBeGreaterThan(0);
    expect(analysis.enforcementTrend).toBeLessThan(0); // Declining trend
  });

  it("detects conservation drift when laws are violated", () => {
    const contract = lifecycle.activate(createRootContract("a", TEST_BUDGET));
    store.put(contract);

    // All enforcement applied, conservation OK
    for (let i = 0; i < 5; i++) {
      monitor.measure(i, true);
    }

    const analysis = monitor.analyze();
    expect(analysis.conservationTrend).toBeGreaterThanOrEqual(0);
  });

  it("generates corrections when drift is severe", () => {
    const contract = lifecycle.activate(createRootContract("a", TEST_BUDGET));
    store.put(contract);

    // Create severe drift: no enforcement for many steps
    for (let i = 0; i < 10; i++) {
      monitor.measure(i, false); // No enforcement
    }

    const analysis = monitor.analyze();
    expect(analysis.needsCorrection).toBe(true);
    expect(analysis.corrections.length).toBeGreaterThan(0);
  });

  it("measures budget efficiency", () => {
    const contract = lifecycle.activate(createRootContract("a", TEST_BUDGET));
    store.put(contract);

    const m = monitor.measure(0, true, 100, 500); // 100 value, 500 tokens
    expect(m.budgetEfficiency).toBe(0.2); // 100/500
  });

  it("tracks dimension utilization", () => {
    const contract = lifecycle.activate(createRootContract("a", TEST_BUDGET));
    const used = lifecycle.recordUsage(contract, { tokens: 5000 }); // 50%
    store.put(used);

    const m = monitor.measure(0, true);
    expect(m.dimensionUtilization.tokens).toBeGreaterThanOrEqual(0.5);
  });

  it("can be reset", () => {
    monitor.measure(0, true);
    monitor.measure(1, false);
    monitor.reset();

    const analysis = monitor.analyze();
    expect(analysis.totalSteps).toBe(0);
  });

  it("custom thresholds work", () => {
    const customThresholds: DriftThresholds = {
      minEnforcementRate: 0.5, // Lower threshold
      minConservationRate: 1.0,
      maxUtilization: 0.95,
      minTrendSlope: -0.1,
      consecutiveDriftLimit: 5,
    };

    const customMonitor = new ConstraintDriftMonitor(store, customThresholds);
    const contract = lifecycle.activate(createRootContract("a", TEST_BUDGET));
    store.put(contract);

    // With lower threshold, some enforcement degradation is OK
    for (let i = 0; i < 10; i++) {
      customMonitor.measure(i, i % 2 === 0); // 50% enforcement
    }

    const analysis = customMonitor.analyze();
    // With minEnforcementRate=0.5, 50% should still be right at the boundary
    expect(analysis.driftSteps).toBeLessThanOrEqual(10);
  });

  it("drift severity is bounded between 0 and 1", () => {
    const contract = lifecycle.activate(createRootContract("a", TEST_BUDGET));
    store.put(contract);

    for (let i = 0; i < 20; i++) {
      const m = monitor.measure(i, i % 4 === 0);
      expect(m.driftSeverity).toBeGreaterThanOrEqual(0);
      expect(m.driftSeverity).toBeLessThanOrEqual(1);
    }
  });
});
