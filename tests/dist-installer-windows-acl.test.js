// tests/dist-installer-windows-acl.test.js — M-6: on Windows the installers' private directories (store snapshots,
// home-file backups) and the config.yaml backup get a protected user-and-SYSTEM ACL via icacls (argv, no shell), and
// any icacls/whoami failure fails closed (PrivateAclError, nothing private written). The stubbed tests run on every
// OS; the real-icacls block runs only on win32 (CI windows legs). Temp dirs only.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSyncBounded as execFileSync } from "./helpers/run-sync.js";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";

import {
  applyPrivateAcl,
  currentUserSid,
  othersInDacl,
  savedSddlLine,
  ensurePrivateDir,
  PrivateAclError,
  privateAclArgv,
  SYSTEM_SID,
  systemTool,
  WHOAMI_ARGV,
  writePrivateFileExclusive,
} from "../scripts/dist/installer/fsutil.mjs";
import { setProviderLine } from "../scripts/dist/installer/hermes/config-edit.mjs";
import { makeTempDir } from "./helpers/temp-dir.js";

const T = { timeout: 30_000 };
const USER_SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";

/**
 * A stub execFileSync: `whoami` prints one CSV line; `icacls` calls `icacls(args)` first (it may throw), then behaves like
 * the tool for the two things the code reads back: `/save <file>` writes the DACL as UTF-16LE SDDL (user + SYSTEM + the
 * `extras` trustees still present), and `/remove *<SID>…` drops those extras (unless `keepOnRemove`).
 */
