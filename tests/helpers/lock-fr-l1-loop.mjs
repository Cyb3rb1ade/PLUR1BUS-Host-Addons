#!/usr/bin/env node
// TEST ONLY, not part of `npm test`. Replays the JS contention scenario from
// tests/dist-hermes-install.test.js (6 worker groups, 8 s, die every 5th hold)
// N times and prints hit rates for checkEvents violations. Used to measure the
// FR-L1 overlap (docs/lock-fr-l1-analysis.md).
//
// Usage: node tests/helpers/lock-fr-l1-loop.mjs [iterations=50] [untilMs=8000] [parallel=1]
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkEvents } from "./lock-events.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "registry-lock-worker.mjs");
const iterations = Math.max(1, Number(process.argv[2] ?? 50));
const untilMs = Math.max(500, Number(process.argv[3] ?? 8_000));
const parallel = Math.max(1, Number(process.argv[4] ?? 1));

function readLines(home, name) {
  const p = join(home, name);
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : [];
}

function snippet(lines, around, span = 6) {
  const i = around - 1;
  const from = Math.max(0, i - span);
  const to = Math.min(lines.length, i + span + 1);
  return lines.slice(from, to).map((l, k) => `${from + k + 1}: ${l}`);
}

async function oneRun(tag) {
  const home = join(tmpdir(), `lock-fr-l1-${process.pid}-${tag}-${Date.now()}`);
  mkdirSync(join(home, "hosts"), { recursive: true });
  const until = Date.now() + untilMs;
  const one = (id) => new Promise((resolveRun) => {
    const loop = () => {
      if (Date.now() >= until) return resolveRun();
      const n = one.n = (one.n ?? 0) + 1;
      const c = spawn(process.execPath, [WORKER, home, `w${id}-${n}`, "5", String(until)], { stdio: ["ignore", "ignore", "inherit"] });
      c.on("exit", loop);
    };
    loop();
  });
  try {
    await Promise.all([1, 2, 3, 4, 5, 6].map(one));
    const events = readLines(home, "events.log");
    const { violations, overlaps, counts } = checkEvents(events);
    const published = overlaps.filter((o) => !o.refused);
    return {
      tag,
      counts,
      overlaps: overlaps.length,
      refused: overlaps.length - published.length,
      published: published.length,
      violations,
      excerpt: violations.length ? snippet(events, Number((violations[0].match(/^line (\d+)/) || [])[1] || overlaps[0]?.line || 1)) : [],
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function pool(n, width, fn) {
  const out = [];
  let next = 1;
  const workers = Array.from({ length: Math.min(width, n) }, async () => {
    while (true) {
      const i = next++;
      if (i > n) return;
      out[i - 1] = await fn(i);
      process.stderr.write(`run ${i}/${n} overlaps=${out[i - 1].overlaps} viol=${out[i - 1].violations.length}\n`);
    }
  });
  await Promise.all(workers);
  return out;
}

const started = Date.now();
const results = await pool(iterations, parallel, oneRun);
const hits = results.filter((r) => r.violations.length);
const published = results.filter((r) => r.published);
const overlapRuns = results.filter((r) => r.overlaps);
const sum = (k) => results.reduce((a, r) => a + (r.counts[k] ?? 0), 0);
const report = {
  platform: process.platform,
  node: process.version,
  iterations,
  untilMs,
  parallel,
  elapsedMs: Date.now() - started,
  totals: { E: sum("E"), W: sum("W"), L: sum("L"), D: sum("D") },
  runsWithOverlap: overlapRuns.length,
  runsWithRefusedOverlap: results.filter((r) => r.refused).length,
  runsWithPublishedOverlap: published.length,
  runsWithViolation: hits.length,
  hitRate: hits.length / iterations,
  firstHits: hits.slice(0, 5).map((r) => ({ tag: r.tag, violations: r.violations, excerpt: r.excerpt, counts: r.counts })),
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
