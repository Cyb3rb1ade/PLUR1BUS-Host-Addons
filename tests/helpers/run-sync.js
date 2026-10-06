/**
 * tests/helpers/run-sync.js
 *
 * Bounded synchronous child processes for tests.
 *
 * A `spawnSync` / `execFileSync` / `execSync` without `timeout` blocks the event loop, so node:test's
 * `--test-timeout` can never fire for it (a sync test body is not interrupted either way): a wedged child hangs the
 * whole job until the CI runner kills it. These wrappers apply a default `timeout` and `killSignal: "SIGKILL"` (so a
 * child that ignores SIGTERM cannot outlive the limit) and turn a timed-out child into a thrown error that names the
 * command. Caller options win, so a call that needs a different limit passes its own `timeout`.
 *
 * The same idea as tests/helpers/run-sync.js in Cyb3rb1ade/openclaw-plur1bus-memory. The default here is 120 s,
 * the per-test default of `npm test` (--test-timeout): the longest single sync child in the Windows legs is one
 * powershell.exe run of the bootstrap (12-70 s warm to cold), and those calls pass their own, larger limit.
 *
 * Only ETIMEDOUT throws. ENOENT and every other spawn error stay on `result.error`, as with plain spawnSync, so a
 * caller that probes for an optional tool (`minisign`, `python3`) keeps working.
 */

import { execFileSync, execSync, spawnSync } from "node:child_process";

export const DEFAULT_SYNC_TIMEOUT_MS = 120_000;

const bounded = (options) => ({
  timeout: DEFAULT_SYNC_TIMEOUT_MS,
  killSignal: "SIGKILL",
  ...options,
});

const describeCommand = (command, args) =>
  [command, ...(Array.isArray(args) ? args : [])].map(String).join(" ").slice(0, 300);

const timeoutMessage = (command, args, options) =>
  `child process timed out after ${options.timeout} ms and was killed (${options.killSignal}): ${describeCommand(command, args)}`;

/** Drop-in `spawnSync`; throws (code ETIMEDOUT, `.result` attached) if the child hit its timeout. */
export function spawnSyncBounded(command, args, options) {
  if (args !== undefined && !Array.isArray(args)) {
    options = args;
    args = [];
  }
  const opts = bounded(options);
  const result = spawnSync(command, args ?? [], opts);
  if (result.error?.code === "ETIMEDOUT") {
    throw Object.assign(new Error(timeoutMessage(command, args, opts)), { code: "ETIMEDOUT", result });
  }
  return result;
}

function rethrowTimeout(error, command, args, opts) {
  if (error?.code === "ETIMEDOUT") error.message = timeoutMessage(command, args, opts);
  throw error;
}

/** Drop-in `execFileSync`; a timeout rethrows with the command named (other errors untouched). */
export function execFileSyncBounded(command, args, options) {
  if (args !== undefined && !Array.isArray(args)) {
    options = args;
    args = [];
  }
  const opts = bounded(options);
  try {
    return execFileSync(command, args ?? [], opts);
  } catch (error) {
    return rethrowTimeout(error, command, args, opts);
  }
}

/** Drop-in `execSync`; a timeout rethrows with the command line (other errors untouched). */
export function execSyncBounded(command, options) {
  const opts = bounded(options);
  try {
    return execSync(command, opts);
  } catch (error) {
    return rethrowTimeout(error, command, undefined, opts);
  }
}
