// tests/dist-installer-private-modes.test.js — K6: the copies of the memories the installers make (store snapshots,
// the Hermes host sidecar's home-file backup) are private under a umask of 022, and nothing of their content reaches
// the report (stderr, the --json document on stdout) or the installer's state file. Local only: temp dirs, no CLI.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";

import { ensurePrivateDir } from "../scripts/dist/installer/fsutil.mjs";
import { createReport } from "../scripts/dist/installer/report.mjs";
import { snapshotStep } from "../scripts/dist/installer/update.mjs";
import { writeState } from "../scripts/dist/installer/state.mjs";
import { homeBackupRoot, restoreHomeFiles, saveHomeFiles, snapshotStore, snapshotsDirOf, storePath } from "../scripts/dist/installer/hermes/update.mjs";
import { makeTempDir } from "./helpers/temp-dir.js";

const posixOnly = process.platform === "win32" ? "POSIX modes (the Windows ACL is tested in dist-installer-windows-acl.test.js)" : false;
const MEMORY_MARKER = "K6-MEMORY-MARKER-7f3c1e";
const CONFIG_MARKER = "K6-CONFIG-MARKER-d41a09";
const mode = (p) => statSync(p).mode & 0o777;
const T = { timeout: 30_000 };

process.umask(0o022);

function capture() {
  const out = [];
  const err = [];
  const report = createReport({ json: true, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } });
  return { report, text: () => `${out.join("")}${err.join("")}` };
}

/** Every file under `dir` (recursively) except those under `skip`, as one string. */
function readTree(dir, skip = []) {
  let s = "";
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (skip.includes(p)) continue;
    const st = lstatSync(p);
    if (st.isDirectory()) s += readTree(p, skip);
    else if (st.isFile()) s += readFileSync(p, "utf8");
  }
  return s;
}

describe("ensurePrivateDir", { skip: posixOnly, ...T }, () => {
  it("creates every missing level 0700 under umask 022", () => {
    const root = makeTempDir("k6-priv-");
    ensurePrivateDir(join(root, "a", "b"));
    assert.equal(mode(join(root, "a")), 0o700);
    assert.equal(mode(join(root, "a", "b")), 0o700);
  });

  it("narrows an existing 0755 directory and never chmods through a symlink", () => {
    const root = makeTempDir("k6-priv-");
    const open = join(root, "open");
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    ensurePrivateDir(open);
    assert.equal(mode(open), 0o700);

    const target = join(root, "target");
    mkdirSync(target);
    chmodSync(target, 0o755);
    symlinkSync(target, join(root, "link"));
    ensurePrivateDir(join(root, "link"));
    assert.equal(mode(target), 0o755);
  });

  it("does not chmod for win32 (it sets an ACL instead, M-6)", () => {
    const root = makeTempDir("k6-priv-");
    const d = join(root, "w");
    mkdirSync(d);
    chmodSync(d, 0o755);
    const ran = [];
    const execFile = (cmd, args) => {
      ran.push(win32.basename(cmd, ".exe"));
      // icacls /save: the DACL read back holds only the user and SYSTEM
      if (args?.[1] === "/save") writeFileSync(args[2], Buffer.from("D:PAI(A;OICI;FA;;;S-1-5-21-1-2-3-1001)(A;OICI;FA;;;SY)\r\n", "utf16le"));
      return cmd.endsWith("whoami.exe") ? '"h\\u","S-1-5-21-1-2-3-1001"' : "";
    };
    ensurePrivateDir(d, { platform: "win32", execFile });
    assert.equal(mode(d), 0o755);
    assert.deepEqual(ran, ["whoami", "icacls", "icacls"], "grant, then the DACL is read back");
  });
});

