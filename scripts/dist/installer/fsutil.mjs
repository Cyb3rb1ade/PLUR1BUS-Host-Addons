/**
 * scripts/dist/installer/fsutil.mjs — the installer's shared filesystem helpers.
 *
 * Atomic writes (temp `<name>.tmp-<pid>` → fsync → rename) and, on win32, retries of
 * EPERM/EBUSY/EACCES with backoff for up to 10 s (Defender, spec B.5). Nothing here
 * ever hard-links (R-S8).
 */

import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, win32 } from "node:path";

const WIN_RETRY = new Set(["EPERM", "EBUSY", "EACCES"]);

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Run `fn`; on win32 retry EPERM/EBUSY/EACCES with backoff for up to 10 s. */
export function withWinRetry(fn, { platform = process.platform } = {}) {
  const deadline = Date.now() + 10_000;
  for (let delay = 50; ; delay = Math.min(delay * 2, 1000)) {
    try {
      return fn();
    } catch (err) {
      if (platform !== "win32" || !WIN_RETRY.has(err?.code) || Date.now() > deadline) throw err;
      sleepSync(delay);
    }
  }
}

export function renameWithRetry(from, to) {
  return withWinRetry(() => renameSync(from, to));
}

/** The SID of LocalSystem (`NT AUTHORITY\SYSTEM`), granted next to the user like the harness's `run/` ACL (S11). */
export const SYSTEM_SID = "S-1-5-18";
const SID = /^S-1-\d+(-\d+)+$/;
const ACL_TOOL_TIMEOUT_MS = 15_000;

/**
 * `%SystemRoot%\System32\<name>.exe` by absolute path: a bare name would let Windows' process search pick up a
 * planted `icacls.exe`/`whoami.exe` from the current directory or an early PATH entry.
 */
export function systemTool(name, env = process.env) {
  return win32.join(env.SystemRoot || env.SYSTEMROOT || "C:\\Windows", "System32", `${name}.exe`);
}

/**
 * Why a private Windows ACL could not be set (M-6). `code` is "acl-tool-unavailable" (icacls or whoami missing,
 * the harness's `SecurePathResult.reason`), "acl-user-unknown" (no SID for the current user) or "acl-failed"
 * (icacls exited non-zero, was killed or timed out). Callers never write memory content to `path` after it.
 */
export class PrivateAclError extends Error {
  constructor(code, path, detail) {
    super(`cannot restrict ${path} to the current user and SYSTEM (${code}${detail ? `: ${detail}` : ""}); refusing to keep private data there`);
    this.name = "PrivateAclError";
    this.code = code;
    this.path = path;
  }
}

const sidCache = new WeakMap();

function toolFailure(err) {
  if (err?.code === "ENOENT") return { code: "acl-tool-unavailable", detail: "not found" };
  if (err?.code === "ETIMEDOUT" || err?.signal) return { code: "acl-failed", detail: err.code === "ETIMEDOUT" ? `timed out after ${ACL_TOOL_TIMEOUT_MS} ms` : `killed by ${err.signal}` };
  const first = String(err?.stderr ?? "").trim().split(/\r?\n/)[0];
  return { code: "acl-failed", detail: `exit ${err?.status ?? "?"}${first ? `, ${first}` : ""}` };
}

/** argv for `whoami`: one CSV line `"<domain>\<user>","<SID>"`, locale-independent (no header, no names parsed). */
export const WHOAMI_ARGV = Object.freeze(["/user", "/fo", "csv", "/nh"]);

/** The current user's SID via `whoami /user` (argv, no shell, hard timeout), cached per `execFile`; throws PrivateAclError. */
export function currentUserSid({ execFile = execFileSync, path = "" } = {}) {
  if (sidCache.has(execFile)) return sidCache.get(execFile);
  let out;
  try {
    out = String(execFile(systemTool("whoami"), [...WHOAMI_ARGV], { encoding: "utf8", windowsHide: true, timeout: ACL_TOOL_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] }));
  } catch (err) {
    const f = toolFailure(err);
    throw new PrivateAclError(f.code === "acl-tool-unavailable" ? f.code : "acl-user-unknown", path, `whoami ${f.detail}`);
  }
  const sid = out.trim().split(/\r?\n/)[0]?.split(",").map((f) => f.trim().replace(/^"|"$/g, "")).find((f) => SID.test(f));
  if (!sid) throw new PrivateAclError("acl-user-unknown", path, "whoami printed no SID");
  sidCache.set(execFile, sid);
  return sid;
}

