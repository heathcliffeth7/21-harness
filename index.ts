/**
 * 21 — Autonomous evolutionary optimization harness for pi.
 *
 * Domain-agnostic variation-operator layer on top of the pi coding agent:
 *   - init21       : scaffold .21/config.json adapter for any eval target
 *   - hypothesis21 : log a hypothesis + strategy tag BEFORE measuring (required)
 *   - bench21      : run eval, parse score, append lineage, apply commit gate
 *                    (score worse than best -> automatic revert)
 *   - lineage21    : query experiment history (summary/recent/strategies)
 *   - reflect21    : distill evidence-backed lessons into persistent knowledge
 *
 * Supervisor: plateau detection on agent_end -> strategy-change redirect.
 * All state lives under .21/ (file-based, survives restarts).
 *
 * Model-agnostic: works with whatever model pi is configured with.
 */

import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import fs, { existsSync } from "node:fs";
import { join } from "node:path";
import path from "node:path";
import os from "node:os";

// ---------- Types ----------

interface Config {
	name: string;
	eval: { command: string; args?: string[]; cwd?: string; timeoutSec?: number };
	score: { regex: string; mode: "max" | "min"; unit?: string };
	gate?: { autoRevert?: boolean; requireHypothesis?: boolean };
	supervisor?: {
		enabled?: boolean;
		plateauWindow?: number;
		minImprovementPct?: number;
		autoReflect?: boolean;
	};
}

interface BestState {
	score: number;
	gitHead: string;
	ts: string;
	hypothesis?: string;
}

const VERSION = "1.0.2";
const CHANGELOG_SUMMARY: Record<string, string> = {
	"1.0.2": "+ version reporting fixed (update card shows the true version).",
	"1.0.1": "+ patch script for prime-agent /refine JSON crashes.",
	"1.0.0": "+ proactive capture & compact guard: durable insights are saved the moment they are learned; manual /compact pauses once for reflection first.",
	"0.9.0": "+ auto-reflection: after substantial manual work the agent reviews its trajectory and saves durable lessons automatically.",
	"0.8.0": "+ update notifications (this card).",
	"0.7.0": "+ score21: record OFFICIAL scores from competition submissions/validation queues when local measurement is not possible.",
	"0.6.0": "/21 now asks WHAT you want to optimize first — the agent finds the repo, sets it up and completes configuration autonomously.",
	"0.5.0": "+ passive capture: manual scoring runs are logged as external observations.",
};
const MARKER_FILE = () => join(os.homedir(), ".pi", "agent", ".21-last-version");
const CONFIG_PATH = () => join(".21", "config.json");
const LOG_PATH = () => join(".21", "experiments.jsonl");
const BEST_PATH = () => join(".21", "best.json");
const STATE_PATH = () => join(".21", "state.json");
const KNOWLEDGE_PATH = () => join(".21", "knowledge.md");

// ---------- Helpers ----------

async function loadConfig(cwd: string): Promise<Config> {
	const p = join(cwd, CONFIG_PATH());
	if (!existsSync(p)) {
		throw new Error(
			`.21/config.json not found (${p}). Run the init21 tool first to scaffold this project.`,
		);
	}
	return JSON.parse(await readFile(p, "utf-8")) as Config;
}

async function readJsonl(path: string): Promise<any[]> {
	if (!existsSync(path)) return [];
	const out: any[] = [];
	for (const line of (await readFile(path, "utf-8")).split("\n")) {
		const s = line.trim();
		if (s) {
			try {
				out.push(JSON.parse(s));
			} catch {
				/* skip malformed line */
			}
		}
	}
	return out;
}

async function readBest(cwd: string): Promise<BestState | null> {
	const p = join(cwd, BEST_PATH());
	return existsSync(p) ? (JSON.parse(await readFile(p, "utf-8")) as BestState) : null;
}

function makeGit(execFn: typeof pi.exec) {
	return async (cwd: string, args: string[], signal?: AbortSignal): Promise<string> => {
		const r = await execFn("git", ["-C", cwd, ...args], { signal, timeout: 30_000 });
		// trimEnd only: a leading trim would eat the status column of the
		// first porcelain line (" M file" -> "M file") and corrupt paths.
		return r.code === 0 ? r.stdout.replace(/[\s\n]+$/, "") : "";
	};
}

function betterScore(a: number, b: number | undefined, mode: "max" | "min"): boolean {
	if (b === undefined || Number.isNaN(b)) return true;
	return mode === "max" ? a > b : a < b;
}

// Harness state (.21/) must never be committed or reverted by the gate:
// otherwise a regression revert would clobber lineage/best/knowledge.
function isHarnessPath(p: string): boolean {
	return p === ".21" || p.startsWith(".21/");
}

// ---------- Extension ----------