describe("OpenClaw store snapshot (update/adoption)", { skip: posixOnly, ...T }, () => {
  it("puts the snapshot under a 0700 root, also one an older version left at 0755, and reports no memory text", async () => {
    const stateDir = makeTempDir("k6-oc-");
    const base = join(stateDir, "memory", "lancedb-namespaced");
    mkdirSync(join(base, "agent"), { recursive: true });
    writeFileSync(join(base, "agent", "data.lance"), `${MEMORY_MARKER}\n`);
    writeFileSync(join(stateDir, "memory", "run-state.json"), JSON.stringify({ note: MEMORY_MARKER }));
    const root = join(stateDir, "memory", ".snapshots");
    mkdirSync(root);
    chmodSync(root, 0o755); // as the plugin or an older installer left it
    writeState(stateDir, { previousSlot: null, installedVersion: "1.0.0", source: "npm" });

    const { report, text } = capture();
    const id = await snapshotStep({ report, stateDir, baseDbPath: base, label: "pre-k6", pluginVersion: "1.0.0", now: () => Date.UTC(2026, 9, 6) });
    report.finish(0);

    assert.ok(id);
    assert.equal(mode(root), 0o700);
    assert.ok(existsSync(join(root, id, "snapshot.json")));
    assert.ok(!text().includes(MEMORY_MARKER), "memory text in the report");
    assert.ok(!readFileSync(join(stateDir, "memory", ".plur1bus-installer.json"), "utf8").includes(MEMORY_MARKER));
  });

  it("creates no snapshot directory when there is no store", async () => {
    const stateDir = makeTempDir("k6-oc-");
    const { report } = capture();
    const id = await snapshotStep({ report, stateDir, baseDbPath: join(stateDir, "memory", "lancedb-namespaced"), label: "x", pluginVersion: "1.0.0", now: Date.now });
    assert.equal(id, null);
    assert.ok(!existsSync(join(stateDir, "memory", ".snapshots")));
  });
});

describe("Hermes host sidecar update: home-file backup and store snapshot", { skip: posixOnly, ...T }, () => {
  function sidecarHome() {
    const home = makeTempDir("k6-hm-");
    mkdirSync(join(home, "state"), { mode: 0o700 });
    chmodSync(join(home, "state"), 0o700); // the harness keeps its state dir private
    mkdirSync(storePath(home), { recursive: true });
    writeFileSync(join(storePath(home), "memories.lance"), `${MEMORY_MARKER}\n`);
    writeFileSync(join(home, "manifest.json"), JSON.stringify({ profile: "host" }));
    writeFileSync(join(home, "config.json"), JSON.stringify({ embedding: { useClass: "general" }, marker: CONFIG_MARKER }));
    chmodSync(join(home, "config.json"), 0o644);
    return home;
  }

  it("saves manifest.json and config.json into 0700 directories as 0600 files, and restores the original modes", () => {
    const home = sidecarHome();
    const b = saveHomeFiles(home, () => 1_790_000_000_000);
    assert.equal(mode(join(home, "backups")), 0o700);
    assert.equal(mode(homeBackupRoot(home)), 0o700);
    assert.equal(mode(b.dir), 0o700);
    assert.equal(mode(join(b.dir, "config.json")), 0o600);
    assert.equal(mode(join(b.dir, "manifest.json")), 0o600);
    assert.equal(b.files["config.json"].mode, 0o644);
    assert.ok(!JSON.stringify(b).includes(CONFIG_MARKER), "the backup record (persisted in the state file) carries no content");

    writeFileSync(join(home, "config.json"), "{}");
    chmodSync(join(home, "config.json"), 0o600);
    restoreHomeFiles(home, b);
    assert.equal(mode(join(home, "config.json")), 0o644);
    assert.ok(readFileSync(join(home, "config.json"), "utf8").includes(CONFIG_MARKER));
  });

  it("snapshots the 0700-protected store into a 0700 directory and reports no memory text", async () => {
    const home = sidecarHome();
    const { report, text } = capture();
    const id = await snapshotStore({ report, home, label: "pre-k6", now: () => Date.UTC(2026, 9, 6) });
    report.finish(0);
    assert.ok(id);
    assert.equal(mode(join(home, "backups")), 0o700);
    assert.equal(mode(snapshotsDirOf(home)), 0o700);
    assert.ok(!text().includes(MEMORY_MARKER), "memory text in the report");
    assert.ok(!readTree(home, [storePath(home), snapshotsDirOf(home)]).includes(MEMORY_MARKER), "memory text outside the store and its snapshot");
  });
});
