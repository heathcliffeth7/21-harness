---
name: 21
description: "Autonomous evolutionary optimization loop (21 harness). Use when the user asks to run an optimization experiment, improve a benchmark score autonomously, evolve candidates against a scoring function, or mentions 21 / bench21 / evolutionary search / experiment loop. Requires .21/config.json in the project (create with init21)."
---

# 21: Evolutionary Optimization Loop

You are a **variation operator**: you generate hypotheses against a score
function, make changes, and measure. You do NOT decide the score — `bench21`
does, and its verdict is final and non-negotiable.

## The loop (every iteration)

1. **Inspect** — read current state with `lineage21` (summary + strategies).
   Never retry strategy tags that already failed.
2. **Hypothesize** — log with `hypothesis21`. The tag must represent an
   optimization AXIS (e.g.: `simd`, `thread-pool`, `memory-layout`,
   `algorithmic`, `io-batching`). If an axis failed 2+ times, treat it as exhausted.
3. **Implement** — make ONE focused change. Never combine multiple independent
   changes in a single attempt; you will not be able to attribute the effect.
4. **Measure** — run `bench21`. Whatever it says is binding:
   - ✅ IMPROVED → git-commit the change, deepen on the same axis.
   - ❌ REGRESSED → it was reverted; move to a different axis.
5. Repeat.

## Abstraction ladder (climb on plateau)

When micro-tuning is exhausted, move up level by level:
`parameters > micro-optimization > memory/data layout > algorithm > problem formulation`

## Subagent roles (if pi-subagents is installed)

- **On plateau** (when the supervisor intervenes): consult the oracle —
  "Strategy X is exhausted (data is in lineage). Which different abstraction
  level should I move to?" Log the oracle's suggestion as a NEW hypothesis;
  do not apply it blindly.
- **At the start of a new project/run**: use scout to explore the codebase and
  researcher to research domain optimization techniques; write findings into
  `.21/knowledge.md` (via reflect21 or directly).
- **On risky improvements** (large refactor, behavior change): have reviewer
  check the diff BEFORE committing. Skip for simple parameter/constant changes —
  do not slow down the loop.

## Reporting rhythm

Every 10 iterations: short report + `reflect21` to write evidence-backed lessons
into knowledge. When starting new runs, lessons from knowledge are shown to you
automatically — follow them.

## Critical rules

- Always call `hypothesis21` before `bench21`.
- Do not change code after measuring — read the verdict first.
- Never touch the commit holding the best score.
- Do not delete failed hypotheses; lineage learns on top of them.
