/**
 * SARC Budget Governance — Contract Factory.
 *
 * Creates AgentContract instances with proper initialization,
 * budget allocation, and conservation-law-safe defaults.
 */

import {
  AgentContract,
  AuditEntry,
  ContractState,
  ResourceBudget,
  ResourceUsage,
  SuccessCriteria,
  zeroBudget,
} from "./types.js";

let contractCounter = 0;

/** Generate a unique contract ID */
export function generateContractId(prefix = "contract"): string {
  contractCounter++;
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${ts}-${rand}-${contractCounter}`;
}

/** Reset the contract counter (for testing) */
export function resetContractCounter(): void {
  contractCounter = 0;
}

/**
 * Options for creating a new contract.
 */
export interface CreateContractOptions {
  agentId: string;
  budget: ResourceBudget;
  parentContractId?: string;
  successCriteria?: SuccessCriteria;
  maxDelegationDepth?: number;
  currentDelegationDepth?: number;
  expiresAt?: number | null;
  tags?: string[];
}

/**
 * Create a new AgentContract in CREATED state.
 *
 * The contract must be explicitly activated before budget enforcement begins.
 */
export function createContract(options: CreateContractOptions): AgentContract {
  const now = Date.now();
  const contractId = generateContractId();

  const contract: AgentContract = {
    contractId,
    agentId: options.agentId,
    parentContractId: options.parentContractId ?? null,
    state: ContractState.CREATED,
    budget: { ...options.budget },
    remainingBudget: { ...options.budget },
    usedBudget: zeroBudget(),
    successCriteria: options.successCriteria ?? {},
    maxDelegationDepth: options.maxDelegationDepth ?? 3,
    currentDelegationDepth: options.currentDelegationDepth ?? 0,
    createdAt: now,
    activatedAt: null,
    terminatedAt: null,
    expiresAt: options.expiresAt ?? null,
    auditTrail: [
      {
        timestamp: now,
        fromState: ContractState.CREATED,
        toState: ContractState.CREATED,
        reason: "Contract created",
        remainingBudget: { ...options.budget },
      },
    ],
    childContractIds: [],
    tags: options.tags ?? [],
  };

  return contract;
}

/**
 * Create a root contract (no parent, depth 0).
 */
export function createRootContract(
  agentId: string,
  budget: ResourceBudget,
  options?: Partial<CreateContractOptions>
): AgentContract {
  return createContract({
    agentId,
    budget,
    parentContractId: undefined,
    maxDelegationDepth: 3,
    currentDelegationDepth: 0,
    ...options,
  });
}

/**
 * Create a child contract from a delegation request.
 *
 * Validates that the requested budget fits within the parent's remaining
 * budget (conservation law pre-check). Does NOT register the child
 * with the parent — that's done by the DelegationManager.
 *
 * @throws Error if budget exceeds parent's remaining budget
 */
export function createChildContract(
  parent: AgentContract,
  childAgentId: string,
  requestedBudget: ResourceBudget,
  options?: Partial<CreateContractOptions>
): AgentContract {
  // Conservation pre-check
  const violations: string[] = [];
  if (requestedBudget.tokens > parent.remainingBudget.tokens) {
    violations.push(
      `tokens: requested ${requestedBudget.tokens} > remaining ${parent.remainingBudget.tokens}`
    );
  }
  if (requestedBudget.wallClockMs > parent.remainingBudget.wallClockMs) {
    violations.push(
      `wallClockMs: requested ${requestedBudget.wallClockMs} > remaining ${parent.remainingBudget.wallClockMs}`
    );
  }
  if (requestedBudget.apiCalls > parent.remainingBudget.apiCalls) {
    violations.push(
      `apiCalls: requested ${requestedBudget.apiCalls} > remaining ${parent.remainingBudget.apiCalls}`
    );
  }
  if (requestedBudget.memoryBytes > parent.remainingBudget.memoryBytes) {
    violations.push(
      `memoryBytes: requested ${requestedBudget.memoryBytes} > remaining ${parent.remainingBudget.memoryBytes}`
    );
  }

  if (violations.length > 0) {
    throw new Error(
      `Conservation violation: child budget exceeds parent remaining budget.\n${violations.join("\n")}`
    );
  }

  // Delegation depth check
  if (parent.currentDelegationDepth >= parent.maxDelegationDepth) {
    throw new Error(
      `Max delegation depth (${parent.maxDelegationDepth}) reached. Cannot delegate further.`
    );
  }

  return createContract({
    agentId: childAgentId,
    budget: requestedBudget,
    parentContractId: parent.contractId,
    maxDelegationDepth: parent.maxDelegationDepth,
    currentDelegationDepth: parent.currentDelegationDepth + 1,
    ...options,
  });
}
