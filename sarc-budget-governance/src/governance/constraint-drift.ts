/**
 * SARC Budget Governance — Constraint Drift Detection.
 *
 * Based on arXiv:2605.10481: "Constraint Drift" — safety constraints
 * lose operational force across agent trajectories. Continuous maintenance
 * is required to prevent degradation.
 *
 * This module monitors:
 * 1. Budget constraint enforcement rate over time
 * 2. Conservation law adherence trend
 * 3. Delegation quality degradation
 * 4. Token efficiency drift (output quality per token spent)
 */

import {
  AgentContract,
  ContractState,
  ResourceBudget,
  ResourceUsage,
  RESOURCE_DIMENSIONS,
  ResourceDimension,
} from "../contracts/types.js";
import { ContractStore } from "../contracts/conservation.js";

// ---------------------------------------------------------------------------
// Drift Metrics
// ---------------------------------------------------------------------------

/**
 * A single measurement point in the drift monitoring timeline.
 */
export interface DriftMeasurement {
  timestamp: number;
  stepNumber: number;
  /** Fraction of budget checks that actually enforced constraints */
  enforcementRate: number;
  /** Conservation law adherence rate across the tree */
  conservationAdherenceRate: number;
  /** Budget utilization efficiency (output value / tokens consumed) */
  budgetEfficiency: number;
  /** Per-dimension utilization (used / total) */
  dimensionUtilization: Record<ResourceDimension, number>;
  /** Whether drift was detected at this step */
  driftDetected: boolean;
  /** Drift severity (0 = no drift, 1 = severe) */
  driftSeverity: number;
}

/**
 * Summary of drift analysis over a trajectory.
 */
export interface DriftAnalysis {
  /** Total measurements taken */
  totalSteps: number;
  /** Steps where drift was detected */
  driftSteps: number;
  /** Overall drift rate (driftSteps / totalSteps) */
  driftRate: number;
  /** Average drift severity */
  avgSeverity: number;
  /** Maximum drift severity */
  maxSeverity: number;
  /** Enforcement rate trend: positive = improving, negative = degrading */
  enforcementTrend: number;
  /** Conservation adherence trend */
  conservationTrend: number;
  /** Whether corrective action is recommended */
  needsCorrection: boolean;
  /** Recommended corrective actions */
  corrections: DriftCorrection[];
}

export interface DriftCorrection {
  type: "enforcement_boost" | "conservation_recheck" | "budget_rebalance" | "escalate";
  description: string;
  severity: number;
  affectedDimensions: ResourceDimension[];
}

// ---------------------------------------------------------------------------
// Drift Thresholds
// ---------------------------------------------------------------------------

export interface DriftThresholds {
  /** Minimum acceptable enforcement rate (below = drift) */
  minEnforcementRate: number;
  /** Minimum acceptable conservation adherence rate */
  minConservationRate: number;
  /** Maximum allowed dimension utilization before drift warning */
  maxUtilization: number;
  /** Minimum enforcement rate trend slope (negative = drift) */
  minTrendSlope: number;
  /** Number of consecutive drift steps before correction is needed */
  consecutiveDriftLimit: number;
}

const DEFAULT_THRESHOLDS: DriftThresholds = {
  minEnforcementRate: 0.95,
  minConservationRate: 1.0, // Conservation must be 100%
  maxUtilization: 0.9,
  minTrendSlope: -0.05,
  consecutiveDriftLimit: 3,
};

// ---------------------------------------------------------------------------
// Constraint Drift Monitor
// ---------------------------------------------------------------------------

/**
 * Monitors constraint drift across agent trajectories.
 *
 * The monitor tracks enforcement rates, conservation adherence, and
 * budget utilization over time. When drift is detected, it generates
 * corrective recommendations.
 *
 * Key insight from arXiv:2605.10481:
 * "Constraints that are not continuously maintained lose operational force."
 * The monitor ensures continuous constraint maintenance.
 */
