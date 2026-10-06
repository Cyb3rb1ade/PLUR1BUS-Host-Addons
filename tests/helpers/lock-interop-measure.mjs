#!/usr/bin/env node
// TEST ONLY, not part of `npm test`. Times Python/Node startup and per-hold
// waits for the 3+3 interop contention phase (8 s). Workers log timestamps
// when PLUR1BUS_LOCK_TEST_TIMES=1 (ignored by checkEvents). Does not raise
// the interop timeout. See docs/lock-fr-l1-analysis.md.
import { spawn } from "node:child_process";
import { spawnSyncBounded as spawnSync } from "./run-sync.js";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PY_DIR = join(HERE, "..", "fixtures", "hermes", "python");
const NODE_WORKER = join(HERE, "lock-interop-worker.mjs");
const PY_WORKER = join(HERE, "lock-interop-worker.py");
const CONTENTION_MS = 8_000;

function findPython() {
  const candidates = process.platform === "win32" ? [["python"], ["py", "-3"], ["python3"]] : [["python3"], ["python"]];
  for (const [cmd, ...pre] of candidates) {
    const r = spawnSync(cmd, [...pre, "-c", "import sys; print(int(sys.version_info >= (3, 11)))"], { encoding: "utf8", timeout: 20_000, windowsHide: true });
    if (r.status === 0 && r.stdout.trim() === "1") return [cmd, ...pre];
  }
  return null;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

function summarise(ms) {
  const s = [...ms].sort((a, b) => a - b);
  return { n: s.length, min: s[0] ?? null, p50: percentile(s, 50), p95: percentile(s, 95), max: s.at(-1) ?? null };
}

const python = findPython();
if (!python) {
  process.stderr.write("no Python >= 3.11\n");
  process.exit(2);
}

const importTimes = [];
for (let i = 0; i < 8; i++) {
  const t0 = Date.now();
  const r = spawnSync(python[0], [...python.slice(1), "-B", "-c", "import sys; sys.path.insert(0, sys.argv[1]); import _filelock", PY_DIR], {
    encoding: "utf8", timeout: 20_000, windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  importTimes.push(Date.now() - t0);
  if (r.status !== 0) {
    process.stderr.write(r.stderr || "python import failed\n");
    process.exit(1);
  }
}

const nodeHello = [];
for (let i = 0; i < 8; i++) {
  const t0 = Date.now();
  spawnSync(process.execPath, ["-e", "process.exit(0)"], { timeout: 10_000 });
  nodeHello.push(Date.now() - t0);
}

const home = join(tmpdir(), `lock-interop-measure-${process.pid}`);
mkdirSync(join(home, "hosts"), { recursive: true });
const events = join(home, "events.log");
const stop = join(home, "never-stop");
const until = Date.now() + CONTENTION_MS;
const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PLUR1BUS_LOCK_TEST_TIMES: "1" };
const spawned = [];
const startMs = Date.now();

const start = (lang, n, dieEvery) => {
  const spawnedN = (start[lang] = (start[lang] ?? 0) + 1);
  const id = `${lang}${n}-${spawnedN}`;
  const born = Date.now();
  const c = lang === "js"
    ? spawn(process.execPath, [NODE_WORKER, home, id, String(dieEvery), String(until), stop], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, env })
    : spawn(python[0], [...python.slice(1), "-B", PY_WORKER, PY_DIR, home, id, String(dieEvery), String(until), stop], {
      stdio: ["ignore", "ignore", "pipe"], windowsHide: true, env,
    });
  const rec = { id, lang, born, exitMs: null };
  spawned.push(rec);
  c.stderr.on("data", () => {});
  return new Promise((resolveExit) => c.on("exit", () => {
    rec.exitMs = Date.now();
    resolveExit();
  }));
};

const keep = (lang, n, dieEvery) => (async () => {
  while (Date.now() < until) await start(lang, n, dieEvery);
})();

await Promise.all([keep("js", 1, 3), keep("js", 2, 4), keep("js", 3, 3), keep("py", 1, 3), keep("py", 2, 4), keep("py", 3, 3)]);
const contentionMs = Date.now() - startMs;
writeFileSync(stop, "");

const lines = existsSync(events) ? readFileSync(events, "utf8").split("\n").filter(Boolean) : [];
const holdMs = { js: [], py: [] };
const acquireMs = { js: [], py: [] };
const spawnToFirstE = { js: [], py: [] };
const lastX = {};
const open = new Map();
const seen = new Set();
for (const line of lines) {
  const [kind, id, seq, tsRaw] = line.split(" ");
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts)) continue;
  const lang = id.startsWith("py") ? "py" : "js";
  const key = `${id}#${seq}`;
  if (kind === "E") {
    open.set(key, ts);
    if (!seen.has(id)) {
      seen.add(id);
      const rec = spawned.find((s) => s.id === id);
      if (rec) spawnToFirstE[lang].push(ts - rec.born);
    }
    if (lastX[id] != null) acquireMs[lang].push(ts - lastX[id]);
    continue;
  }
  if (kind === "W" || kind === "L" || kind === "D") {
    const t0 = open.get(key);
    if (t0 != null) holdMs[lang].push(ts - t0);
  }
  if (kind === "X" || kind === "D") {
    lastX[id] = ts;
    open.delete(key);
  }
}

const byLang = (kind, lang) => lines.filter((l) => l.startsWith(`${kind} ${lang}`)).length;
const spawnToExit = { js: [], py: [] };
for (const s of spawned) {
  if (s.exitMs != null) spawnToExit[s.lang].push(s.exitMs - s.born);
}

const report = {
  platform: process.platform,
  node: process.version,
  python: spawnSync(python[0], [...python.slice(1), "-c", "import sys; print(sys.version.split()[0])"], { encoding: "utf8" }).stdout.trim(),
  pythonImportFilelockMs: summarise(importTimes),
  nodeHelloMs: summarise(nodeHello),
  contentionMs,
  workers: spawned.length,
  events: { E: lines.filter((l) => l.startsWith("E ")).length, Wjs: byLang("W", "js"), Wpy: byLang("W", "py"), Djs: byLang("D", "js"), Dpy: byLang("D", "py") },
  spawnToFirstEMs: { js: summarise(spawnToFirstE.js), py: summarise(spawnToFirstE.py) },
  holdEtoWriteMs: { js: summarise(holdMs.js), py: summarise(holdMs.py) },
  reacquireAfterLeaveMs: { js: summarise(acquireMs.js), py: summarise(acquireMs.py) },
  workerLifetimeMs: { js: summarise(spawnToExit.js), py: summarise(spawnToExit.py) },
};
rmSync(home, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
