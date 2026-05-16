# SARC Budget Governance Builder

## Mission
Integrate Agent Contracts (arXiv:2601.08815, Ye & Tan, COINE 2026 @ AAMAS) budget governance framework into the existing SARC v0.1 runtime governance prototype, creating a budget-aware governance layer with hierarchical conservation laws.

## Context
- SARC v0.1 is COMPLETE (37/37 tests pass, runtime governance with compliance policies on execution paths)
- AdaptOrch-SARC synthesis builder is ACTIVE (topology router + governance layer)
- SARC currently lacks resource budget enforcement — agents can recurse indefinitely without stop conditions
- Agent Contracts paper demonstrates: 90% token reduction, zero conservation violations, measurable quality-resource tradeoffs
- Gartner predicts 40% of agentic AI projects canceled by 2027 due to escalating costs

## Source Papers
1. **Agent Contracts** (arXiv:2601.08815) — Formal framework for resource-bounded autonomous AI. Key contributions:
   - Multi-dimensional resource constraints (tokens, time, API calls)
   - Temporal boundaries and success criteria
   - Conservation laws ensuring delegated budgets adhere to parent constraints
   - Hierarchical coordination through contract delegation
   - Explicit lifecycle semantics (create → activate → complete/expire/violate)
2. **Constraint Drift** (arXiv:2605.10481) — Safety constraints lose operational force across agent trajectories. Continuous maintenance required.
3. **SARC v0.1** — Already implements: compliance policies as deterministic functions on execution paths, policy enforcement hooks

## Build Spec

### Phase 1: Core Contract Types (TypeScript)
```
sarc-budget-governance/
├── src/
│   ├── contracts/
│   │   ├── types.ts          — AgentContract interface, ContractState enum
│   │   ├── factory.ts        — Contract creation with resource dimensions
│   │   ├── lifecycle.ts      — State machine: create→activate→complete/expire/violate
│   │   └── conservation.ts   — Conservation law enforcement across delegation
│   ├── governance/
│   │   ├── budget-enforcer.ts — Runtime budget checking at execution hooks
│   │   ├── delegation.ts      — Hierarchical budget delegation with conservation
│   │   └── constraint-drift.ts — Continuous constraint maintenance (from 2605.10481)
│   ├── integration/
│   │   ├── sarc-bridge.ts     — Integration with existing SARC v0.1 compliance hooks
│   │   └── adaptorch-adapter.ts — Budget-aware topology routing for AdaptOrch
│   └── index.ts
├── tests/
│   ├── contracts.test.ts
│   ├── conservation.test.ts
│   ├── constraint-drift.test.ts
│   └── sarc-integration.test.ts
├── benchmarks/
│   ├── token-reduction.ts     — Replicate 90% token reduction claim
│   └── conservation.ts        — Verify zero conservation violations
├── examples/
│   └── openclaw-skills.ts     — Budget governance for OpenClaw skill execution
└── README.md
```

### Phase 2: Key Features
1. **Multi-dimensional resource budgets** — tokens, wall-clock time, API calls, memory
2. **Contract lifecycle state machine** — formal state transitions with audit trail
3. **Conservation laws** — delegated budgets MUST sum to ≤ parent budget (mathematically enforced)
4. **Constraint drift detection** — monitor constraint enforcement degradation over trajectory
5. **SARC compliance hooks** — integrate budget checks into existing execution path governance
6. **AdaptOrch budget-aware routing** — route to cheaper agents when budget is constrained

### Phase 3: Validation
- Unit tests: ≥90% coverage
- Conservation law tests: Zero violations under adversarial delegation
- Token reduction benchmark: Target ≥50% reduction vs. ungoverned baseline
- SARC integration tests: Existing 37 tests still pass
- Constraint drift test: Demonstrate detection + correction cycle

### Phase 4: Documentation
- README with architecture diagram
- API reference for contract types
- Integration guide for SARC v0.1
- Benchmark results replication

## Constraints
- TypeScript only (match SARC v0.1 codebase)
- Must not break existing SARC v0.1 tests (37/37 must still pass)
- All conservation laws must be mathematically provable (not heuristic)
- Must handle edge cases: circular delegation, zero-budget agents, budget overflow
- Follow existing SARC patterns for policy hooks and execution paths

## Success Criteria
1. ✅ Contract lifecycle state machine with all 5 states
2. ✅ Conservation law enforcement with zero violations
3. ✅ ≥50% token reduction in benchmark vs ungoverned
4. ✅ SARC v0.1 integration without breaking existing tests
5. ✅ Constraint drift detection working
6. ✅ README + API docs complete

## Estimated Effort
Medium (4-6 hours of focused build time)

## Thesis Alignment
This directly strengthens the SARC governance thesis:
- Addresses the #1 real-world concern (cost overruns)
- Provides empirical validation via benchmarks
- Novel synthesis of two 2026 frameworks (Agent Contracts + SARC)
- Publishable as conference paper (AAMAS, ECAI, or similar)

## Dependencies
- SARC v0.1 (✅ COMPLETE)
- Agent Contracts paper concepts (available via arXiv)
- AdaptOrch-SARC (🔵 BUILDING — can integrate later)