function stub({ whoami, icacls, extras = [], keepOnRemove = false } = {}) {
  const calls = [];
  let present = [...extras]; // SDDL trustees as icacls would print them (alias or SID)
  const fn = (path, args, opts) => {
    const cmd = /\\System32\\(whoami|icacls)\.exe$/i.exec(path)?.[1];
    calls.push({ cmd, path, args, opts });
    if (cmd === "whoami") return whoami ? whoami() : `"host\\runner","${USER_SID}"\r\n`;
    if (cmd !== "icacls") throw new Error(`unexpected command ${path}`);
    const out = icacls ? icacls(args) : "";
    if (args[1] === "/save") {
      const aces = [USER_SID, "SY", ...present].map((t) => `(A;OICI;FA;;;${t})`).join("");
      writeFileSync(args[2], Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${args[0]}\r\nD:PAI${aces}\r\n`, "utf16le")]));
    } else if (args[1] === "/remove" && !keepOnRemove) {
      const gone = new Set(args.filter((a) => a.startsWith("*")).map((a) => a.slice(1)));
      present = present.filter((t) => !gone.has(WELL.get(t) ?? t));
    }
    return out;
  };
  return { fn, calls, icaclsCalls: () => calls.filter((c) => c.cmd === "icacls") };
}
const WELL = new Map([["BA", "S-1-5-32-544"], ["BU", "S-1-5-32-545"], ["LA", "S-1-5-21-1111111111-2222222222-3333333333-500"]]);

const fail = (props) => () => { throw Object.assign(new Error("tool failed"), props); };
const isAclError = (code) => (e) => e instanceof PrivateAclError && e.code === code;

describe("privateAclArgv", T, () => {
  it("grants the user SID and SYSTEM full control with (OI)(CI) on a directory and removes inheritance", () => {
    assert.deepEqual(privateAclArgv("C:\\x\\snapshots", { userSid: USER_SID, directory: true }), [
      "C:\\x\\snapshots", "/inheritance:r", "/grant:r", `*${USER_SID}:(OI)(CI)F`, `*${SYSTEM_SID}:(OI)(CI)F`, "/q",
    ]);
  });

  it("grants plain F on a file, keeps a path with spaces and shell metacharacters as one argument", () => {
    const p = "C:\\Users\\A B\\a&b|c;d.yaml";
    assert.deepEqual(privateAclArgv(p, { userSid: USER_SID, directory: false }), [p, "/inheritance:r", "/grant:r", `*${USER_SID}:F`, "*S-1-5-18:F", "/q"]);
  });

  it("refuses anything that is not a SID (no account names, no injection)", () => {
    for (const bad of ["runner", "Everyone", `${USER_SID}:F /grant *S-1-1-0`, "", undefined]) {
      assert.throws(() => privateAclArgv("C:\\x", { userSid: bad, directory: true }), /not a SID/);
    }
  });
});

describe("applyPrivateAcl with a stubbed icacls", T, () => {
  it("resolves the SID with whoami, then runs icacls by argv with a hard timeout and no shell", () => {
    const s = stub();
    assert.deepEqual(applyPrivateAcl("C:\\h\\backups", { directory: true, platform: "win32", execFile: s.fn }), { applied: true, mechanism: "acl" });
    assert.deepEqual(s.calls.map((c) => c.cmd), ["whoami", "icacls", "icacls"]);
    assert.deepEqual(s.calls[0].args, [...WHOAMI_ARGV]);
    assert.deepEqual(s.calls[1].args, privateAclArgv("C:\\h\\backups", { userSid: USER_SID, directory: true }));
    assert.deepEqual(s.calls[2].args.slice(0, 2), ["C:\\h\\backups", "/save"], "the DACL is read back");
    for (const c of s.calls) {
      assert.ok(win32.isAbsolute(c.path), `absolute System32 path, not a PATH search: ${c.path}`);
      assert.equal(c.opts.shell, undefined, "never through a shell");
      assert.ok(c.opts.timeout > 0 && c.opts.timeout <= 15_000, "hard timeout");
      assert.equal(c.opts.windowsHide, true);
    }
    applyPrivateAcl("C:\\h\\other", { directory: false, platform: "win32", execFile: s.fn });
    assert.equal(s.calls.filter((c) => c.cmd === "whoami").length, 1, "the SID is resolved once per process");
  });

  it("does nothing off Windows", () => {
    const s = stub();
    assert.deepEqual(applyPrivateAcl("/x", { directory: true, platform: "linux", execFile: s.fn }), { applied: false, reason: "unsupported-platform" });
    assert.equal(s.calls.length, 0);
  });

  it("fails closed with acl-tool-unavailable when icacls is missing", () => {
    const s = stub({ icacls: fail({ code: "ENOENT" }) });
    assert.throws(() => applyPrivateAcl("C:\\h\\snap", { directory: true, platform: "win32", execFile: s.fn }), (e) => {
      assert.ok(isAclError("acl-tool-unavailable")(e));
      assert.equal(e.path, "C:\\h\\snap");
      assert.match(e.message, /refusing to keep private data there/);
      return true;
    });
  });

  it("fails closed with acl-failed on a non-zero exit, a timeout or a kill", () => {
    const cases = [
      [{ status: 5, stderr: "C:\\h\\snap: Access is denied.\r\nSuccessfully processed 0 files" }, /exit 5, C:\\h\\snap: Access is denied\./],
      [{ code: "ETIMEDOUT", signal: "SIGTERM" }, /timed out/],
      [{ signal: "SIGKILL" }, /killed by SIGKILL/],
    ];
    for (const [props, msg] of cases) {
      const s = stub({ icacls: fail(props) });
      assert.throws(() => applyPrivateAcl("C:\\h\\snap", { directory: true, platform: "win32", execFile: s.fn }), (e) => isAclError("acl-failed")(e) && msg.test(e.message));
    }
  });

  it("fails closed when the user's SID cannot be determined", () => {
    assert.throws(() => currentUserSid({ execFile: stub({ whoami: fail({ code: "ENOENT" }) }).fn }), isAclError("acl-tool-unavailable"));
    assert.throws(() => currentUserSid({ execFile: stub({ whoami: fail({ status: 1 }) }).fn }), isAclError("acl-user-unknown"));
    assert.throws(() => currentUserSid({ execFile: stub({ whoami: () => '"host\\runner","not-a-sid"\r\n' }).fn }), isAclError("acl-user-unknown"));
    const s = stub({ whoami: () => "" });
    assert.throws(() => applyPrivateAcl("C:\\x", { directory: true, platform: "win32", execFile: s.fn }), isAclError("acl-user-unknown"));
    assert.equal(s.icaclsCalls().length, 0, "no icacls run without a SID");
  });
});

describe("applyPrivateAcl removes every other account (the real-icacls finding)", T, () => {
  const dir = "C:\\h\\backups";
  it("removes an explicit BUILTIN\\Administrators entry (alias BA) and checks again", () => {
    const s = stub({ extras: ["BA"] });
    assert.deepEqual(applyPrivateAcl(dir, { directory: true, platform: "win32", execFile: s.fn }), { applied: true, mechanism: "acl" });
    assert.deepEqual(s.icaclsCalls().map((c) => c.args[1]), ["/inheritance:r", "/save", "/remove", "/save"]);
    assert.deepEqual(s.icaclsCalls()[2].args, [dir, "/remove", "*S-1-5-32-544", "/q"]);
  });

  it("removes literal SIDs and domain aliases (LA is <user's domain>-500), each once, sorted", () => {
    const s = stub({ extras: ["BU", "S-1-1-0", "LA", "BU"] });
    applyPrivateAcl(dir, { directory: false, platform: "win32", execFile: s.fn });
    assert.deepEqual(s.icaclsCalls()[2].args.filter((a) => a.startsWith("*")), [
      "*S-1-1-0", `*${USER_SID.replace(/-1001$/, "-500")}`, "*S-1-5-32-545",
    ]);
  });

  it("fails closed when an entry is still there after /remove", () => {
    const s = stub({ extras: ["BA"], keepOnRemove: true });
    assert.throws(() => applyPrivateAcl(dir, { directory: true, platform: "win32", execFile: s.fn }), (e) => isAclError("acl-failed")(e) && /still granted after \/remove: S-1-5-32-544/.test(e.message));
  });

  it("fails closed on an alias it cannot resolve instead of guessing", () => {
    const s = stub({ extras: ["ZZ"] });
    assert.throws(() => applyPrivateAcl(dir, { directory: true, platform: "win32", execFile: s.fn }), (e) => isAclError("acl-failed")(e) && /unknown SDDL alias in the DACL: ZZ/.test(e.message));
    assert.equal(s.icaclsCalls().some((c) => c.args[1] === "/remove"), false);
  });

  it("leaves only the user and SYSTEM alone (no /remove) and reads the saved DACL once", () => {
    const s = stub();
    applyPrivateAcl(dir, { directory: true, platform: "win32", execFile: s.fn });
    assert.deepEqual(s.icaclsCalls().map((c) => c.args[1]), ["/inheritance:r", "/save"]);
  });
});

describe("SDDL helpers", T, () => {
  it("othersInDacl ignores the user and SYSTEM in any spelling and sorts the rest", () => {
    const sddl = `D:PAI(A;OICI;FA;;;${USER_SID})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;S-1-5-18)(A;;0x1200a9;;;BU)`;
    assert.deepEqual(othersInDacl(sddl, USER_SID), ["S-1-5-32-544", "S-1-5-32-545"]);
  });
  it("savedSddlLine reads the UTF-16LE file icacls writes, with or without a BOM", () => {
    const text = "C:\\x\r\nD:PAI(A;;FA;;;SY)\r\n";
    for (const bytes of [Buffer.from(text, "utf16le"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")])]) {
      assert.equal(savedSddlLine(bytes), "D:PAI(A;;FA;;;SY)");
    }
    assert.equal(savedSddlLine(Buffer.from("no dacl here", "utf16le")), null);
  });
});

describe("PrivateAclError tells what to do", T, () => {
  it("every code names the cause and an action; nothing private was written", () => {
    for (const [code, hint] of [["acl-tool-unavailable", /AppLocker|policy/], ["acl-user-unknown", /signed-in user/], ["acl-failed", /exFAT\/FAT, a network share/]]) {
      const e = new PrivateAclError(code, "C:\\h\\snap", "x");
      assert.match(e.message, /refusing to keep private data there/);
      assert.match(e.message, /What to do:/);
      assert.match(e.message, hint);
    }
  });
});

describe("ensurePrivateDir on win32 (stubbed icacls)", T, () => {
  it("creates the directory and gives it the inheritable private ACL", () => {
    const root = makeTempDir("m6-dir-");
    const dir = join(root, "backups", "host-update");
    const s = stub();
    ensurePrivateDir(dir, { platform: "win32", execFile: s.fn });
    assert.ok(statSync(dir).isDirectory());
    assert.deepEqual(s.icaclsCalls()[0].args, privateAclArgv(dir, { userSid: USER_SID, directory: true }));
    assert.equal(s.icaclsCalls().length, 2, "grant, then read back; nothing else to remove");
  });

  it("throws (fail closed) when icacls fails, so the caller writes no snapshot there", () => {
    const root = makeTempDir("m6-dir-");
    const s = stub({ icacls: fail({ status: 1332 }) });
    assert.throws(() => ensurePrivateDir(join(root, "snapshots"), { platform: "win32", execFile: s.fn }), isAclError("acl-failed"));
  });

  it("never re-ACLs through a symlink", { skip: process.platform === "win32" ? "creating a symlink needs a privilege on Windows" : false }, () => {
    const root = makeTempDir("m6-dir-");
    mkdirSync(join(root, "target"));
    symlinkSync(join(root, "target"), join(root, "link"));
    const s = stub();
    ensurePrivateDir(join(root, "link"), { platform: "win32", execFile: s.fn });
    assert.equal(s.icaclsCalls().length, 0);
  });
});

describe("the Hermes config.yaml backup is locked before its first byte (stubbed icacls, any OS)", T, () => {
  it("setProviderLine on win32 makes the backup private while it is still empty, then fills it", () => {
    const hermesHome = makeTempDir("m6-hermes-");
    const original = "model: x\napi_key: K6-SECRET\n";
    writeFileSync(join(hermesHome, "config.yaml"), original);
    const backupSizes = [];
    const s = stub({ icacls: (args) => { if (args[0].includes("plur1bus-bak-")) backupSizes.push(statSync(args[0]).size); return ""; } });
    const { backup } = setProviderLine({ hermesHome, value: "plur1bus", platform: "win32", execFile: s.fn });
    assert.ok(backup && existsSync(backup));
    assert.ok(backupSizes.length >= 2 && backupSizes.every((n) => n === 0), `every icacls call saw the empty backup: ${backupSizes}`);
    assert.equal(readFileSync(backup, "utf8"), original, "then the content was written");
    assert.deepEqual(s.icaclsCalls()[0].args, privateAclArgv(backup, { userSid: USER_SID, directory: false }));
  });

  it("writes no backup and leaves config.yaml untouched when the ACL step fails", () => {
    const hermesHome = makeTempDir("m6-hermes-");
    const original = "model: x\napi_key: K6-SECRET\n";
    writeFileSync(join(hermesHome, "config.yaml"), original);
    const s = stub({ icacls: fail({ status: 5, stderr: "Access is denied." }) });
    assert.throws(() => setProviderLine({ hermesHome, value: "plur1bus", platform: "win32", execFile: s.fn }), isAclError("acl-failed"));
    assert.deepEqual(readdirSync(hermesHome), ["config.yaml"], "no backup file, no temp file");
    assert.equal(readFileSync(join(hermesHome, "config.yaml"), "utf8"), original);
  });
});

describe("writePrivateFileExclusive (stubbed icacls)", T, () => {
  it("sets the ACL on the still-empty file, then writes the bytes", () => {
    const root = makeTempDir("m6-file-");
    const p = join(root, "config.yaml.plur1bus-bak-x");
    const sizes = [];
    const s = stub({ icacls: (args) => { sizes.push(statSync(args[0]).size); return ""; } });
    writePrivateFileExclusive(p, "api_key: K6-SECRET\n", { platform: "win32", execFile: s.fn });
    assert.ok(sizes.length > 0 && sizes.every((n) => n === 0), `no byte before the ACL, also not while it is read back: ${sizes}`);
    assert.deepEqual(s.icaclsCalls()[0].args, privateAclArgv(p, { userSid: USER_SID, directory: false }));
    assert.equal(readFileSync(p, "utf8"), "api_key: K6-SECRET\n");
  });

  it("removes the empty file and writes nothing when icacls fails", () => {
    const root = makeTempDir("m6-file-");
    const p = join(root, "config.yaml.plur1bus-bak-x");
    const s = stub({ icacls: fail({ code: "ENOENT" }) });
    assert.throws(() => writePrivateFileExclusive(p, "api_key: K6-SECRET\n", { platform: "win32", execFile: s.fn }), isAclError("acl-tool-unavailable"));
    assert.equal(existsSync(p), false);
  });

  it("is exclusive and 0600 on POSIX", { skip: process.platform === "win32" ? "POSIX modes" : false }, () => {
    const root = makeTempDir("m6-file-");
    const p = join(root, "bak");
    writePrivateFileExclusive(p, "x");
    assert.equal(statSync(p).mode & 0o777, 0o600);
    assert.throws(() => writePrivateFileExclusive(p, "y"), { code: "EEXIST" });
  });
});

// ---- real icacls (win32 only) ----------------------------------------------------------------------------------

/** The ACE lines `icacls <path>` prints (`<name>:(flags)…`), the path prefix and the summary line removed. */
function aces(path) {
  const out = execFileSync(systemTool("icacls"), [path], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
  return out
    .split(/\r?\n/)
    .map((l, i) => (i === 0 ? l.slice(path.length) : l).trim())
    .filter((l) => /:\(/.test(l));
}
const BROAD = /Everyone|BUILTIN\\Users|Authenticated Users|S-1-1-0|S-1-5-32-545|S-1-5-11\b/i;

describe("real icacls", { skip: process.platform === "win32" ? false : "Windows only (CI windows legs)", timeout: 60_000 }, () => {
  it("ensurePrivateDir leaves exactly the user and SYSTEM, nothing inherited, and children inherit only those", () => {
    const root = makeTempDir("m6-real-");
    const dir = join(root, "backups");
    mkdirSync(dir);
    writeFileSync(join(dir, "old-snapshot.bin"), "before"); // an earlier version's snapshot, created with the parent's ACL
    ensurePrivateDir(dir);
    writeFileSync(join(dir, "new-snapshot.bin"), "after");

    const d = aces(dir);
    assert.equal(d.length, 2, `two ACEs on the directory: ${JSON.stringify(d)}`);
    assert.ok(d.every((l) => !l.includes("(I)")), `nothing inherited: ${JSON.stringify(d)}`);
    assert.ok(d.every((l) => l.includes("(OI)(CI)") && l.includes("(F)")), JSON.stringify(d));
    assert.ok(d.every((l) => !BROAD.test(l)), JSON.stringify(d));
    for (const f of ["old-snapshot.bin", "new-snapshot.bin"]) {
      const a = aces(join(dir, f));
      assert.equal(a.length, 2, `${f}: ${JSON.stringify(a)}`);
      assert.ok(a.every((l) => !BROAD.test(l)), `${f}: ${JSON.stringify(a)}`);
    }
    assert.equal(readFileSync(join(dir, "old-snapshot.bin"), "utf8"), "before", "still readable by the user");
  });

  it("writePrivateFileExclusive leaves a protected user-and-SYSTEM file", () => {
    const root = makeTempDir("m6-real-");
    const p = join(root, "config.yaml.plur1bus-bak-x");
    writePrivateFileExclusive(p, "api_key: K6-SECRET\n");
    const a = aces(p);
    assert.equal(a.length, 2, JSON.stringify(a));
    assert.ok(a.every((l) => !l.includes("(I)") && !BROAD.test(l) && l.includes("(F)")), JSON.stringify(a));
    assert.equal(readFileSync(p, "utf8"), "api_key: K6-SECRET\n");
  });
});
