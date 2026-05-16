/**
 * Example: Multi-Agent Code Review with Budget Governance.
 *
 * Demonstrates how to use SARC Budget Governance to manage a multi-agent
 * code review pipeline with hierarchical budget delegation.
 *
 * Architecture:
 *   Root Agent (10K tokens)
 *   ├── Security Reviewer (4K tokens)
 *   │   ├── Dependency Scanner (1.5K tokens)
 *   │   └── Code Auditor (1.5K tokens)
 *   ├── Style Reviewer (2K tokens)
 *   └── Performance Reviewer (2K tokens)
 */

import {
  ResourceBudget,
  AgentContract,
  ContractState,
} from "../src/contracts/types.js";
import { lifecycle } from "../src/contracts/lifecycle.js";
import { ContractStore } from "../src/contracts/conservation.js";
import { BudgetEnforcer, BudgetDecision } from "../src/governance/budget-enforcer.js";
import {
  DelegationManager,
  DelegationStrategy,
} from "../src/governance/delegation.js";
import { SarcBudgetBridge } from "../src/integration/sarc-bridge.js";
import { AdaptOrchBudgetAdapter, TopologyKind } from "../src/integration/adaptorch-adapter.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const ROOT_BUDGET: ResourceBudget = {
  tokens: 10000,
  wallClockMs: 120000, // 2 minutes
  apiCalls: 50,
  memoryBytes: 10 * 1024 * 1024, // 10 MB
};

function main() {
  console.log("🛡️  SARC Budget Governance — Multi-Agent Code Review Example");
  console.log("=".repeat(60));
  console.log();

  // --- 1. Create the governed system ---
  const store = new ContractStore();
  const bridge = new SarcBudgetBridge(store);
  const delegator = new DelegationManager(store);
  const enforcer = new BudgetEnforcer(store);
  const topologyAdapter = new AdaptOrchBudgetAdapter(store);

  // Create root agent with budget
  const { contract: rootContract, constraints } = bridge.createGovernedAgent(
    "code-review-orchestrator",
    ROOT_BUDGET
  );

  console.log(`✅ Root agent created: ${rootContract.contractId}`);
  console.log(`   Budget: ${ROOT_BUDGET.tokens} tokens, ${ROOT_BUDGET.apiCalls} API calls`);
  console.log(`   SARC constraints: ${constraints.length}`);
  console.log();

  // --- 2. Delegate to sub-agents ---
  console.log("📊 Delegating budgets to sub-agents...");

  // Security reviewer gets the largest share
  const secResult = delegator.delegateSingle(
    rootContract.contractId,
    "security-reviewer",
    { tokens: 4000, wallClockMs: 60000, apiCalls: 20, memoryBytes: 4 * 1024 * 1024 }
  );

  if (secResult.success) {
    console.log(`  ✅ Security reviewer: ${secResult.childContracts[0].contractId}`);

    // Sub-delegate to dependency scanner
    const depResult = delegator.delegateSingle(
      secResult.childContracts[0].contractId,
      "dependency-scanner",
      { tokens: 1500, wallClockMs: 20000, apiCalls: 8, memoryBytes: 1024 * 1024 }
    );
    if (depResult.success) {
      console.log(`    ✅ Dependency scanner: ${depResult.childContracts[0].contractId}`);
    }

    // Sub-delegate to code auditor
    const auditResult = delegator.delegateSingle(
      secResult.childContracts[0].contractId,
      "code-auditor",
      { tokens: 1500, wallClockMs: 20000, apiCalls: 8, memoryBytes: 1024 * 1024 }
    );
    if (auditResult.success) {
      console.log(`    ✅ Code auditor: ${auditResult.childContracts[0].contractId}`);
    }
  }

  // Style reviewer
  const styleResult = delegator.delegateSingle(
    rootContract.contractId,
    "style-reviewer",
    { tokens: 2000, wallClockMs: 30000, apiCalls: 10, memoryBytes: 2 * 1024 * 1024 }
  );
  if (styleResult.success) {
    console.log(`  ✅ Style reviewer: ${styleResult.childContracts[0].contractId}`);
  }

  // Performance reviewer
  const perfResult = delegator.delegateSingle(
    rootContract.contractId,
    "performance-reviewer",
    { tokens: 2000, wallClockMs: 30000, apiCalls: 10, memoryBytes: 2 * 1024 * 1024 }
  );
  if (perfResult.success) {
    console.log(`  ✅ Performance reviewer: ${perfResult.childContracts[0].contractId}`);
  }

  console.log();

  // --- 3. Verify conservation laws ---
  const conservationProof = store.verifyAllConservation();
  console.log(`🔒 Conservation law verification: ${conservationProof.conserved ? "✅ PASSED" : "❌ FAILED"}`);
  console.log();

  // --- 4. Check topology recommendation ---
  const topology = topologyAdapter.route(rootContract.contractId);
  console.log(`🔀 Recommended topology: ${topology.topology}`);
  console.log(`   Max agents: ${topology.maxAgents}`);
  console.log(`   Budget constrained: ${topology.budgetConstrained}`);
  console.log();

  // --- 5. Simulate execution with budget enforcement ---
  console.log("⚡ Simulating agent execution with budget enforcement...");
  console.log();

  // Simulate security reviewer consuming tokens
  const secContract = secResult.success ? secResult.childContracts[0] : null;
  if (secContract) {
    // Pre-action check
    const preCheck = enforcer.preActionCheck(secContract.contractId, {
      tokens: 800,
      apiCalls: 3,
    });
    console.log(`  Security reviewer pre-check: ${preCheck.decision} (${preCheck.reason})`);

    if (preCheck.decision === BudgetDecision.ALLOW) {
      const usageResult = enforcer.recordUsage(secContract.contractId, {
        tokens: 800,
        apiCalls: 3,
      });
      console.log(`  Security reviewer used 800 tokens. Remaining: ${usageResult.remainingBudget.tokens}`);

      // Post-action audit: expected 800, actual 850 (6% overrun — within tolerance)
      const audit = enforcer.postActionAudit(
        secContract.contractId,
        { tokens: 800, apiCalls: 3 },
        { tokens: 850, apiCalls: 3 }
      );
      console.log(`  Audit: ${audit.decision} (${audit.reason})`);
    }
  }

  // Simulate dependency scanner
  const depContract = store.all().find((c) => c.agentId === "dependency-scanner");
  if (depContract) {
    const preCheck = enforcer.preActionCheck(depContract.contractId, {
      tokens: 1200,
      apiCalls: 5,
    });
    console.log(`  Dependency scanner pre-check: ${preCheck.decision} (${preCheck.reason})`);

    if (preCheck.decision === BudgetDecision.ALLOW) {
      enforcer.recordUsage(depContract.contractId, { tokens: 1200, apiCalls: 5 });
    }
  }

  console.log();

  // --- 6. Final status ---
  console.log("📋 Final Contract Status:");
  for (const contract of store.all()) {
    const utilization = contract.budget.tokens > 0
      ? ((contract.usedBudget.tokens / contract.budget.tokens) * 100).toFixed(1)
      : "0.0";
    console.log(
      `  ${contract.agentId}: ${contract.state} | ` +
      `${contract.usedBudget.tokens}/${contract.budget.tokens} tokens (${utilization}%)`
    );
  }

  console.log();

  // --- 7. Final conservation check ---
  const finalProof = store.verifyAllConservation();
  console.log(`🔒 Final conservation check: ${finalProof.conserved ? "✅ PASSED" : "❌ FAILED"}`);
  console.log();
  console.log("Done! Budget governance ensured efficient resource usage across all agents.");
}

main();
