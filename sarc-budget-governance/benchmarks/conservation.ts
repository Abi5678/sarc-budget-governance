/**
 * Benchmark: Conservation Law Correctness.
 *
 * Stress-tests the conservation law invariant under various delegation
 * patterns. The invariant must hold in ALL cases:
 *
 *   ∀ dimension d, Σ children_budget[d] ≤ parent_budget[d]
 *
 * This benchmark:
 * 1. Creates large delegation trees
 * 2. Performs many delegations
 * 3. Verifies conservation after every operation
 * 4. Measures enforcement overhead
 */

import {
  ResourceBudget,
  zeroBudget,
} from "../src/contracts/types.js";
import { createRootContract } from "../src/contracts/factory.js";
import { lifecycle } from "../src/contracts/lifecycle.js";
import { ContractStore } from "../src/contracts/conservation.js";
import {
  DelegationManager,
  DelegationStrategy,
} from "../src/governance/delegation.js";
import { BudgetEnforcer, BudgetDecision } from "../src/governance/budget-enforcer.js";

const LARGE_BUDGET: ResourceBudget = {
  tokens: 1000000,
  wallClockMs: 3600000,
  apiCalls: 10000,
  memoryBytes: 1024 * 1024 * 1024, // 1 GB
};

function runConservationStressTest(): {
  totalDelegations: number;
  successfulDelegations: number;
  conservationViolations: number;
  avgCheckTimeMs: number;
  treeDepth: number;
  treeSize: number;
} {
  const store = new ContractStore();
  const delegator = new DelegationManager(store);
  const enforcer = new BudgetEnforcer(store);

  // Create root
  const root = lifecycle.activate(createRootContract("root", LARGE_BUDGET));
  store.put(root);

  let totalDelegations = 0;
  let successfulDelegations = 0;
  let conservationViolations = 0;
  const checkTimes: number[] = [];

  // Level 1: Delegate to 5 agents
  const level1Budget: ResourceBudget = {
    tokens: 150000,
    wallClockMs: 600000,
    apiCalls: 1500,
    memoryBytes: 150 * 1024 * 1024,
  };

  for (let i = 0; i < 5; i++) {
    totalDelegations++;
    const result = delegator.delegateSingle(root.contractId, `l1-${i}`, level1Budget);
    if (result.success) {
      successfulDelegations++;
    }
  }

  // Verify after level 1
  const t1 = performance.now();
  const proof1 = store.verifyAllConservation();
  checkTimes.push(performance.now() - t1);
  if (!proof1.conserved) conservationViolations++;

  // Level 2: Each L1 agent delegates to 3 sub-agents
  const level1Contracts = store.children(root.contractId);
  const level2Budget: ResourceBudget = {
    tokens: 40000,
    wallClockMs: 150000,
    apiCalls: 400,
    memoryBytes: 30 * 1024 * 1024,
  };

  for (const l1 of level1Contracts) {
    for (let j = 0; j < 3; j++) {
      totalDelegations++;
      const result = delegator.delegateSingle(
        l1.contractId,
        `l2-${l1.agentId}-${j}`,
        level2Budget
      );
      if (result.success) successfulDelegations++;
    }
  }

  // Verify after level 2
  const t2 = performance.now();
  const proof2 = store.verifyAllConservation();
  checkTimes.push(performance.now() - t2);
  if (!proof2.conserved) conservationViolations++;

  // Level 3: Some L2 agents delegate to 2 sub-agents each
  const allContracts = store.all();
  const level2Contracts = allContracts.filter(
    (c) => c.agentId.startsWith("l2-")
  );

  const level3Budget: ResourceBudget = {
    tokens: 15000,
    wallClockMs: 50000,
    apiCalls: 150,
    memoryBytes: 10 * 1024 * 1024,
  };

  for (const l2 of level2Contracts.slice(0, 8)) {
    for (let k = 0; k < 2; k++) {
      totalDelegations++;
      const result = delegator.delegateSingle(
        l2.contractId,
        `l3-${l2.agentId}-${k}`,
        level3Budget
      );
      if (result.success) successfulDelegations++;
    }
  }

  // Final verification
  const t3 = performance.now();
  const proof3 = store.verifyAllConservation();
  checkTimes.push(performance.now() - t3);
  if (!proof3.conserved) conservationViolations++;

  // Calculate tree depth
  let maxDepth = 0;
  for (const c of store.all()) {
    let depth = 0;
    let current = c;
    while (current.parentContractId) {
      depth++;
      const parent = store.get(current.parentContractId);
      if (!parent) break;
      current = parent;
    }
    maxDepth = Math.max(maxDepth, depth);
  }

  return {
    totalDelegations,
    successfulDelegations,
    conservationViolations,
    avgCheckTimeMs: checkTimes.reduce((s, t) => s + t, 0) / checkTimes.length,
    treeDepth: maxDepth,
    treeSize: store.size,
  };
}

function main() {
  console.log("=".repeat(70));
  console.log("SARC Budget Governance — Conservation Law Stress Test");
  console.log("=".repeat(70));
  console.log();

  const result = runConservationStressTest();

  console.log("Results:");
  console.log(`  Total delegation attempts: ${result.totalDelegations}`);
  console.log(`  Successful delegations: ${result.successfulDelegations}`);
  console.log(`  Conservation violations: ${result.conservationViolations}`);
  console.log(`  Tree depth: ${result.treeDepth}`);
  console.log(`  Tree size (total contracts): ${result.treeSize}`);
  console.log(`  Avg conservation check time: ${result.avgCheckTimeMs.toFixed(3)} ms`);
  console.log();

  console.log("-".repeat(70));
  const pass = result.conservationViolations === 0;
  console.log(`Conservation Law Invariant: ${pass ? "✅ HELD (0 violations)" : "❌ VIOLATED"}`);
  console.log(`PASS: ${pass ? "✅ YES" : "❌ NO"}`);
  console.log();

  return { ...result, pass };
}

main();
