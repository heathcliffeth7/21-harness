# 21-harness

Autonomous evolutionary optimization harness for [pi](https://pi.dev), the coding agent.

Turns pi into a variation operator: it generates hypotheses against a score
function, makes focused changes, measures with a real eval command, and keeps
only what improves. Discipline is enforced in code, not in prompts — the agent
cannot skip measurement, fake scores, or keep regressions.

Works with any model pi supports. Domain-agnostic: point it at any command that
prints a score (benchmarks, eval suites, provers, compilers, tests).

## Install

```bash
pi install git:github.com/YOU/21-harness
```

Or manually: copy `index.ts` to `~/.pi/agent/extensions/`, `skills/21` to
`~/.pi/agent/skills/`, and `run21` somewhere on your `PATH`.

Optional companion (recommended): [pi-subagents](https://pi.dev/packages/pi-subagents)
adds oracle/reviewer/scout roles used on plateau and risky changes:

```bash
pi install npm:pi-subagents
```

## Quick start

Inside any project directory, start pi and run:

```
/21
```

A guided setup asks a few questions (project name, eval command) and can run
your eval command once to auto-detect the score regex from its output — no
manual regex writing needed. Prefer explicit? Use `/21 init name=...
eval=... regex=... mode=max`, or just tell the agent what to configure.

Then either drive the loop interactively ("run an optimization iteration") or
go headless:

```bash
run21 --task "improve throughput" --iterations 50 --max-minutes 480

# parallel population search across 4 worktrees
run21 --task "..." --parallel 4 --iterations 20
```

## The loop

1. **Inspect** — `lineage21`: read history, never retry failed strategy tags.
2. **Hypothesize** — `hypothesis21`: log hypothesis + strategy axis tag.
3. **Implement** — ONE focused change per attempt.
4. **Measure** — `bench21`: run eval, parse score, append lineage, apply gate.
   - IMPROVED → commit; deepen on the same axis.
   - REGRESSED → automatic revert of changed files; switch axis.
5. Repeat. Every ~10 iterations `reflect21` distills evidence-backed lessons
   into `.21/knowledge.md`, which future sessions see automatically.

The supervisor detects plateaus (no meaningful improvement over N measurements)
and redirects the agent to a new abstraction level; if `pi-subagents` is
installed it consults the oracle for a second opinion.

## State layout

```
.21/
├── config.json         # adapter: eval command + score regex + gates
├── experiments.jsonl   # lineage log (written by tools only, not the agent)
├── best.json           # best score + commit hash
├── knowledge.md        # persistent lessons from reflect21
└── run.log             # headless run output
```

All state is file-based and survives restarts and crashes. Each iteration runs
in a fresh session and rebuilds context from these files, so context growth
never degrades long runs.

## Tools

| Tool | Purpose |
|---|---|
| `init21` | Scaffold `.21/config.json` (eval command + score regex) |
| `hypothesis21` | Log hypothesis + strategy tag before measuring (required) |
| `bench21` | Run eval, parse score, lineage, commit gate, auto-revert |
| `lineage21` | Query history: summary / strategies / recent |
| `reflect21` | Distill evidence-backed lessons into knowledge |

## Runner

```bash
run21 --task "..." [--iterations N] [--max-minutes N] [--sleep S] [--parallel K]
```

- Fresh `pi -p` session per iteration → crash-safe.
- Budget controls (`--iterations`, `--max-minutes`) and stall detection
  (stops after 8 non-improving iterations).
- Lockfile prevents concurrent runs on one project.
- `--parallel K`: K git worktrees explore distinct strategy axes concurrently;
  the winning worker is merged into the main branch at the end.

## Design notes

- The score comes from an external process — the agent's opinion is never the
  ground truth. This mirrors how evolutionary-search systems separate the
  variation operator from the evaluator.
- Gates live in code (extension), not prose (prompt). Long-run compliance does
  not decay.
- Failed hypotheses are kept forever; the lineage learns on top of them.

## License

MIT