export class ConstraintDriftMonitor {
  private measurements: DriftMeasurement[] = [];
  private enforcementHistory: boolean[] = [];
  private consecutiveDriftCount = 0;

  constructor(
    private store: ContractStore,
    private thresholds: DriftThresholds = DEFAULT_THRESHOLDS
  ) {}

  /**
   * Take a drift measurement at the current step.
   *
   * Call this after each action/step to track drift over time.
   */
  measure(
    stepNumber: number,
    enforcementApplied: boolean,
    outputValue?: number,
    tokensConsumed?: number
  ): DriftMeasurement {
    this.enforcementHistory.push(enforcementApplied);

    // Calculate enforcement rate over recent window
    const windowSize = 10;
    const recentEnforcement = this.enforcementHistory.slice(-windowSize);
    const enforcementRate =
      recentEnforcement.filter(Boolean).length / recentEnforcement.length;

    // Check conservation across the entire tree
    const conservationResult = this.store.verifyAllConservation();
    const conservationAdherenceRate = conservationResult.conserved ? 1.0 : 0.0;

    // Calculate per-dimension utilization
    const dimensionUtilization = this.calculateDimensionUtilization();

    // Calculate budget efficiency
    const budgetEfficiency =
      outputValue && tokensConsumed ? outputValue / tokensConsumed : 0;

    // Detect drift
    const driftDetected =
      enforcementRate < this.thresholds.minEnforcementRate ||
      conservationAdherenceRate < this.thresholds.minConservationRate ||
      Object.values(dimensionUtilization).some(
        (u) => u > this.thresholds.maxUtilization
      );

    // Calculate drift severity (0 = no drift, 1 = severe)
    const driftSeverity = driftDetected
      ? this.calculateDriftSeverity(
          enforcementRate,
          conservationAdherenceRate,
          dimensionUtilization
        )
      : 0;

    // Track consecutive drift
    if (driftDetected) {
      this.consecutiveDriftCount++;
    } else {
      this.consecutiveDriftCount = 0;
    }

    const measurement: DriftMeasurement = {
      timestamp: Date.now(),
      stepNumber,
      enforcementRate,
      conservationAdherenceRate,
      budgetEfficiency,
      dimensionUtilization,
      driftDetected,
      driftSeverity,
    };

    this.measurements.push(measurement);
    return measurement;
  }

  /**
   * Analyze the full drift trajectory and generate recommendations.
   */
  analyze(): DriftAnalysis {
    if (this.measurements.length === 0) {
      return {
        totalSteps: 0,
        driftSteps: 0,
        driftRate: 0,
        avgSeverity: 0,
        maxSeverity: 0,
        enforcementTrend: 0,
        conservationTrend: 0,
        needsCorrection: false,
        corrections: [],
      };
    }

    const driftSteps = this.measurements.filter((m) => m.driftDetected).length;
    const driftRate = driftSteps / this.measurements.length;
    const avgSeverity =
      this.measurements.reduce((s, m) => s + m.driftSeverity, 0) /
      this.measurements.length;
    const maxSeverity = Math.max(...this.measurements.map((m) => m.driftSeverity));

    // Calculate trends (linear regression slope)
    const enforcementTrend = this.calculateTrend(
      this.measurements.map((m) => m.enforcementRate)
    );
    const conservationTrend = this.calculateTrend(
      this.measurements.map((m) => m.conservationAdherenceRate)
    );

    // Determine if correction is needed
    const needsCorrection =
      this.consecutiveDriftCount >= this.thresholds.consecutiveDriftLimit ||
      driftRate > 0.3 ||
      maxSeverity > 0.7;

    // Generate corrections
    const corrections = needsCorrection
      ? this.generateCorrections(enforcementTrend, conservationTrend)
      : [];

    return {
      totalSteps: this.measurements.length,
      driftSteps,
      driftRate,
      avgSeverity,
      maxSeverity,
      enforcementTrend,
      conservationTrend,
      needsCorrection,
      corrections,
    };
  }