/**
 * icacls argv that leaves `path` with exactly two ACEs, nothing inherited (the harness's ruling S11:
 * `icacls <p> /inheritance:r /grant:r *<user SID>:(F) *S-1-5-18:(F)`). A directory's grants carry (OI)(CI), so every
 * file and subdirectory created in it later is user-and-SYSTEM-only from its first byte, and icacls re-propagates
 * them to the unprotected children already there. SIDs (`*S-…`), never account names: localized or multi-word names
 * do not parse. Explicit (non-inherited) ACEs for other SIDs are not removed; the installer never creates any.
 */
export function privateAclArgv(path, { userSid, directory }) {
  if (!SID.test(String(userSid))) throw new Error(`not a SID: ${JSON.stringify(userSid)}`);
  const inherit = directory ? "(OI)(CI)" : "";
  return [path, "/inheritance:r", "/grant:r", `*${userSid}:${inherit}F`, `*${SYSTEM_SID}:${inherit}F`, "/q"];
}

/**
 * win32: run icacls (argv, no shell, hard timeout) to make `path` user-and-SYSTEM-only. Fails closed: any failure
 * throws PrivateAclError, and the caller must not put private data at `path`. No-op elsewhere.
 */
export function applyPrivateAcl(path, { directory, platform = process.platform, execFile = execFileSync } = {}) {
  if (platform !== "win32") return { applied: false, reason: "unsupported-platform" };
  const userSid = currentUserSid({ execFile, path });
  try {
    execFile(systemTool("icacls"), privateAclArgv(path, { userSid, directory }), { encoding: "utf8", windowsHide: true, timeout: ACL_TOOL_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const f = toolFailure(err);
    throw new PrivateAclError(f.code, path, `icacls ${f.detail}`);
  }
  return { applied: true, mechanism: "acl" };
}

/**
 * `mkdir -p` with mode 0700 for a directory that holds memory content (store snapshots, home-file backups, K6):
 * created ones get 0700 whatever the umask, an existing one is narrowed to 0700 on POSIX, so snapshots an earlier
 * version left under a 0755 root become unreachable for other users too. A symlink (on Windows also a junction) is
 * never chmod-ed or re-ACL-ed (the snapshot module's own path checks decide about it). Windows (M-6): the directory
 * gets a protected user-and-SYSTEM ACL inherited by everything created in it (`applyPrivateAcl`); if icacls fails
 * this throws PrivateAclError before any private data lands there.
 */
export function ensurePrivateDir(path, { platform = process.platform, execFile = execFileSync } = {}) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  if (!st.isDirectory()) return;
  if (platform === "win32") {
    applyPrivateAcl(path, { directory: true, platform, execFile });
    return;
  }
  if ((st.mode & 0o777) !== 0o700) chmodSync(path, 0o700);
}

/**
 * Create `path` exclusively (mode 0600), make it private before the first byte (win32: `applyPrivateAcl`, fail
 * closed — the empty file is removed again), then write `bytes`. For a copy of a file that may hold secrets
 * (Hermes' config.yaml backup).
 */
export function writePrivateFileExclusive(path, bytes, { platform = process.platform, execFile = execFileSync } = {}) {
  const fd = openSync(path, "wx", 0o600);
  let written = false;
  try {
    applyPrivateAcl(path, { directory: false, platform, execFile });
    writeSync(fd, bytes);
    fsyncSync(fd);
    written = true;
  } finally {
    closeSync(fd);
    if (!written) rmSync(path, { force: true });
  }
}

export function rmTree(path) {
  return withWinRetry(() => rmSync(path, { recursive: true, force: true }));
}

/**
 * temp `<name>.tmp-<pid>` (mode 0600, exclusive) → fsync → close → rename.
 * Optional `beforeRename` runs after fsync/close and again before every win32 rename retry
 * (a sharing-violation backoff reopens the window). If it throws, the temp is deleted and
 * the original error is rethrown. Unguarded callers omit the hook.
 */
export function writeFileAtomic(path, bytes, { beforeRename, platform = process.platform, rename = renameSync } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  rmSync(tmp, { force: true }); // a stale temp of a reused pid must not lend its mode
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    withWinRetry(() => {
      if (beforeRename) beforeRename();
      rename(tmp, path);
    }, { platform });
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
