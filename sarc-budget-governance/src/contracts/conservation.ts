/**
 * SARC Budget Governance — Conservation Law Enforcement.
 *
 * The core mathematical guarantee from arXiv:2601.08815:
 *
 *   Conservation Law: ∀ dimension d, Σ children_budget[d] ≤ parent_budget[d]
 *
 * This is NOT a heuristic — it's a structural invariant enforced at
 * delegation time and verified continuously.
 *
 * Key properties:
 * 1. Conservation is checked BEFORE delegation is accepted
 * 2. Violations are detected immediately, not retroactively
 * 3. The proof is constructively verifiable (O(n) in tree size)
 * 4. Circular delegation is impossible (depth-bounded)
 */

import {
  AgentContract,
  ConservationProof,
  ConservationViolation,
  DelegationRequest,
  ResourceBudget,
  ResourceDimension,
  RESOURCE_DIMENSIONS,
  addBudgets,
  zeroBudget,
} from "./types.js";

// ---------------------------------------------------------------------------
// Contract Store — In-memory tree of contracts
// ---------------------------------------------------------------------------

/**
 * In-memory store of contracts with parent-child relationships.
 * Supports conservation law verification across the delegation tree.
 */
export class ContractStore {
  private contracts = new Map<string, AgentContract>();

  /** Register a contract in the store */
  put(contract: AgentContract): void {
    this.contracts.set(contract.contractId, { ...contract });
  }

  /** Retrieve a contract by ID */
  get(contractId: string): AgentContract | undefined {
    return this.contracts.get(contractId);
  }

  /** Remove a contract from the store */
  delete(contractId: string): void {
    this.contracts.delete(contractId);
  }

  /** Get all contracts */
  all(): AgentContract[] {
    return Array.from(this.contracts.values());
  }

  /** Get children of a contract */
  children(parentContractId: string): AgentContract[] {
    return this.all().filter(
      (c) => c.parentContractId === parentContractId
    );
  }

  /** Get root contracts (no parent) */
  roots(): AgentContract[] {
    return this.all().filter((c) => c.parentContractId === null);
  }

  /** Get contract count */
  get size(): number {
    return this.contracts.size;
  }

  /** Clear all contracts */
  clear(): void {
    this.contracts.clear();
  }

  // --- Conservation Law Verification ---

  /**
   * Verify conservation laws for a specific parent and its children.
   *
   * Returns a ConservationProof that is constructively verifiable.
   */
  verifyConservation(parentContractId: string): ConservationProof {
    const parent = this.contracts.get(parentContractId);
    if (!parent) {
      return {
        conserved: true,
        dimensions: this.emptyDimensionRecord(parentContractId),
        violations: [],
      };
    }

    const children = this.children(parentContractId);
    const violations: ConservationViolation[] = [];
    const dimensionResults: ConservationProof["dimensions"] = {} as any;

    for (const dim of RESOURCE_DIMENSIONS) {
      const parentBudget = parent.budget[dim];
      const childrenSum = children.reduce(
        (sum, child) => sum + child.budget[dim],
        0
      );
      const slack = parentBudget - childrenSum;
      const conserved = slack >= 0;

      dimensionResults[dim] = {
        parentBudget,
        childrenSum,
        slack,
        overshoot: conserved ? 0 : childrenSum - parentBudget,
        conserved,
      };

      if (!conserved) {
        violations.push({
          dimension: dim,
          parentBudget,
          childrenSum,
          overshoot: childrenSum - parentBudget,
          parentContractId,
          childContractIds: children.map((c) => c.contractId),
        });
      }
    }

    return {
      conserved: violations.length === 0,
      dimensions: dimensionResults,
      violations,
    };
  }

  /**
   * Verify conservation laws across the ENTIRE contract tree.
   *
   * Every parent-child relationship is checked. Returns all violations.
   */
  verifyAllConservation(): ConservationProof & { perParent: Map<string, ConservationProof> } {
    const perParent = new Map<string, ConservationProof>();
    const allViolations: ConservationViolation[] = [];

    // Check every contract that has children
    const parentIds = new Set<string>();
    for (const contract of this.all()) {
      if (contract.parentContractId !== null) {
        parentIds.add(contract.parentContractId);
      }
    }

    let globallyConserved = true;

    for (const parentId of parentIds) {
      const proof = this.verifyConservation(parentId);
      perParent.set(parentId, proof);
      if (!proof.conserved) {
        globallyConserved = false;
        allViolations.push(...proof.violations);
      }
    }

    // Aggregate dimensions
    const aggregateDimensions: ConservationProof["dimensions"] = {} as any;
    for (const dim of RESOURCE_DIMENSIONS) {
      // Use the root-level proof as the canonical check
      const roots = this.roots();
      if (roots.length > 0) {
        const rootBudget = roots.reduce((s, r) => s + r.budget[dim], 0);
        const allNonRootBudget = this.all()
          .filter((c) => c.parentContractId !== null)
          .reduce((s, c) => s + c.budget[dim], 0);
        // Root budget should cover all delegated budgets
        const totalChildSums = Array.from(perParent.values()).reduce(
          (s, proof) => s + proof.dimensions[dim].childrenSum,
          0
        );
        aggregateDimensions[dim] = {
          parentBudget: rootBudget,
          childrenSum: totalChildSums,
          slack: rootBudget - totalChildSums,
          conserved: rootBudget >= totalChildSums,
        };
      } else {
        aggregateDimensions[dim] = {
          parentBudget: 0,
          childrenSum: 0,
          slack: 0,
          conserved: true,
        };
      }
    }

    return {
      conserved: globallyConserved,
      dimensions: aggregateDimensions,
      violations: allViolations,
      perParent,
    };
  }

