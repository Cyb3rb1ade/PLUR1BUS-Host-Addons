// tests/dist-hermes-lock-fr-l1.test.js — characterisation of the bindings-registry
// verify-then-write window (docs/lock-fr-l1-analysis.md). Does not change the lock
// protocol. The existing FR-L1 contention and put-back tests stay as they are.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { REGISTRY_LOCK_FILE, RegistryLockLost, withRegistryLock } from "../scripts/dist/installer/hermes/binding.mjs";
import { checkEvents } from "./helpers/lock-events.mjs";
import { makeTempDir } from "./helpers/temp-dir.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BINDING = pathToFileURL(join(HERE, "..", "scripts", "dist", "installer", "hermes", "binding.mjs")).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("FR-L1 overlap characterisation (docs/lock-fr-l1-analysis.md)", () => {
  it("a holder that already passed assertHeld can still write after a newcomer entered (verify-then-write window)", async () => {
    // Same waiter-rename as the put-back-window test in dist-hermes-install.test.js, with the
    // worker's order: assertHeld, then the write (registry-lock-worker.mjs sleeps 3 ms between
    // them). The existing test calls assertHeld after the newcomer is inside and expects L.
    // This one verifies first, then lets the newcomer in, then writes without checking again.
    const ph = makeTempDir("hermes-lock-toctou-");
    const lock = join(ph, "hosts", REGISTRY_LOCK_FILE);
    const events = join(ph, "events.log");
    const log = (kind, id) => writeFileSync(events, `${kind} ${id} 1 ${Date.now()}\n`, { flag: "a" });
    const release = join(ph, "release");
    const third = `import { appendFileSync, existsSync } from "node:fs";
import { withRegistryLock } from ${JSON.stringify(BINDING)};
const log = (k) => appendFileSync(${JSON.stringify(events)}, k + " third 1 " + Date.now() + "\\n");
withRegistryLock(${JSON.stringify(ph)}, ({ assertHeld }) => {
  log("E");
  assertHeld();
  log("W");
  while (!existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  log("X");
});`;
    let thirdExit;
    await withRegistryLock(ph, async ({ assertHeld }) => {
      log("E", "holder");
      assertHeld();
      const moved = `${lock}.break-${"e".repeat(32)}`;
      renameSync(lock, moved);
      const c = spawn(process.execPath, ["--input-type=module", "-e", third], { stdio: ["ignore", "ignore", "inherit"] });
      thirdExit = new Promise((r) => c.on("exit", r));
      for (let i = 0; i < 400 && !readFileSync(events, "utf8").includes("W third"); i++) await sleep(25);
      assert.ok(readFileSync(events, "utf8").includes("W third"), "the third process is inside and wrote");
      assert.throws(() => linkSync(moved, lock), (e) => e.code === "EEXIST", "the put-back finds the newcomer's lock");
      rmSync(moved);
      log("W", "holder");
      log("X", "holder");
      writeFileSync(release, "");
      await thirdExit;
    });
    const lines = readFileSync(events, "utf8").split("\n").filter(Boolean);
    const { violations, overlaps } = checkEvents(lines);
    assert.equal(overlaps.length, 1, lines.join("\n"));
    assert.equal(overlaps[0].refused, false, "the displaced holder did not refuse");
    assert.ok(violations.some((v) => v.includes("wrote although a newcomer entered after it")), violations.join("\n"));
    assert.ok(violations.some((v) => v.includes("its verify did not refuse")), violations.join("\n"));
  });

  it("a live holder whose lock is younger than 60 s is not judged stale after 1 s (dead-pid rule)", { timeout: 15_000 }, async () => {
    const ph = makeTempDir("hermes-lock-live-pid-");
    mkdirSync(join(ph, "hosts"), { recursive: true });
    const entered = join(ph, "waiter-entered");
    const waiter = `import { writeFileSync } from "node:fs";
import { withRegistryLock } from ${JSON.stringify(BINDING)};
withRegistryLock(${JSON.stringify(ph)}, () => writeFileSync(${JSON.stringify(entered)}, "1"));`;
    let waiterExit;
    await withRegistryLock(ph, async ({ assertHeld }) => {
      assertHeld();
      const child = spawn(process.execPath, ["--input-type=module", "-e", waiter], { stdio: ["ignore", "ignore", "inherit"] });
      waiterExit = new Promise((r) => child.on("exit", r));
      await sleep(1300);
      assertHeld();
      assert.equal(existsSync(entered), false, "a waiter did not take a live lock after the 1 s dead-pid threshold");
      assert.equal(existsSync(join(ph, "hosts", REGISTRY_LOCK_FILE)), true);
    });
    assert.equal(await Promise.race([waiterExit.then(() => 0), sleep(5_000).then(() => 1)]), 0, "the waiter acquired after the live holder released");
    assert.equal(readFileSync(entered, "utf8"), "1");
  });
});
