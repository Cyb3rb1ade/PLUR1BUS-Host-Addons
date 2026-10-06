// CI hygiene (package K5): the guards that keep a wedged child or a superseded run from burning a runner.
//   - tests/helpers/run-sync.js: sync children get a timeout, are SIGKILLed, and a timeout fails loudly;
//   - every `node --test` invocation carries --test-timeout (package.json, workflows);
//   - no test file runs a sync child through node:child_process directly;
//   - every workflow: concurrency cancels only pull_request runs, push is branch-filtered, every job has a timeout.
// Static checks only read this repository's files; the child processes are `node -e` one-liners.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { DEFAULT_SYNC_TIMEOUT_MS, execFileSyncBounded, execSyncBounded, spawnSyncBounded } from "./helpers/run-sync.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TESTS = join(ROOT, "tests");
const WORKFLOWS = join(ROOT, ".github", "workflows");
const HANG = ["-e", "setInterval(() => {}, 1000)"];
const HANG_IGNORING_SIGTERM = ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"];

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
}

describe("run-sync.js", () => {
  it("defaults to the 120 s per-test limit", () => {
    assert.equal(DEFAULT_SYNC_TIMEOUT_MS, 120_000);
  });

  it("spawnSyncBounded passes a finished child through untouched", () => {
    const r = spawnSyncBounded(process.execPath, ["-e", "process.stdout.write('ok'); process.exit(3)"], { encoding: "utf8" });
    assert.equal(r.status, 3);
    assert.equal(r.stdout, "ok");
  });

  it("spawnSyncBounded kills a hung child and throws ETIMEDOUT naming the command", () => {
    const started = Date.now();
    assert.throws(
      () => spawnSyncBounded(process.execPath, HANG, { timeout: 500 }),
      (e) => e.code === "ETIMEDOUT" && /timed out after 500 ms and was killed \(SIGKILL\)/.test(e.message) && e.message.includes("setInterval") && e.result.signal === "SIGKILL",
    );
    assert.ok(Date.now() - started < 30_000, "returned long before the child would have");
  });

  it("a child that ignores SIGTERM is still gone at the limit (SIGKILL)", () => {
    assert.throws(() => spawnSyncBounded(process.execPath, HANG_IGNORING_SIGTERM, { timeout: 500 }), (e) => e.code === "ETIMEDOUT" && e.result.signal === "SIGKILL");
  });

  it("the options object may stand in for the argument list", () => {
    const r = spawnSyncBounded(process.execPath, { encoding: "utf8", input: "" });
    assert.equal(r.status, 0);
  });

  it("only a timeout throws: a missing program stays on result.error", () => {
    const r = spawnSyncBounded("plur1bus-no-such-program-k5", ["--x"], { encoding: "utf8" });
    assert.equal(r.error?.code, "ENOENT");
  });

  it("execFileSyncBounded and execSyncBounded rethrow a timeout with the command named, and leave other errors alone", () => {
    assert.throws(() => execFileSyncBounded(process.execPath, HANG, { timeout: 500 }), (e) => e.code === "ETIMEDOUT" && /was killed \(SIGKILL\)/.test(e.message));
    assert.throws(() => execSyncBounded(`"${process.execPath}" -e "setInterval(() => {}, 1000)"`, { timeout: 500 }), (e) => e.code === "ETIMEDOUT" && /was killed \(SIGKILL\)/.test(e.message));
    assert.throws(() => execFileSyncBounded(process.execPath, ["-e", "process.exit(2)"], { stdio: "ignore" }), (e) => e.status === 2 && e.code !== "ETIMEDOUT");
    assert.equal(execFileSyncBounded(process.execPath, ["-e", "process.stdout.write('hi')"], { encoding: "utf8" }), "hi");
  });
});

const TEST_FLAG = /--test-timeout[= ]\d+/;
const NODE_TEST = /\bnode\s+(?:\S+\s+)*--test(?![-\w])/;

describe("every node --test invocation has --test-timeout", () => {
  it("package.json scripts", () => {
    const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts;
    const runners = Object.entries(scripts).filter(([, v]) => NODE_TEST.test(v));
    assert.ok(runners.some(([k]) => k === "test"), "npm test runs node --test");
    for (const [name, line] of runners) assert.match(line, TEST_FLAG, `scripts.${name}: ${line}`);
  });

  it("workflow run steps", () => {
    let seen = 0;
    for (const file of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))) {
      for (const [n, line] of readFileSync(join(WORKFLOWS, file), "utf8").split("\n").entries()) {
        if (!NODE_TEST.test(line) || /^\s*#/.test(line)) continue;
        seen++;
        assert.match(line, TEST_FLAG, `${file}:${n + 1}: ${line.trim()}`);
      }
    }
    assert.ok(seen >= 1, "the wsl byte check in ci.yml is the one direct invocation");
  });

  it("scripts/ and tests/helpers/ never launch node --test without it", () => {
    for (const dir of [join(ROOT, "scripts"), join(TESTS, "helpers")]) {
      for (const f of walk(dir)) {
        for (const [n, line] of readFileSync(f, "utf8").split("\n").entries()) {
          if (NODE_TEST.test(line) && !f.endsWith("dist-ci-hygiene.test.js")) assert.match(line, TEST_FLAG, `${f}:${n + 1}`);
        }
      }
    }
  });
});