export default function harness21(pi: ExtensionAPI) {
	let lastBenchHadHypothesis = false;
	const git = makeGit(pi.exec.bind(pi));
	let injectedThisSession = false;

	// ---- Project awareness: inject state when a 21 project is detected ----
	pi.on("session_start", async (_event, ctx) => {
		injectedThisSession = false; // new session -> injection right renewed
		const cfgPath = join(ctx.cwd, CONFIG_PATH());
		if (!existsSync(cfgPath)) return;
		try {
			const cfg = JSON.parse(await readFile(cfgPath, "utf-8")) as Config;
			const best = await readBest(ctx.cwd);
			ctx.ui.notify(
				`21 project detected: ${cfg.name}` +
					(best ? ` — best score ${best.score}${cfg.score.unit ? " " + cfg.score.unit : ""}` : " — no measurements yet"),
				"info",
			);
		} catch {
			/* broken config -> silently continue */
		}

		// best-effort update check (non-blocking failure, 6s cap)
		try {
			const pkgDir = "/root/.pi/agent/git/github.com/heathcliffeth7/21-harness".replace("/root", os.homedir());
			if (existsSync(join(pkgDir, ".git"))) {
				await pi.exec("git", ["-C", pkgDir, "fetch", "origin", "--quiet"], { timeout: 6000 });
				const r = await pi.exec("git", ["-C", pkgDir, "rev-list", "--count", "HEAD..origin/master"], { timeout: 5000 });
				const behind = parseInt((r.stdout || "0").trim(), 10);
				if (r.code === 0 && behind > 0) {
					ctx.ui.notify(
						`21-harness: ${behind} update(s) available. Run 'pi update --extensions' or 'update21'.`,
						"warning",
					);
				}
			}
		} catch {
			/* offline or not a git install -> skip */
		}

		// show a brief summary once after each version bump
		try {
			const marker = MARKER_FILE();
			let last = "";
			if (existsSync(marker)) last = fs.readFileSync(marker, "utf-8").trim();
			if (last !== VERSION) {
				fs.mkdirSync(path.dirname(marker), { recursive: true });
				fs.writeFileSync(marker, VERSION);
				const notes = CHANGELOG_SUMMARY[VERSION] ?? "see CHANGELOG.md for details.";
				ctx.ui.notify(`📦 21-harness updated to v${VERSION}. What's new: ${notes}`, "info");
			}
		} catch {}
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (injectedThisSession) return undefined;
		const cfgPath = join(ctx.cwd, CONFIG_PATH());
		if (!existsSync(cfgPath)) return undefined;
		let cfg: Config;
		try {
			cfg = JSON.parse(await readFile(cfgPath, "utf-8"));
		} catch {
			return undefined;
		}
		injectedThisSession = true;

		const entries = await readJsonl(join(ctx.cwd, LOG_PATH()));
		const benches = entries.filter((e) => e.type === "bench");
		const best = await readBest(ctx.cwd);
		let sinceLastWin = 0;
		for (let i = benches.length - 1; i >= 0; i--) {
			if (benches[i].improved) break;
			sinceLastWin++;
		}

		const kPath = join(ctx.cwd, KNOWLEDGE_PATH());
		let knowledge = "";
		if (existsSync(kPath)) {
			try {
				const lines = (await readFile(kPath, "utf-8")).split("\n").filter(Boolean);
				const _all = lines; // visible = active lessons only
				knowledge = `\n[Persistent knowledge — ACTIVE lessons from previous runs]\n${_all.filter((l) => !/^L#\d+\s+\[retired/i.test(l.trim())).slice(-30).join("\n")}`;
			} catch {}
		}

		const content =
			`[21 active project: ${cfg.name}]\n` +
			(best
				? `Best score: ${best.score}${cfg.score.unit ? " " + cfg.score.unit : ""} @ ${best.gitHead}. ${sinceLastWin} measurements since last improvement.`
				: "No measurements yet.") +
			`\nWhen optimizing in this project, follow the loop: log a hypothesis (hypothesis21), make ONE focused change, measure with bench21. When you discover a DURABLE insight mid-work (root cause, pitfall, what works and why), call reflect21 IMMEDIATELY - do not wait for session end.` +
			knowledge;

		return {
			message: {
				customType: "21-context",
				content,
				display: true,
			},
		};
	});

	// ---- init21 ----
	pi.registerTool({
		name: "init21",
		label: "21 Init",
		description:
			"Scaffold the 21 evolutionary-search loop for this project: writes the .21/config.json adapter. " +
			"Call once; provide the eval command and a score regex specific to your domain.",
		parameters: Type.Object({
			name: Type.String({ description: "Experiment/project name, e.g. lighter-fast" }),
			evalCommand: Type.String({
				description: "Command that produces a score, e.g. ./benchmark.sh or cargo run --release --bin bench",
			}),
			scoreRegex: Type.String({
				description:
					"Regex capturing the score from command output (single capture group), e.g. 'throughput[=: ]+([0-9.]+)'",
			}),
			mode: Type.Union([Type.Literal("max"), Type.Literal("min")], {
				description: "max: higher score is better, min: lower score is better (e.g. latency)",
			}),
			unit: Type.Optional(Type.String({ description: "Score unit, e.g. tx/s" })),
			timeoutSec: Type.Optional(Type.Number({ description: "Eval timeout in seconds (default 3600)" })),
			autoRevert: Type.Optional(Type.Boolean({ description: "Auto-revert changes when score regresses (default true)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const dir = join(ctx.cwd, ".21");
			await mkdir(dir, { recursive: true });
			const cfg: Config = {
				name: params.name,
				eval: { command: params.evalCommand, timeoutSec: params.timeoutSec ?? 3600 },
				score: { regex: params.scoreRegex, mode: params.mode, unit: params.unit },
				gate: { autoRevert: params.autoRevert ?? true, requireHypothesis: true },
				supervisor: { enabled: true, plateauWindow: 5, minImprovementPct: 0.1, autoReflect: true },
			};
			await writeFile(join(dir, "config.json"), JSON.stringify(cfg, null, 2));
			return {
				content: [
					{
						type: "text",
						text: `21 harness configured: ${join(ctx.cwd, ".21", "config.json")}\nThe loop works as follows:\n1. Log a hypothesis with hypothesis21\n2. Make your code change\n3. Measure with bench21 — improvements are kept, regressions are auto-reverted\n4. Query history with lineage21`,
					},
				],
				details: {},
			};
		},
	});

	// ---- hypothesis21 ----
	pi.registerTool({
		name: "hypothesis21",
		label: "21 Hypothesis",
		description:
			"Log the current hypothesis and strategy tag BEFORE running a measurement. " +
			"Each attempt must carry a distinct tag; never retry the same tag.",
		parameters: Type.Object({
			hypothesis: Type.String({ description: "The hypothesis being tested (1-2 sentences)" }),
			strategyTag: Type.String({
				description: "Strategy axis tag, e.g.: simd, thread-pool, memory-layout, algorithmic",
			}),
			expectation: Type.Optional(Type.String({ description: "Expected effect, e.g.: +2% throughput" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				await loadConfig(ctx.cwd);
			} catch (e: any) {
				return { content: [{ type: "text", text: e.message }], details: {} };
			}
			const entry = {
				ts: new Date().toISOString(),
				type: "hypothesis",
				hypothesis: params.hypothesis,
				strategyTag: params.strategyTag,
				expectation: params.expectation ?? null,
			};
			await appendFile(join(ctx.cwd, LOG_PATH()), JSON.stringify(entry) + "\n");
			lastBenchHadHypothesis = true;
			return {
				content: [{ type: "text", text: `Hypothesis logged [${params.strategyTag}]. Now apply the change and run bench21.` }],
				details: {},
			};
		},
	});

	// ---- bench21 ----
	pi.registerTool({
		name: "bench21",
		label: "21 Bench",
		description:
			"Run the eval command, parse the score, append to lineage, and apply the commit gate. " +
			"If the score is worse than best (autoRevert on), changed files are reverted automatically. " +
			"Do NOT change code after measuring — read the verdict first.",
		parameters: Type.Object({
			notes: Type.Optional(Type.String({ description: "Short note about this attempt" })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			let cfg: Config;
			try {
				cfg = await loadConfig(ctx.cwd);
			} catch (e: any) {
				return { content: [{ type: "text", text: e.message }], details: {} };
			}

			if (cfg.gate?.requireHypothesis && !lastBenchHadHypothesis) {
				return {
					content: [{
						type: "text",
						text: "REJECTED: no hypothesis logged for this measurement. Call hypothesis21 first (with a strategy tag), then retry.",
					}],
					details: {},
				};
			}

			onUpdate?.({ content: [{ type: "text", text: `Running eval: ${cfg.eval.command}` }] });

			const timeoutMs = (cfg.eval.timeoutSec ?? 3600) * 1000;
			const r = await pi.exec("bash", ["-lc", cfg.eval.command], { signal, timeout: timeoutMs });
			const output = (r.stdout || "") + "\n" + (r.stderr || "");

			const gitHead = await git(ctx.cwd, ["rev-parse", "--short", "HEAD"]).catch(() => "");
			const dirty = await git(ctx.cwd, ["status", "--porcelain"]).catch(() => "");

			const re = new RegExp(cfg.score.regex, "gi");
			let score: number | null = null;
			let m: RegExpExecArray | null;
			while ((m = re.exec(r.stdout ?? "")) !== null) score = parseFloat(m[1].replace(/,/g, ""));

			const bestBefore = await readBest(ctx.cwd);

			// Eval or score parse failed
			if (r.code !== 0 || score === null || Number.isNaN(score)) {
				const entry = {
					ts: new Date().toISOString(),
					type: "bench_failed",
					exitCode: r.code,
					score: null,
					gitHead,
					tail: output.slice(-800),
					notes: params.notes ?? null,
				};
				await appendFile(join(ctx.cwd, LOG_PATH()), JSON.stringify(entry) + "\n");
				lastBenchHadHypothesis = false;
				return {
					content: [{
						type: "text",
						text: `MEASUREMENT FAILED (exit=${r.code}, score could not be parsed). Output tail:\n${output.slice(-600)}\n\nDiagnose the problem, fix it, and try again.`,
					}],
					details: { failed: true },
				};
			}

			const improved = betterScore(score, bestBefore?.score, cfg.score.mode);
			const deltaPct =
				bestBefore?.score && !Number.isNaN(bestBefore.score)
					? ((score - bestBefore.score) / Math.abs(bestBefore.score)) * 100
					: null;

			let commitNote = "";
			let finalHead = gitHead;
			if (improved) {
				// Enforce persistence IN CODE: auto-commit the improvement so that a
				// later regression's revert restores this exact state. Stage all
				// working-tree changes EXCEPT harness state (.21/).
				const paths = dirty
					.split("\n")
					.filter((l) => l.trim().length > 0)
					.map((l) => {
						// porcelain v1: 2 status chars + space, then path — slice on RAW line
						const p = l.slice(3).trim();
						return p.includes(" -> ") ? p.split(" -> ").pop()!.trim() : p;
					})
					.filter((p) => p && !isHarnessPath(p));
				if (paths.length > 0) {
					await git(ctx.cwd, ["add", "--", ...paths]);
					const msg = `21(auto): score ${score}${cfg.score.unit ? " " + cfg.score.unit : ""}${params.notes ? " — " + params.notes.replace(/["\\]/g, "") : ""}`;
					await git(ctx.cwd, ["commit", "-m", msg]);
					const newHead = await git(ctx.cwd, ["rev-parse", "--short", "HEAD"]);
					if (newHead && newHead !== gitHead) {
						finalHead = newHead;
						commitNote = `\n🔒 Auto-committed as ${newHead}.`;
					}
				}
			}

			const entry = {
				ts: new Date().toISOString(),
				type: "bench",
				score,
				bestBefore: bestBefore?.score ?? null,
				improved,
				deltaPct: deltaPct === null ? null : +deltaPct.toFixed(4),
				unit: cfg.score.unit ?? null,
				gitHead: finalHead,
				dirtyFiles: dirty ? dirty.split("\n").length : 0,
				notes: params.notes ?? null,
			};
			await appendFile(join(ctx.cwd, LOG_PATH()), JSON.stringify(entry) + "\n");
			lastBenchHadHypothesis = false;

			let verdictText: string;
			if (improved) {
				const best: BestState = {
					score,
					gitHead: finalHead,
					ts: entry.ts,
					hypothesis: params.notes ?? null,
				};
				await writeFile(join(ctx.cwd, BEST_PATH()), JSON.stringify(best, null, 2));
				verdictText =
					`✅ IMPROVED: ${score}${cfg.score.unit ? " " + cfg.score.unit : ""}` +
					(deltaPct !== null ? ` (${deltaPct > 0 ? "+" : ""}${deltaPct.toFixed(2)}%)` : " (first measurement)") +
					commitNote +
					`\nNew best recorded. You may deepen on this axis with your next hypothesis.`;
			} else {
				let revertNote = "";
				if (cfg.gate?.autoRevert !== false && dirty) {
					// only tracked changes are revertible; exclude untracked ("??") entries
					// and handle rename pairs ("old -> new") — otherwise one bad pathspec
					// aborts the whole checkout and nothing gets reverted.
					const changed = dirty
						.split("\n")
						.filter((l) => l.trim().length > 0 && !l.trim().startsWith("??"))
						.map((l) => {
							const p = l.slice(3).trim();
							return p.includes(" -> ") ? p.split(" -> ").pop()!.trim() : p;
						})
						.filter((p) => p && !isHarnessPath(p));
					if (changed.length > 0) {
						const out = await git(ctx.cwd, ["checkout", "--", ...changed]);
						const after = await git(ctx.cwd, ["status", "--porcelain"]);
						const remainingTracked = after.split("\n").filter((l) => l.trim() && !l.trim().startsWith("??")).length;
						if (remainingTracked === 0) {
							revertNote = `\n↩️ AUTO-REVERT: ${changed.length} file(s) restored (${changed.slice(0, 8).join(", ")}${changed.length > 8 ? "…" : ""}).`;
						} else {
							revertNote = `\n⚠️ AUTO-REVERT INCOMPLETE: ${remainingTracked} tracked change(s) remain. Inspect with 'git status' before continuing.`;
						}
					}
				}
				verdictText =
					`❌ REGRESSED: ${score}${cfg.score.unit ? " " + cfg.score.unit : ""} < best ${bestBefore!.score}` +
					(deltaPct !== null ? ` (${deltaPct.toFixed(2)}%)` : "") +
					revertNote +
					`\nThis approach did not work. Do NOT retry the same strategy tag; switch to a different axis. Best state is safe at ${bestBefore!.gitHead}.`;
			}

			return { content: [{ type: "text", text: verdictText }], details: { score, improved } };
		},
	});

	// ---- lineage21 ----
	pi.registerTool({
		name: "lineage21",
		label: "21 Lineage",
		description:
			"Query experiment history. view=summary (overall status + stagnation), " +
			"view=strategies (which axes worked), view=recent (last N records).",
		parameters: Type.Object({
			view: Type.Union([Type.Literal("summary"), Type.Literal("strategies"), Type.Literal("recent")], {
				description: "Default: summary",
			}),
			n: Type.Optional(Type.Number({ description: "Record count for recent (default 10)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			let cfg: Config;
			try {
				cfg = await loadConfig(ctx.cwd);
			} catch (e: any) {
				return { content: [{ type: "text", text: e.message }], details: {} };
			}
			const entries = await readJsonl(join(ctx.cwd, LOG_PATH()));
			const benches = entries.filter((e) => e.type === "bench");
			const hyps = entries.filter((e) => e.type === "hypothesis");
			const best = await readBest(ctx.cwd);
			const view = params.view ?? "summary";

			if (view === "recent") {
				const n = params.n ?? 10;
				const tail = entries.slice(-n).reverse();
				const lines = tail.map((e) => {
					if (e.type === "hypothesis") return `[H] ${e.ts} [${e.strategyTag}] ${e.hypothesis}`;
					if (e.type === "bench_failed") return `[F] ${e.ts} exit=${e.exitCode}`;
					return `[B] ${e.ts} score=${e.score} ${e.improved ? "↑" : "↓"}${e.deltaPct !== null ? ` (${e.deltaPct}%)` : ""} head=${e.gitHead}`;
				});
				return { content: [{ type: "text", text: lines.join("\n") || "(empty)" }], details: {} };
			}

			if (view === "strategies") {
				// match each bench to the nearest preceding hypothesis tag
				const tagStats = new Map<string, { tries: number; wins: number; deltas: number[] }>();
				let curTag = "?";
				for (const e of entries) {
					if (e.type === "hypothesis") curTag = e.strategyTag;
					if (e.type === "bench" && curTag !== "?") {
						const s = tagStats.get(curTag) ?? { tries: 0, wins: 0, deltas: [] };
						s.tries++;
						if (e.improved) s.wins++;
						if (e.deltaPct !== null) s.deltas.push(e.deltaPct);
						tagStats.set(curTag, s);
					}
				}
				const lines = [...tagStats.entries()]
					.sort((a, b) => b[1].tries - a[1].tries)
					.map(([tag, s]) => {
						const avg = s.deltas.length ? (s.deltas.reduce((a, b) => a + b, 0) / s.deltas.length).toFixed(2) : "-";
						return `${tag.padEnd(24)} tries=${s.tries} wins=${s.wins} avgΔ=%${avg}`;
					});
				return {
					content: [{ type: "text", text: lines.join("\n") || "(no strategies yet)" }],
					details: {},
				};
			}

			// summary
			const winRate = benches.length ? benches.filter((b) => b.improved).length / benches.length : 0;
			const sinceLastWin = (() => {
				let c = 0;
				for (let i = benches.length - 1; i >= 0; i--) {
					if (benches[i].improved) break;
					c++;
				}
				return c;
			})();
			const plateauWindow = cfg.supervisor?.plateauWindow ?? 5;
			const text =
				`Project: ${cfg.name}\n` +
				`Best score: ${best ? `${best.score} ${cfg.score.unit ?? ""} @ ${best.gitHead} (${best.ts})` : "-"}\n` +
				`Total measurements: ${benches.length}, hypotheses: ${hyps.length}, win rate: ${(winRate * 100).toFixed(0)}%\n` +
				`Measurements since last win: ${sinceLastWin}${sinceLastWin >= plateauWindow ? " ⚠️ PLATEAU" : ""}`;
			return { content: [{ type: "text", text }], details: {} };
		},
	});

	// ---- score21 ----
	pi.registerTool({
		name: "score21",
		label: "21 Official Score",
		description:
			"Record an OFFICIAL score that was obtained outside this machine (competition submission, " +
			"validation queue, leaderboard). Use when local measurement is impossible or only estimates are " +
			"possible locally. Updates best.json only if the official score beats the current best.",
		parameters: Type.Object({
			score: Type.Number({ description: "Official score as reported by the competition" }),
			notes: Type.Optional(Type.String({ description: "Where it came from, e.g. 'PR #7224 validation queue'" })),
			gitHead: Type.Optional(Type.String({ description: "Local commit hash this result corresponds to" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			let cfg: Config;
			try {
				cfg = await loadConfig(ctx.cwd);
			} catch (e: any) {
				return { content: [{ type: "text", text: e.message }], details: {} };
			}
			const bestBefore = await readBest(ctx.cwd);
			const head = params.gitHead ?? (await git(ctx.cwd, ["rev-parse", "--short", "HEAD"]).catch(() => ""));

			await appendFile(
				join(ctx.cwd, LOG_PATH()),
				JSON.stringify({
					ts: new Date().toISOString(),
					type: "official",
					score: params.score,
					bestBefore: bestBefore?.score ?? null,
					improved: betterScore(params.score, bestBefore?.score, cfg.score.mode),
					deltaPct:
						bestBefore?.score && !Number.isNaN(bestBefore.score)
							? +(((params.score - bestBefore.score) / Math.abs(bestBefore.score)) * 100).toFixed(4)
							: null,
					unit: cfg.score.unit ?? null,
					gitHead: head,
					notes: params.notes ?? null,
				}) + "\n",
			);

			if (!bestBefore || betterScore(params.score, bestBefore.score, cfg.score.mode)) {
				const best: BestState = { score: params.score, gitHead: head, ts: new Date().toISOString(), hypothesis: params.notes ?? "official result" };
				await writeFile(join(ctx.cwd, BEST_PATH()), JSON.stringify(best, null, 2));
				return {
					content: [{ type: "text", text: `🏆 OFFICIAL BEST: ${params.score}${cfg.score.unit ? " " + cfg.score.unit : ""} @ ${head} recorded. All future gates compare against this.` }],
					details: {},
				};
			}
			return {
				content: [{ type: "text", text: `Official score ${params.score} did not beat best ${bestBefore.score}. Recorded in lineage; best unchanged.` }],
				details: {},
			};
		},
	});

	// ---- reflect21 (guarded knowledge evolution) ----
	// Two-phase per HCL: propose (agent) -> evaluate (this code) -> commit.
	// Evidence check: a lesson must reference real strategy tags and its
	// polarity must not contradict measured win/loss data. Retention check:
	// an accepted lesson that contradicts an ACTIVE lesson on the same tag
	// retires the old one (superseded), never silently deletes it.
	pi.registerTool({
		name: "reflect21",
		label: "21 Reflect",
		description:
			"Distill evidence-backed lessons from experiment history into .21/knowledge.md " +
			"(guarded self-improvement). Each lesson is validated against measured lineage data: " +
			"it must reference at least one known strategy tag and its claim must not contradict " +
			"win/loss stats. Contradicted active lessons are retired, never deleted. " +
			"Call at run end and every ~10 iterations.",
		parameters: Type.Object({
			lessons: Type.Array(Type.String(), {
				description: "Evidence-backed lesson list; mention the strategy tag by name, e.g.: 'simd axis worked on small matrices (3/5 wins)', 'parameter tuning exhausted (0/4)'",
			}),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			let cfg: Config;
			try {
				cfg = await loadConfig(ctx.cwd);
			} catch (e: any) {
				return { content: [{ type: "text", text: e.message }], details: {} };
			}
			if (!params.lessons || params.lessons.length === 0) {
				return { content: [{ type: "text", text: "REJECTED: at least one lesson required (must be evidence-backed, not intuition)." }], details: {} };
			}

			// measured statistics per strategy tag
			const entries = await readJsonl(join(ctx.cwd, LOG_PATH()));
			const tagStats = new Map<string, { tries: number; wins: number }>();
			let curTag = "?";
			for (const e of entries) {
				if (e.type === "hypothesis") curTag = e.strategyTag;
				if (e.type === "bench" && curTag !== "?") {
					const s = tagStats.get(curTag) ?? { tries: 0, wins: 0 };
					s.tries++;
					if (e.improved) s.wins++;
					tagStats.set(curTag, s);
				}
			}
			const best = await readBest(ctx.cwd);

			// --- parse existing knowledge ---
			const kPath = join(ctx.cwd, KNOWLEDGE_PATH());
			const kLines = existsSync(kPath) ? (await readFile(kPath, "utf-8")).split("\n") : [];
			interface Lesson { id: number; status: string; text: string }
			const lessons: Lesson[] = [];
			for (const l of kLines) {
				const m = l.match(/^L#(\d+) \[([^\]]+)\] (.*)$/);
				if (m) lessons.push({ id: Number(m[1]), status: m[2], text: m[3] });
			}
			let nextId = lessons.reduce((mx, l) => Math.max(mx, l.id), 0) + 1;

			const polarityOf = (t: string): "pos" | "neg" | null => {
				if (/\b(fail|failed|failing|exhaust|did not|didn't|never|worse|regress|hurt|harmful|not work|unproductive)/i.test(t)) return "neg";
				if (/\b(work|works|worked|working|improv\w*|win|wins|won|gain\w*|faster|better|helpful|effective|succeed\w*)/i.test(t)) return "pos";
				return null;
			};
			const tagsIn = (t: string): string[] =>
				[...tagStats.keys()].filter((tag) => tag.length > 2 && t.toLowerCase().includes(tag.toLowerCase()));

			// --- evaluate each proposed lesson ---
			const accepted: Lesson[] = [];
			const rejected: string[] = [];
			const retiredIds = new Set<number>();
			const ts = new Date().toISOString();

			for (const raw of params.lessons) {
				const refs = tagsIn(raw);
				if (refs.length === 0) {
					rejected.push(`no known strategy tag referenced — rejected: "${raw}" (known: ${[...tagStats.keys()].join(", ") || "none"})`);
					continue;
				}
				const pol = polarityOf(raw);
				let evidenceOk = true;
				let why = "";
				if (pol === "pos") {
					if (!refs.some((r) => (tagStats.get(r)?.wins ?? 0) > 0)) {
						evidenceOk = false;
						why = `positive claim but measured wins=0 for ${refs.join(",")}`;
					}
				} else if (pol === "neg") {
					if (!refs.some((r) => (tagStats.get(r)?.tries ?? 0) > 0)) {
						evidenceOk = false;
						why = `negative claim but no measurements exist for ${refs.join(",")}`;
					}
				}
				if (!evidenceOk) {
					rejected.push(`evidence check failed (${why}) — rejected: "${raw}"`);
					continue;
				}
				const lesson: Lesson = {
					id: nextId++,
					status: "active",
					text: `${raw} [refs: ${refs.map((r) => `${r} ${tagStats.get(r)!.wins}/${tagStats.get(r)!.tries}`).join(", ")}]`,
				};
				accepted.push(lesson);
				// retention check: retire active lessons contradicted on the same tag(s)
				if (pol) {
					for (const old of lessons) {
						if (old.status !== "active" || retiredIds.has(old.id)) continue;
						const oldRefs = tagsIn(old.text);
						const shared = refs.filter((r) => oldRefs.includes(r));
						if (shared.length > 0 && polarityOf(old.text) && polarityOf(old.text) !== pol) {
							old.status = `retired:superseded-by-L#${lesson.id}`;
							retiredIds.add(old.id);
						}
					}
				}
			}

			// --- commit: rewrite file with updated statuses, append new lessons ---
			if (accepted.length > 0 || retiredIds.size > 0) {
				const updated = kLines.map((l) => {
					const m = l.match(/^(L#\d+) \[[^\]]+\] (.*)$/);
					if (!m) return l;
					const id = Number(m[1].slice(2));
					const lesson = [...lessons, ...accepted].find((x) => x.id === id);
					if (!lesson) return l;
					if (lesson.status.startsWith("retired")) return `L#${lesson.id} [${lesson.status}] ${lesson.text}`;
					return l;
				});
				const newSection =
					(updated.some((l) => l.startsWith("## ")) ? "" : `\n## ${ts}\n`) +
					updated.join("\n") +
					accepted.map((l) => `L#${l.id} [${l.status}] ${ts.slice(0, 10)} ${l.text}`).join("\n") +
					(kLines.length ? "\n" : "");
				await writeFile(kPath, newSection.endsWith("\n") ? newSection : newSection + "\n");
			reviewedThisSession = true;
			}

			const report =
				`GUARDED REFLECTION COMPLETE\n` +
				`✅ Committed: ${accepted.map((l) => `L#${l.id}`).join(", ") || "none"}\n` +
				(rejected.length ? `❌ Rejected:\n - ${rejected.join("\n - ")}\n` : "") +
				(retiredIds.size ? `🗄️ Retired (superseded, kept in file): L#${[...retiredIds].join(", L#")}\n` : "") +
				`Future sessions will see only ACTIVE lessons.`;
			return { content: [{ type: "text", text: report }], details: {} };
		},
	});

	// ---- /21 slash command (human entry point) ----
	const scaffoldConfig = async (cwd: string, cfg: Config) => {
		await mkdir(join(cwd, ".21"), { recursive: true });
		await writeFile(join(cwd, CONFIG_PATH()), JSON.stringify(cfg, null, 2));
	};

	const buildRegexCandidates = (stdout: string): Array<{ label: string; regex: string }> => {
		const cands: Array<{ label: string; regex: string }> = [];
		const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		for (const rawLine of stdout.split("\n")) {
			const line = rawLine.trim();
			if (!line) continue;
			const numRe = /-?\d[\d,]*(?:\.\d+)?/g;
			let m: RegExpExecArray | null;
			while ((m = numRe.exec(line)) !== null) {
				if (m[0].length > 12) continue;
				const prefix = line.slice(0, m.index);
				const suffix = line.slice(m.index + m[0].length);
				if (!prefix && !suffix) continue;
				const regex =
					(prefix ? esc(prefix) : "^") +
					"-?[\\d,]+(?:\\.\\d+)?" +
					(suffix ? esc(suffix) : "$");
				if (!cands.some((c) => c.regex === regex)) {
					cands.push({ label: `score from "${line.slice(0, 60)}"`, regex });
				}
				if (cands.length >= 6) break;
			}
			if (cands.length >= 6) break;
		}
		return cands;
	};

	const detectEvalCandidates = (cwd: string): string[] => {
		const out: string[] = [];
		const has = (p: string) => existsSync(join(cwd, p));
		for (const f of ["benchmark.sh", "bench.sh", "run-bench.sh", "benchmark.py", "bench.py", "evaluate.py"]) {
			if (has(f)) out.push("./" + f);
		}
		try {
			const pkg = JSON.parse(fs.readFileSync(join(cwd, "package.json"), "utf-8"));
			for (const [k, v] of Object.entries(pkg.scripts ?? {})) {
				if (/bench|eval|score|perf/i.test(k + " " + String(v))) out.push(`npm run ${k}`);
			}
		} catch {}
		if (has("Cargo.toml")) out.push("cargo bench");
		if (has("Makefile")) {
			try {
				const mk = fs.readFileSync(join(cwd, "Makefile"), "utf-8");
				for (const m of mk.matchAll(/^([a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)?):(?!=)/gm)) {
					if (/bench|eval|score|perf/i.test(m[1])) out.push(`make ${m[1]}`);
				}
			} catch {}
		}
		return [...new Set(out)];
	};

	const sendGuide = () => {
		pi.sendMessage({
			customType: "21-guide",
			content: [
				"✅ 21 harness is ready. Here is how the loop works:",
				"",
				"  1. hypothesis21  — log WHAT you will try + a strategy tag",
				"  2. make ONE focused change",
				"  3. bench21       — measure. Improvements are kept and",
				"                      auto-committed; regressions are auto-reverted.",
				"",
				"Example of a full iteration:",
				'  hypothesis21 { hypothesis: "smaller chunks reduce cache pressure", strategyTag: "memory-layout" }',
				"  ... edit one file ...",
				"  bench21  →  ✅ IMPROVED: 120 tx/s (+20%) 🔒 Auto-committed",
				"",
				'Try it now by saying "optimize" — or go headless with:',
				'  run21 --task "improve the score" --iterations 20',
			].join("\n"),
			display: true,
		});
	};

	// Known autoresearch challenges: goal keywords -> repo hints for the agent
	const KNOWN_CHALLENGES: Array<{ keys: RegExp; name: string; repo?: string }> = [
		{ keys: /lighter/i, name: "Lighter.fast (yukon.org)", repo: "https://github.com/Layr-Labs/lighter-prover-challenge" },
		{ keys: /ecdsa|quantum|elliptic/i, name: "ECDSA.fail (yukon.org)" },
		{ keys: /mlx|apple silicon/i, name: "MLX.fast (yukon.org)" },
		{ keys: /snark|flock|succinct/i, name: "SNARK.fast (yukon.org)" },
		{ keys: /proximity|soundness|proof system/i, name: "The Proximity Prize (yukon.org)" },
	];

	// Guided setup / edit. Empty answers fall back to sensible defaults;
	// if the scoring command cannot be determined, the rest of setup is
	// delegated to the agent itself.
	const runWizard = async (ctx: any, prev?: Config) => {
		ctx.ui.notify(prev ? "21 setup — press Enter to keep current values." : "21 setup — a few questions to wire this project.", "info");

		// Goal-first onboarding: what do you want to optimize / join?
		if (!prev) {
			const goal = await ctx.ui.input(
				"What do you want to optimize? (challenge or task name — press Enter to configure manually)",
				"",
			);
			if (goal && goal.trim()) {
				const g = goal.trim();
				const known = KNOWN_CHALLENGES.find((k) => k.keys.test(g));
				pi.sendUserMessage(
					`21 GOAL SET BY USER: "${g}"` +
						(known ? `\nRecognized challenge: ${known.name}` + (known.repo ? `\nOfficial repo: ${known.repo}` : "") : "") +
						`\nYour mission — complete end-to-end setup autonomously:\n` +
						`1. Locate the official repository (gh search / web) unless a repo is given above; clone it into a subdirectory of ${ctx.cwd}.\n` +
						`2. Install dependencies and get the build/benchmark working.\n` +
						`3. Identify or create the score-producing command; run it once and determine a reliable score regex.\n` +
						`4. Call init21 inside the cloned project directory (cd there first) with those parameters.\n` +
						`5. Verify bench21 produces a valid first measurement.\n` +
						`6. Report: repo, setup steps taken, baseline score, and how to start optimizing.`,
				);
				ctx.ui.notify(
					`Goal noted: "${g}". Handing over to the agent — it will find the repo, set everything up and report back.`,
					"info",
				);
				return;
			}
		}

		const defaultName = prev?.name ?? path.basename(ctx.cwd);
		const name = (await ctx.ui.input("Project name:", defaultName)) || defaultName;

		// scoring command: previous > detected > typed
		let evalCmd = "";
		const detected = detectEvalCandidates(ctx.cwd);
		if (prev?.eval.command) detected.unshift(prev.eval.command);
		if (detected.length > 0) {
			const opts = detected.concat(["None of these — I'll type it"]);
			const choice = await ctx.ui.select("Command that produces the score:", opts);
			if (choice === undefined || choice === null) return;
			evalCmd = choice.startsWith("None of these") ? ((await ctx.ui.input("Command:", "")) || "") : choice;
		} else {
			evalCmd = (await ctx.ui.input("Command that produces the score (leave empty and the agent figures it out):", "")) || "";
		}

		// regex: previous > sampled > typed > delegated to agent
		let regex = "";
		let sample = "";
		if (evalCmd) {
			const wantSample = prev?.score.regex
				? await ctx.ui.confirm("Re-run the command to re-detect the score pattern?", `Runs '${evalCmd}' once.`)
				: await ctx.ui.confirm("Run it once now?", `Runs '${evalCmd}' to capture sample output for score detection.`);
			if (wantSample) {
				const r = await pi.exec("bash", ["-lc", evalCmd], { timeout: 120000 });
				sample = (r.stdout || "") + (r.stderr || "");
				if (!sample.trim()) ctx.ui.notify("(no output captured)", "warning");
			}
			const candidates = sample ? buildRegexCandidates(sample) : [];
			if (prev?.score.regex && !sample) {
				regex = (await ctx.ui.input(`Score regex (Enter keeps current: ${prev.score.regex}):`, "")) || prev.score.regex;
			} else if (candidates.length > 0) {
				const choice = await ctx.ui.select(
					"Which number is the score?",
					candidates.map((c) => c.label).concat(["None of these — I'll type the regex"]),
				);
				if (choice === undefined || choice === null) return;
				const idx = candidates.findIndex((c) => c.label === choice);
				regex = idx >= 0 ? candidates[idx].regex : ((await ctx.ui.input("Score regex (single capture group):", "")) || "");
			} else {
				regex = (await ctx.ui.input("Score regex with capture group (empty = let the agent work it out):", "")) || "";
			}
		}

		if (!evalCmd || !regex) {
			// delegate the remainder to the agent
			pi.sendUserMessage(
				"21 setup was left unfinished by the user. Your job now: inspect this project yourself, " +
					"determine (or create) a suitable score-producing command and its score regex, then finish " +
					"setup by calling init21 with those parameters" +
					(prev ? `, keeping project name '${prev.name}' unless you find something better` : "") +
					". Afterwards report what you configured and why, then show the guide.",
			);
			ctx.ui.notify("Handed over to the agent — it will finish the setup.", "info");
			return;
		}

		const modeChoice = await ctx.ui.select(
			prev?.score.mode ? `Which direction is better? (current: ${prev.score.mode})` : "Which direction is better?",
			["max (higher is better)", "min (lower is better)"],
		);
		if (!modeChoice) return;
		const unit = (await ctx.ui.input("Score unit (optional, e.g. tx/s):", prev?.score.unit ?? "")) || prev?.score.unit;

		await scaffoldConfig(ctx.cwd, {
			name,
			eval: { command: evalCmd, timeoutSec: prev?.eval.timeoutSec ?? 3600 },
			score: { regex, mode: modeChoice.startsWith("min") ? "min" : "max", unit },
			gate: prev?.gate ?? { autoRevert: true, requireHypothesis: true },
			supervisor: prev?.supervisor ?? { enabled: true, plateauWindow: 5, minImprovementPct: 0.1, autoReflect: true },
		});
		ctx.ui.notify(`21 harness ${prev ? "updated" : "configured"} for '${name}'.`, "info");
		sendGuide();
	};

	pi.registerCommand("21", {
		description: "21 harness: /21 guided setup or status · /21 edit · /21 init ...",
		handler: async (args, ctx) => {
			const cfgPath = join(ctx.cwd, CONFIG_PATH());
			const sub = args.trim();

			// read existing config once
			let existing: Config | undefined;
			if (existsSync(cfgPath)) {
				try { existing = JSON.parse(await readFile(cfgPath, "utf-8")) as Config; } catch {}
			}

			if (sub === "edit") {
				if (!existing) {
					ctx.ui.notify("Nothing to edit yet — run /21 first.", "warning");
					return;
				}
				if (!ctx.hasUI) { ctx.ui.notify("/21 edit needs an interactive session.", "warning"); return; }
				await runWizard(ctx, existing);
				return;
			}

			// bare /21 with no config -> guided setup
			if ((!sub || !sub.startsWith("init")) && !existing) {
				if (!ctx.hasUI) {
					ctx.ui.notify(
						"No 21 project here. In an interactive session run /21 (guided setup — the agent can finish it for you), or:\n/21 init name=X eval=./bench.sh regex='...' mode=max",
						"warning",
					);
					return;
				}
				await runWizard(ctx);
				return;
			}

			if (sub.startsWith("init")) {
				const kv = new Map<string, string>();
				for (const m of sub.matchAll(/(\w+)=((?:'[^']*')|("[^"]*")|(\S+))/g)) {
					kv.set(m[1], (m[2] ?? "").replace(/^['"]|['"]$/g, ""));
				}
				const name = kv.get("name") ?? existing?.name ?? path.basename(ctx.cwd);
				const evalCmd = kv.get("eval") ?? kv.get("cmd") ?? kv.get("evalcommand");
				const regex = kv.get("regex") ?? kv.get("scoreregex");
				const mode = (kv.get("mode") ?? existing?.score.mode ?? "max").toLowerCase();
				if (!evalCmd || !regex || (mode !== "max" && mode !== "min")) {
					ctx.ui.notify("Usage: /21 init eval=./bench.sh regex='score: ([0-9.]+)' mode=max [name=X unit=tx/s]", "warning");
					return;
				}
				await scaffoldConfig(ctx.cwd, {
					name,
					eval: { command: evalCmd, timeoutSec: Number(kv.get("timeout") ?? existing?.eval.timeoutSec ?? 3600) },
					score: { regex, mode: mode as "max" | "min", unit: kv.get("unit") ?? existing?.score.unit },
					gate: existing?.gate ?? { autoRevert: true, requireHypothesis: true },
					supervisor: existing?.supervisor ?? { enabled: true, plateauWindow: 5, minImprovementPct: 0.1, autoReflect: true },
				});
				ctx.ui.notify(`21 harness configured for '${name}'.`, "info");
				sendGuide();
				return;
			}

			// default: status
			if (!existing) {
				ctx.ui.notify("No 21 project here. Run /21 in an interactive session for guided setup.", "warning");
				return;
			}
			try {
				const cfg = existing;
				const entries = await readJsonl(join(ctx.cwd, LOG_PATH()));
				const benches = entries.filter((e) => e.type === "bench");
				const best = await readBest(ctx.cwd);
				let sinceLastWin = 0;
				for (let i = benches.length - 1; i >= 0; i--) {
					if (benches[i].improved) break;
					sinceLastWin++;
				}
				const wins = benches.filter((b) => b.improved).length;
				ctx.ui.notify(
					`21 project: ${cfg.name}\n` +
						`Best: ${best ? `${best.score}${cfg.score.unit ? " " + cfg.score.unit : ""} @ ${best.gitHead}` : "none yet"}\n` +
						`Measurements: ${benches.length} (${wins} improved) · since last win: ${sinceLastWin}\n` +
						`Edit settings: /21 edit`,
					"info",
				);
			} catch {
				ctx.ui.notify("Could not read .21 state.", "error");
			}
		},
	});

	// ---- Auto-reflection (prime-agent AutoRefine pattern) ----
	// After substantial manual work, delegate a REVIEW to the agent: it decides
	// whether the trajectory contains durable lessons; reflect21's own guards
	// (evidence check, retention/supersede) keep quality high. Once per session.
	let sessionMsgCount = 0;
	let reviewedThisSession = false;
	pi.on("agent_end", () => { sessionMsgCount++; });
	pi.on("agent_settled", async (_event, ctx) => {
		const cfgPath = join(ctx.cwd, CONFIG_PATH());
		if (!existsSync(cfgPath)) return;
		if (sessionMsgCount < 8 || reviewedThisSession) return;
		let cfg: Config | undefined;
		try { cfg = JSON.parse(await readFile(cfgPath, "utf-8")); } catch {}
		if (!cfg) return;
		reviewedThisSession = true;
		const autoMode = cfg.supervisor?.autoReflect !== false;
		if (!autoMode || !ctx.hasUI || !ctx.isIdle?.()) {
			ctx.ui.notify(
				"💡 Substantial work without reflection. If you learned anything durable, call reflect21.",
				"info",
			);
			return;
		}
		pi.sendUserMessage(
			"[21 AUTO-REFLECTION REVIEW] You have completed substantial work in this project. " +
				"Review the trajectory of THIS session only: is there any DURABLE, evidence-backed insight " +
				"a future session would need (bottleneck causes, pitfalls, what worked and why)?\n" +
				"- If YES: capture it with reflect21 right now (mention strategy tags, cite measurements).\n" +
				'- If NO (routine work, nothing generalizable): reply exactly "nothing durable" and do nothing else.\n' +
				"Do not invent lessons; reflect21 will reject unsupported claims anyway.",
		);
	});

	// ---- Compact guard (prime-agent compact trigger) ----
	// Manual /compact discards conversation detail. If substantial unreflected
	// work exists, pause once so lessons are captured to knowledge.md first.
	// Automatic compactions (threshold/overflow) are never blocked.
	let compactNudgeUsed = false;
	pi.on("session_before_compact", async (event, ctx) => {
		const cfgPath = join(ctx.cwd, CONFIG_PATH());
		if (!existsSync(cfgPath)) return undefined;
		if (event.reason !== "manual") return undefined;
		let cfg: Config | undefined;
		try { cfg = JSON.parse(await readFile(cfgPath, "utf-8")); } catch {}
		if (!cfg || cfg.supervisor?.autoReflect === false) return undefined;
		if (compactNudgeUsed || sessionMsgCount < 8 || reviewedThisSession) return undefined;
		if (!ctx.hasUI) return undefined;
		compactNudgeUsed = true;
		ctx.ui.notify(
			"Compaction paused once: capture durable lessons first (reflect21), then /compact again.",
			"warning",
		);
		pi.sendUserMessage(
			"[21 PRE-COMPACT REVIEW] You are about to compact this session, which will discard conversational detail. " +
				"Before that happens: review THIS session for durable, evidence-backed lessons (bottleneck causes, pitfalls, " +
				"what worked) and capture them with reflect21 now. If there is truly nothing generalizable, reply exactly " +
				'\"nothing durable\" and I will proceed with compaction.',
		);
		return { cancel: true };
	});

	// ---- Passive capture: log manual eval runs done via plain bash ----
	let warnedExternalThisSession = false;
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		const cfgPath = join(ctx.cwd, CONFIG_PATH());
		if (!existsSync(cfgPath)) return;
		let cfg: Config;
		try {
			cfg = JSON.parse(await readFile(cfgPath, "utf-8"));
		} catch {
			return;
		}
		const base = cfg.eval.command.replace(/^\.?\//, "").split(" ")[0];
		if (!base || base.length < 3) return;
		const cmd = String(event.input?.command ?? "");
		if (!cmd.includes(base)) return;

		// best-effort observation log (scores unknown -> type "external")
		try {
			await appendFile(
				join(ctx.cwd, LOG_PATH()),
				JSON.stringify({
					ts: new Date().toISOString(),
					type: "external",
					command: cmd.slice(0, 300),
					gitHead: "",
				}) + "\n",
			);
		} catch {}
		if (!warnedExternalThisSession) {
			warnedExternalThisSession = true;
			pi.sendMessage({
				customType: "21-notice",
				content:
					"[21] You ran the scoring command directly. This run was recorded as an external observation, " +
					"but its score was NOT captured or gated. For real measurements use bench21 — then the score " +
					"is parsed, compared against best, and improvements are committed automatically.",
				display: true,
			});
		}
	});

	// ---- Supervisor: plateau detection and redirection ----
	pi.on("agent_end", async (_event, ctx) => {
		const cfgPath = join(ctx.cwd, CONFIG_PATH());
		if (!existsSync(cfgPath)) return;
		let cfg: Config;
		try {
			cfg = JSON.parse(await readFile(cfgPath, "utf-8"));
		} catch {
			return;
		}
		if (cfg.supervisor?.enabled === false) return;

		const window = cfg.supervisor?.plateauWindow ?? 5;
		const minImp = cfg.supervisor?.minImprovementPct ?? 0.1;
		const entries = await readJsonl(join(ctx.cwd, LOG_PATH()));
		const benches = entries.filter((e) => e.type === "bench");
		if (benches.length < window) return;

		const recent = benches.slice(-window);
		const anyImprovement = recent.some((b) => b.improved);
		const meaningful = recent.some(
			(b) => b.deltaPct !== null && Math.abs(b.deltaPct) >= minImp,
		);

		// Episode tracking: do not re-intervene within the same plateau episode
		const statePath = join(ctx.cwd, STATE_PATH());
		let state: any = {};
		try {
			state = existsSync(statePath) ? JSON.parse(await readFile(statePath, "utf-8")) : {};
		} catch {}
		if (anyImprovement || meaningful) {
			if (state.plateauNotified) {
				state.plateauNotified = false;
				await writeFile(statePath, JSON.stringify(state));
			}
			return;
		}
		if (state.plateauNotified) return;

		// Collect failed tags
		const failedTags = new Set<string>();
		let curTag = "?";
		for (const e of entries) {
			if (e.type === "hypothesis") curTag = e.strategyTag;
			if (e.type === "bench" && !e.improved && curTag !== "?") failedTags.add(curTag);
		}

		state.plateauNotified = true;
		await writeFile(statePath, JSON.stringify(state));

		const best = await readBest(ctx.cwd);
		pi.sendUserMessage(
			`🧭 21 SUPERVISOR: No meaningful progress in the last ${window} measurements (threshold ${minImp}%). ` +
				`The current strategy axis appears exhausted. ` +
				`Exhausted tags: ${[...failedTags].slice(-8).join(", ") || "-"}. ` +
				`Actions: (1) inspect the table with lineage21 view=strategies, ` +
				`(2) pick a NEW optimization axis that does NOT overlap these tags ` +
				`(try climbing the abstraction ladder: algorithm > data structure > memory layout > micro-tuning), ` +
				`(3) log the new hypothesis with hypothesis21 and execute it. ` +
				(best ? `Reference to protect: best score ${best.score} @ ${best.gitHead}.` : ""),
		);
	});
}