  /**
   * Check whether a delegation request would violate conservation.
   *
   * This is the pre-flight check BEFORE delegation is accepted.
   * Returns true if the delegation is safe.
   */
  canDelegate(request: DelegationRequest): {
    allowed: boolean;
    reason?: string;
    proof: ConservationProof;
  } {
    const parent = this.contracts.get(request.parentContractId);
    if (!parent) {
      return {
        allowed: false,
        reason: `Parent contract ${request.parentContractId} not found`,
        proof: {
          conserved: false,
          dimensions: this.emptyDimensionRecord(request.parentContractId),
          violations: [],
        },
      };
    }

    // Check each dimension
    const existingChildren = this.children(request.parentContractId);
    const violations: ConservationViolation[] = [];
    const dimensionResults: ConservationProof["dimensions"] = {} as any;

    for (const dim of RESOURCE_DIMENSIONS) {
      const parentBudget = parent.budget[dim];
      const existingChildSum = existingChildren.reduce(
        (s, c) => s + c.budget[dim],
        0
      );
      const childrenSum = existingChildSum + request.requestedBudget[dim];
      const slack = parentBudget - childrenSum;
      const conserved = slack >= 0;

      dimensionResults[dim] = {
        parentBudget,
        childrenSum,
        slack,
        overshoot: conserved ? 0 : childrenSum - parentBudget,
        conserved,
      };

      if (!conserved) {
        violations.push({
          dimension: dim,
          parentBudget,
          childrenSum,
          overshoot: childrenSum - parentBudget,
          parentContractId: request.parentContractId,
          childContractIds: [
            ...existingChildren.map((c) => c.contractId),
            "(pending)",
          ],
        });
      }
    }

    // Check remaining budget (not just total budget)
    const remainingViolations: string[] = [];
    for (const dim of RESOURCE_DIMENSIONS) {
      if (request.requestedBudget[dim] > parent.remainingBudget[dim]) {
        remainingViolations.push(
          `${dim}: requested ${request.requestedBudget[dim]} > remaining ${parent.remainingBudget[dim]}`
        );
      }
    }

    const proof: ConservationProof = {
      conserved: violations.length === 0 && remainingViolations.length === 0,
      dimensions: dimensionResults,
      violations,
    };

    if (remainingViolations.length > 0) {
      return {
        allowed: false,
        reason: `Insufficient remaining budget: ${remainingViolations.join("; ")}`,
        proof,
      };
    }

    if (violations.length > 0) {
      return {
        allowed: false,
        reason: `Conservation violation: total children budget exceeds parent`,
        proof,
      };
    }

    // Check delegation depth
    if (parent.currentDelegationDepth >= parent.maxDelegationDepth) {
      return {
        allowed: false,
        reason: `Max delegation depth (${parent.maxDelegationDepth}) reached`,
        proof,
      };
    }

    return { allowed: true, proof };
  }

  /**
   * Detect circular delegation in the contract tree.
   *
   * A cycle exists if any contract's ancestor chain includes itself.
   * With depth-bounded contracts, this should be impossible, but
   * we verify defensively.
   */
  detectCircularDelegation(): { hasCycle: boolean; cyclePath: string[] } {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const path: string[] = [];

    const dfs = (contractId: string): boolean => {
      visited.add(contractId);
      recursionStack.add(contractId);
      path.push(contractId);

      const contract = this.contracts.get(contractId);
      if (contract) {
        const children = this.children(contractId);
        for (const child of children) {
          if (!visited.has(child.contractId)) {
            if (dfs(child.contractId)) return true;
          } else if (recursionStack.has(child.contractId)) {
            path.push(child.contractId);
            return true;
          }
        }
      }

      recursionStack.delete(contractId);
      path.pop();
      return false;
    };

    for (const contract of this.all()) {
      if (!visited.has(contract.contractId)) {
        if (dfs(contract.contractId)) {
          return { hasCycle: true, cyclePath: [...path] };
        }
      }
    }

    return { hasCycle: false, cyclePath: [] };
  }

  // --- Helpers ---

  private emptyDimensionRecord(
    parentContractId: string
  ): ConservationProof["dimensions"] {
    const result: ConservationProof["dimensions"] = {} as any;
    for (const dim of RESOURCE_DIMENSIONS) {
      result[dim] = {
        parentBudget: 0,
        childrenSum: 0,
        slack: 0,
        overshoot: 0,
        conserved: true,
      };
    }
    return result;
  }
}
