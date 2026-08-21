# Changelog

## v0.9.0
- Auto-reflection (prime-agent AutoRefine pattern): after substantial manual work in a 21 project, the agent is automatically asked to review its trajectory and capture durable lessons via reflect21 — once per session, configurable via `supervisor.autoReflect: false`. reflect21's evidence/retention guards keep quality high.

## v0.8.0
- Update notifications: you are now told when a newer 21-harness exists (`pi update --extensions` or `update21`).

## v0.7.0
- `score21`: record OFFICIAL scores obtained outside your machine (competition submissions, validation queues). Best.json updates only when an official result beats it — for competitions where local measurement is impossible or approximate.

## v0.6.0
- Goal-first onboarding: `/21` now asks WHAT you want to optimize first. Name a challenge and the agent finds its repo, sets up dependencies, determines the score regex and completes configuration autonomously. Known challenges (Lighter.fast, ECDSA.fail, MLX.fast, SNARK.fast, Proximity Prize) are recognized by name.

## v0.5.0
- Passive capture: running your scoring command directly via bash is logged as an external observation, with a one-time reminder that only `bench21` captures gated scores.

## v0.4.x
- `/21 edit`: change settings with a pre-filled wizard (Enter keeps current values).
- Setup wizard auto-detects the score regex by running your eval once; empty answers fall back to sensible defaults, and unfinished setup is delegated to the agent.
- Post-setup guide card explaining the loop with a concrete example.

## v0.3.x
- Robustness fixes for the commit gate: improvements are auto-committed (cannot be skipped), regressions are reverted reliably, harness state (.21/) is never clobbered by reverts.

## v0.2.x
- `/21` slash command (status + manual init), skill loading fixed, deterministic e2e test suite + CI.
