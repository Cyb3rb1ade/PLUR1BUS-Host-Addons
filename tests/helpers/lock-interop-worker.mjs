// tests/helpers/lock-interop-worker.mjs — TEST ONLY: a Node contender for the shared bindings-registry lock
// (binding.mjs withRegistryLock) in tests/dist-hermes-lock-interop.test.js; the same event protocol as
// lock-interop-worker.py: E (entered), slow prep (read the counter, write the temp), then assertHeld() immediately
// before the publishing rename: L when that refuses (nothing written) or W right after the rename, then X (left);
// every `dieEvery`-th hold (0 = never) D after verify and before the rename, then SIGKILL while holding. Each event
// is one appendFileSync (libuv opens O_APPEND, FILE_APPEND_DATA on Windows: one atomic append). Stops when `untilMs`
// passes or the stop file exists. The W line is a separate append after the rename (named in lock-fr-l1-analysis.md).
// PLUR1BUS_LOCK_TEST_TIMES=1 appends a millisecond timestamp (checkEvents ignores it).
// Usage: node lock-interop-worker.mjs <plur1bus home> <id> <dieEvery> <untilMs> <stop file>
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { RegistryLockLost, withRegistryLock } from "../../scripts/dist/installer/hermes/binding.mjs";
import { sleepSync, writeFileAtomic } from "../../scripts/dist/installer/fsutil.mjs";

const [home, id, dieEvery, until, stop] = process.argv.slice(2);
const events = join(home, "events.log");
const counter = join(home, "counter");
const log = (kind, seq) => appendFileSync(events, process.env.PLUR1BUS_LOCK_TEST_TIMES ? `${kind} ${id} ${seq} ${Date.now()}\n` : `${kind} ${id} ${seq}\n`);
let seq = 0;
while (Date.now() < Number(until) && !existsSync(stop)) {
  try {
    withRegistryLock(home, ({ assertHeld }) => {
      seq++;
      log("E", seq);
      sleepSync(2);
      sleepSync(3); // slow prep first
      const n = existsSync(counter) ? Number(readFileSync(counter, "utf8") || "0") : 0;
      try {
        writeFileAtomic(counter, String(n + 1), {
          beforeRename: () => {
            assertHeld();
            if (Number(dieEvery) && seq % Number(dieEvery) === 0) {
              log("D", seq);
              process.kill(process.pid, "SIGKILL"); // dies holding the lock, after verify, before the rename
            }
          },
        });
      } catch (err) {
        if (!(err instanceof RegistryLockLost)) throw err;
        log("L", seq);
        log("X", seq);
        return;
      }
      log("W", seq);
      log("X", seq);
    });
  } catch (err) {
    if (err?.code !== "LOCK_TIMEOUT") throw err;
  }
}
