// tests/helpers/registry-lock-worker.mjs — TEST ONLY: one contender for the shared bindings-registry lock
// (binding.mjs withRegistryLock) in the JS-only contention test of tests/dist-hermes-install.test.js. Per hold it
// appends to <home>/events.log (tests/helpers/lock-events.mjs format, with a timestamp): E (entered), slow prep
// (read entries.log, write the temp), then assertHeld() immediately before the publishing rename: L when that
// refuses (RegistryLockLost; nothing is written), else W right after the rename, then X (left). Every `dieEvery`-th
// hold (0 = never) it logs D after the check and exits while still holding the lock, as a killed installer would
// (its pid is then dead and the lock stale after 1 s). Each event is one appendFileSync: libuv opens O_APPEND
// (FILE_APPEND_DATA on Windows), so every append is atomic across processes. The W line is a separate append after
// the rename (named in lock-fr-l1-analysis.md).
// Usage: node registry-lock-worker.mjs <plur1bus home> <id> <dieEvery> <untilMs>
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { sleepSync, writeFileAtomic } from "../../scripts/dist/installer/fsutil.mjs";
import { RegistryLockLost, withRegistryLock } from "../../scripts/dist/installer/hermes/binding.mjs";

const [home, id, dieEvery, until] = process.argv.slice(2);
const events = join(home, "events.log");
const entries = join(home, "entries.log");
const log = (kind, seq) => appendFileSync(events, `${kind} ${id} ${seq} ${Date.now()}\n`);
let seq = 0;
while (Date.now() < Number(until)) {
  try {
    withRegistryLock(home, ({ assertHeld }) => {
      seq++;
      log("E", seq);
      sleepSync(2);
      sleepSync(3); // slow prep first: the last verify sits immediately before publish
      const prev = existsSync(entries) ? readFileSync(entries, "utf8") : "";
      try {
        writeFileAtomic(entries, `${prev}${id} ${seq}\n`, {
          beforeRename: () => {
            assertHeld();
            if (Number(dieEvery) && seq % Number(dieEvery) === 0) {
              log("D", seq);
              process.exit(3); // dies holding the lock, after verify and before the rename
            }
          },
        });
      } catch (err) {
        if (!(err instanceof RegistryLockLost)) throw err;
        log("L", seq); // displaced (FR-L1): the write is refused
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