  /**
   * Get all measurements taken so far.
   */
  getMeasurements(): DriftMeasurement[] {
    return [...this.measurements];
  }

  /**
   * Reset the monitor state.
   */
  reset(): void {
    this.measurements = [];
    this.enforcementHistory = [];
    this.consecutiveDriftCount = 0;
  }

  // --- Private helpers ---

  private calculateDimensionUtilization(): Record<ResourceDimension, number> {
    const utilization: Record<ResourceDimension, number> = {
      tokens: 0,
      wallClockMs: 0,
      apiCalls: 0,
      memoryBytes: 0,
    };

    const contracts = this.store.all();
    for (const contract of contracts) {
      for (const dim of RESOURCE_DIMENSIONS) {
        if (contract.budget[dim] > 0) {
          const used = contract.usedBudget[dim] ?? 0;
          utilization[dim] = Math.max(
            utilization[dim],
            used / contract.budget[dim]
          );
        }
      }
    }

    return utilization;
  }

  private calculateDriftSeverity(
    enforcementRate: number,
    conservationRate: number,
    utilization: Record<ResourceDimension, number>
  ): number {
    let severity = 0;

    // Enforcement rate degradation
    if (enforcementRate < this.thresholds.minEnforcementRate) {
      severity += (this.thresholds.minEnforcementRate - enforcementRate) * 2;
    }

    // Conservation violation (critical)
    if (conservationRate < 1.0) {
      severity += (1.0 - conservationRate) * 3;
    }

    // High utilization on any dimension
    for (const dim of RESOURCE_DIMENSIONS) {
      if (utilization[dim] > this.thresholds.maxUtilization) {
        severity += (utilization[dim] - this.thresholds.maxUtilization) * 1.5;
      }
    }

    return Math.min(severity, 1.0);
  }

  private calculateTrend(values: number[]): number {
    if (values.length < 2) return 0;

    const n = values.length;
    const xMean = (n - 1) / 2;
    const yMean = values.reduce((s, v) => s + v, 0) / n;

    let numerator = 0;
    let denominator = 0;

    for (let i = 0; i < n; i++) {
      numerator += (i - xMean) * (values[i] - yMean);
      denominator += (i - xMean) ** 2;
    }

    return denominator === 0 ? 0 : numerator / denominator;
  }

  private generateCorrections(
    enforcementTrend: number,
    conservationTrend: number
  ): DriftCorrection[] {
    const corrections: DriftCorrection[] = [];

    if (enforcementTrend < this.thresholds.minTrendSlope) {
      corrections.push({
        type: "enforcement_boost",
        description:
          "Enforcement rate is declining — increase budget check frequency or tighten thresholds",
        severity: Math.abs(enforcementTrend) * 10,
        affectedDimensions: ["tokens", "apiCalls"],
      });
    }

    if (conservationTrend < 0) {
      corrections.push({
        type: "conservation_recheck",
        description:
          "Conservation law adherence declining — re-verify delegation tree integrity",
        severity: Math.abs(conservationTrend) * 10,
        affectedDimensions: RESOURCE_DIMENSIONS.slice() as ResourceDimension[],
      });
    }

    // Check for high utilization
    const utilization = this.calculateDimensionUtilization();
    const highUtilDims = RESOURCE_DIMENSIONS.filter(
      (d) => utilization[d] > 0.85
    );
    if (highUtilDims.length > 0) {
      corrections.push({
        type: "budget_rebalance",
        description: `High utilization on ${highUtilDims.join(", ")} — consider rebalancing or increasing budget`,
        severity: 0.5,
        affectedDimensions: highUtilDims as ResourceDimension[],
      });
    }

    if (this.consecutiveDriftCount >= this.thresholds.consecutiveDriftLimit * 2) {
      corrections.push({
        type: "escalate",
        description:
          "Persistent constraint drift — escalate to human oversight for budget reallocation",
        severity: 1.0,
        affectedDimensions: RESOURCE_DIMENSIONS.slice() as ResourceDimension[],
      });
    }

    return corrections;
  }
}
