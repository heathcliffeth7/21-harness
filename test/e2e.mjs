/**
 * 21-harness end-to-end test (deterministic, no model involved).
 *
 * Loads the real extension, registers its tools against a mock pi object,
 * and drives a full improvement -> regression -> revert cycle against a fake
 * benchmark. Verifies the code-enforced gates actually work.
 *
 * Run: node test/e2e.mjs   (from the package root)
 */
import { createJiti } from "jiti";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "21-e2e-"));
const GIT = ["-C", WORK];
const sh = (cmd) => execFileSync("bash", ["-c", cmd], { cwd: WORK, encoding: "utf8" });
const fail = (msg) => {
  console.error(`❌ FAIL: ${msg}`);
  process.exit(1);
};

// --- fixture repo ---
sh("git init -q");
sh(`printf '#!/bin/bash\\nv=$(cat opt.txt 2>/dev/null||echo 50)\\necho "score: $v"\\n' > b.sh`);
sh("chmod +x b.sh && echo 50 > opt.txt");
execFileSync("git", [...GIT, "add", "-A"]);
// local identity: CI runners have none, and bench21 auto-commit needs one
execFileSync("git", [...GIT, "config", "user.email", "test@example.com"]);
execFileSync("git", [...GIT, "config", "user.name", "e2e"]);
execFileSync("git", [...GIT, "commit", "-m", "i"]);

// --- load extension ---
const jiti = createJiti(ROOT, { fsCache: false, moduleCache: false });
const mod = await jiti.import(path.join(ROOT, "index.ts"));

const tools = {};
const piMock = {
  registerTool: (d) => { tools[d.name] = d; },
  registerCommand: () => {},
  on: () => {},
  sendUserMessage: () => {},
  exec: async (cmd, args, opts) => {
    try {
      const out = execFileSync(cmd, args, { cwd: WORK, timeout: opts?.timeout ?? 30000, encoding: "utf8" });
      return { stdout: out, stderr: "", code: 0 };
    } catch (e) {
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.status ?? 1 };
    }
  },
};
mod.default(piMock);

const ctx = { cwd: WORK, ui: { notify() {} } };
const call = async (name, params) =>
  (await tools[name].execute("t", params, undefined, undefined, ctx)).content[0].text;
const hyp = (tag) => tools.hypothesis21.execute("t", { hypothesis: tag, strategyTag: tag }, undefined, undefined, ctx);
const bench = async () => {
  const r = await tools.bench21.execute("t", {}, undefined, undefined, ctx);
  return r.content[0].text;
};
const readBest = () => JSON.parse(fs.readFileSync(path.join(WORK, ".21/best.json"), "utf8")).score;
const readOpt = () => fs.readFileSync(path.join(WORK, "opt.txt"), "utf8").trim();
const jsonlBenches = () =>
  fs.readFileSync(path.join(WORK, ".21/experiments.jsonl"), "utf8")
    .split("\n").filter(Boolean).map(JSON.parse).filter((e) => e.type === "bench");

// --- scenario ---
await call("init21", { name: "e2e", evalCommand: "./b.sh", scoreRegex: "score: ([0-9.]+)", mode: "max" });
if (!fs.existsSync(path.join(WORK, ".21/config.json"))) fail("init21 did not write config");

await hyp("base");
let v = await bench();
if (!v.includes("IMPROVED")) fail(`base bench should IMPROVE, got: ${v}`);

sh("echo 80 > opt.txt"); await hyp("a");
v = await bench();
if (!v.includes("IMPROVED")) fail(`axis-a should IMPROVE, got: ${v}`);
if (!v.includes("Auto-committed")) fail("improvement was not auto-committed");

const commitsAfterWin = sh("git log --oneline").split("\n").length;

sh("echo 30 > opt.txt"); await hyp("b");
v = await bench();
if (!v.includes("REGRESSED")) fail(`axis-b should REGRESS, got: ${v}`);
if (!v.includes("AUTO-REVERT") || v.includes("INCOMPLETE")) fail(`revert incomplete: ${v}`);

if (readOpt() !== "80") fail(`working tree not restored to best (opt.txt=${readOpt()})`);
if (readBest() !== 80) fail(`best.json wrong (${readBest()})`);
if (jsonlBenches().length !== 3) fail(`expected 3 bench entries, got ${jsonlBenches().length}`);
if (commitsAfterWin !== sh("git log --oneline").split("\n").length)
  fail("regression must not create commits");

// hypothesis gate: after any completed bench the flag resets, so a bare
// bench21 must be rejected with an explicit message (not an exception).
const gateText = (await tools.bench21.execute("t", {}, undefined, undefined, ctx)).content[0].text;
if (!gateText.includes("REJECTED")) fail(`bench without hypothesis not rejected: ${gateText}`);

// --- guarded reflection (HCL-style) ---
const rRej = (await tools.reflect21.execute("t", { lessons: ["pixie dust made everything faster"] }, undefined, undefined, ctx)).content[0].text;
if (!rRej.includes("rejected")) fail(`unsupported lesson not rejected: ${rRej}`);

const rOk = (await tools.reflect21.execute("t", { lessons: ["baseline axis worked reliably as a starting point"] }, undefined, undefined, ctx)).content[0].text;
if (!rOk.includes("L#1")) fail(`supported lesson not committed: ${rOk}`);

const rContra = (await tools.reflect21.execute("t", { lessons: ["baseline axis failed under load"] }, undefined, undefined, ctx)).content[0].text;
if (!rContra.toLowerCase().includes("retired")) fail(`contradiction did not retire old lesson: ${rContra}`);
const kRaw = fs.readFileSync(path.join(WORK, ".21/knowledge.md"), "utf8");
if (!kRaw.includes("[retired:superseded-by-L#2]")) fail("old lesson not marked retired in file");
if (!kRaw.match(/L#2 \[active\]/)) fail("new lesson not active in file");

console.log("✅ e2e passed: gates, auto-commit, auto-revert, lineage, guarded reflection all verified.");