describe("no unbounded sync child in tests", () => {
  it("test files and helpers import spawnSync/execSync/execFileSync only through run-sync.js", () => {
    const files = [...readdirSync(TESTS).filter((f) => /\.test\.js$/.test(f)).map((f) => join(TESTS, f)), ...walk(join(TESTS, "helpers"))].filter(
      (f) => /\.m?js$/.test(f) && !f.endsWith("run-sync.js"),
    );
    assert.ok(files.length > 20);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"node:child_process"/g)) {
        const names = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]);
        for (const bad of ["spawnSync", "execSync", "execFileSync"]) {
          // The two CI-step helpers keep their own spawnSync (raw result needed); the next test pins their SIGKILL.
          if (bad === "spawnSync" && /ci-(hermes|plugin)-dist\.mjs$/.test(f)) continue;
          assert.ok(!names.includes(bad), `${f} imports ${bad} from node:child_process; use tests/helpers/run-sync.js`);
        }
      }
      assert.doesNotMatch(text, /child_process\.(spawnSync|execSync|execFileSync)\b/, f);
    }
  });

  it("ci-hermes-dist.mjs and ci-plugin-dist.mjs kill a timed-out sync child with SIGKILL", () => {
    for (const f of ["ci-hermes-dist.mjs", "ci-plugin-dist.mjs"]) {
      const calls = readFileSync(join(TESTS, "helpers", f), "utf8").split("\n").filter((l) => /\bspawnSync\(/.test(l) && !/^\s*(\/\/|\*)/.test(l));
      assert.ok(calls.length >= 1, f);
      for (const l of calls) assert.match(l, /timeout: .*killSignal: "SIGKILL"/, `${f}: ${l.trim()}`);
    }
  });
});

describe("workflows", () => {
  const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).sort();
  const docs = new Map(files.map((f) => [f, parse(readFileSync(join(WORKFLOWS, f), "utf8"))]));
  // `on:` is a string, a list or a map; a map's value may be null.
  const triggers = (doc) => (typeof doc.on === "string" ? { [doc.on]: null } : Array.isArray(doc.on) ? Object.fromEntries(doc.on.map((k) => [k, null])) : doc.on);

  it("finds the workflows", () => {
    assert.deepEqual(files, ["addons-release.yml", "ci.yml", "plugin-dist.yml"]);
  });

  it("a pull_request workflow cancels superseded pull_request runs and nothing else", () => {
    let seen = 0;
    for (const [f, doc] of docs) {
      if (!("pull_request" in triggers(doc))) continue;
      seen++;
      assert.ok(doc.concurrency, `${f}: no concurrency`);
      assert.match(doc.concurrency.group, /github\.event\.pull_request\.number \|\| github\.ref/, f);
      assert.equal(doc.concurrency["cancel-in-progress"], "${{ github.event_name == 'pull_request' }}", f);
    }
    assert.equal(seen, 2);
  });

  it("the release workflow never cancels and has no pull_request or push trigger", () => {
    const rel = docs.get("addons-release.yml");
    assert.equal(rel.concurrency["cancel-in-progress"], false);
    assert.ok(!("pull_request" in triggers(rel)) && !("push" in triggers(rel)));
  });

  it("plugin-dist's group is literal: github.workflow in a called workflow is the caller's name, i.e. addons-release's own group", () => {
    const pd = docs.get("plugin-dist.yml");
    assert.match(pd.concurrency.group, /^plugin-dist-/);
    assert.ok(!docs.get("addons-release.yml").concurrency.group.startsWith("plugin-dist"));
    assert.ok("workflow_call" in triggers(pd));
  });

  it("a push trigger is limited to main", () => {
    for (const [f, doc] of docs) {
      const t = triggers(doc);
      if (!("push" in t)) continue;
      assert.deepEqual(t.push?.branches, ["main"], `${f}: push without branches: [main]`);
    }
  });

  it("every job has timeout-minutes (a job that calls a workflow has its callee's own)", () => {
    for (const [f, doc] of docs) {
      for (const [id, job] of Object.entries(doc.jobs)) {
        if (job.uses) continue;
        assert.ok(job["timeout-minutes"] !== undefined, `${f}: job ${id} has no timeout-minutes`);
      }
    }
  });
});
