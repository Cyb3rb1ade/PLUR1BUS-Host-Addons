// tests/dist-fsutil.test.js — guarded atomic write (FR-L1 option ii): beforeRename runs after
// fsync/close and before every rename attempt, including win32 retries. Unguarded callers stay
// as they were.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "../scripts/dist/installer/fsutil.mjs";
import { makeTempDir } from "./helpers/temp-dir.js";

const tmpLeft = (dir) => readdirSync(dir).filter((n) => n.includes(".tmp-"));

describe("writeFileAtomic guarded rename", () => {
  it("leaves the target unchanged and deletes the temp when beforeRename throws", () => {
    const dir = makeTempDir("fsutil-guard-");
    const path = join(dir, "target.txt");
    writeFileSync(path, "original\n");
    const err = Object.assign(new Error("verify failed"), { code: "LOCK_LOST" });
    assert.throws(
      () => writeFileAtomic(path, "new\n", { beforeRename: () => { throw err; } }),
      (e) => e === err,
    );
    assert.equal(readFileSync(path, "utf8"), "original\n");
    assert.deepEqual(tmpLeft(dir), []);
  });

  it("calls beforeRename before every win32 rename retry", () => {
    const dir = makeTempDir("fsutil-win-retry-");
    const path = join(dir, "target.txt");
    const verifies = [];
    let attempts = 0;
    const busy = Object.assign(new Error("busy"), { code: "EBUSY" });
    writeFileAtomic(path, "ok\n", {
      platform: "win32",
      beforeRename: () => { verifies.push("verify"); },
      rename: (from, to) => {
        attempts++;
        if (attempts <= 2) throw busy;
        renameSync(from, to);
      },
    });
    assert.equal(attempts, 3);
    assert.equal(verifies.length, 3, "verify ran before each rename attempt, including retries");
    assert.equal(readFileSync(path, "utf8"), "ok\n");
    assert.deepEqual(tmpLeft(dir), []);
  });

  it("stops win32 retries when beforeRename throws and deletes the temp", () => {
    const dir = makeTempDir("fsutil-win-refuse-");
    const path = join(dir, "target.txt");
    writeFileSync(path, "keep\n");
    let verifies = 0;
    const lost = Object.assign(new Error("lock-lost"), { code: "LOCK_LOST" });
    const busy = Object.assign(new Error("busy"), { code: "EPERM" });
    assert.throws(
      () => writeFileAtomic(path, "new\n", {
        platform: "win32",
        beforeRename: () => {
          verifies++;
          if (verifies === 2) throw lost;
        },
        rename: () => { throw busy; },
      }),
      (e) => e === lost,
    );
    assert.equal(verifies, 2);
    assert.equal(readFileSync(path, "utf8"), "keep\n");
    assert.deepEqual(tmpLeft(dir), []);
  });

  it("writeFileAtomic without beforeRename still replaces the target", () => {
    const dir = makeTempDir("fsutil-unguarded-");
    const path = join(dir, "target.txt");
    writeFileSync(path, "old\n");
    writeFileAtomic(path, "new\n");
    assert.equal(readFileSync(path, "utf8"), "new\n");
    assert.deepEqual(tmpLeft(dir), []);
  });
});
