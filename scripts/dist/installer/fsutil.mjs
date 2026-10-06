/**
 * scripts/dist/installer/fsutil.mjs — the installer's shared filesystem helpers.
 *
 * Atomic writes (temp `<name>.tmp-<pid>` → fsync → rename) and, on win32, retries of
 * EPERM/EBUSY/EACCES with backoff for up to 10 s (Defender, spec B.5). Nothing here
 * ever hard-links (R-S8).
 */

import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

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

/**
 * `mkdir -p` with mode 0700 for a directory that holds memory content (store snapshots, home-file backups, K6):
 * created ones get 0700 whatever the umask, an existing one is narrowed to 0700 on POSIX, so snapshots an earlier
 * version left under a 0755 root become unreachable for other users too. A symlink is never chmod-ed (the snapshot
 * module's own path checks decide about it). Windows: this repo has no ACL helper; the directory inherits its
 * parent's ACL (the user profile's, by default private).
 */
export function ensurePrivateDir(path, { platform = process.platform } = {}) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (platform === "win32") return;
  const st = lstatSync(path);
  if (st.isDirectory() && (st.mode & 0o777) !== 0o700) chmodSync(path, 0o700);
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
