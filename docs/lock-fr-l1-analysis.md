# FR-L1 overlap: verify-then-write window

Analysis only. The lock protocol in `binding.mjs` is unchanged. Harness
`_filelock.py` is not touched (Copilot, harness PR #73).

## Evidence

### CI (Linux pack, 2026-10-04)

`plugin-dist` run `37201610753` attempt 1, job `pack` on `ubuntu-24.04`. Test
“the registry lock under contention…” (`tests/dist-hermes-install.test.js`).
Duration 8410 ms (the 8 s race plus teardown). Not a timeout.

```
entries 47, writes 38, refused (L) 1, deaths 8; overlaps 1,
of them the FR-L1 case (the displaced holder's assertHeld refused) 0
overlap at line 58: w3-1#1 entered while w1-3#1 was inside
line 61: w1-3#1 wrote although a newcomer entered after it (its verify should have refused)
line 62: w1-3#1 was displaced (someone entered after it) but its verify did not refuse
```

`w1-3#1` is the first hold of a replacement worker (`dieEvery` 5, so this hold
does not kill itself). Time from enter to write in the worker is a 2 ms pause,
`assertHeld()`, a 3 ms pause, then the append. The lock token is milliseconds
old. The 1 s dead-pid rule and the 60 s mtime rule cannot judge that token
stale.

The newcomer `w3-1#1` therefore entered because a waiter moved the live lock
aside: it had judged a *predecessor* (a dead holder) stale, then `rename`d
whatever now sat at the path. That is the put-back window already documented
in `withRegistryLock`. `checkEvents` did not report a second writer still
inside at `W` time, so the newcomer either refused (the one `L`) or wrote
after `w1-3#1` left. Two processes were in the critical section; the displaced
holder published.

### Forced interleaving (this PR)

`tests/dist-hermes-lock-fr-l1.test.js` uses the same waiter-`rename` as the
existing put-back-window test, with the worker’s order: `assertHeld()`
succeeds, the lock is moved, a third process enters and writes, the holder
writes without calling `assertHeld()` again. `checkEvents` reports the same
two violations as CI. Today’s code allows that write.

The sibling test in `dist-hermes-install.test.js` calls `assertHeld()` *after*
the newcomer is inside and expects `L`. Both results together: verify still
sees a displacement; a verify that already returned does not.

### Contention loop

`node tests/helpers/lock-fr-l1-loop.mjs 80 8000 1` on Darwin / Node v26.8.2
(same 6 groups, 8 s, die every 5th hold as CI): 696 s elapsed.

| | runs |
|---|---|
| total | 80 |
| overlap (any) | 4 (5 %) |
| overlap, displaced holder refused (accepted FR-L1) | 3 |
| overlap, displaced holder wrote (CI failure) | 1 (1.25 %) |
| holds | E 3842, W 3179, L 4, D 659 |

The published hit (run 79) has the same shape as the Linux pack failure
(E 47, W 38, L 1, D 8). Excerpt, timestamps only:

```
78: E w5-5#5
79: D w5-5#5
80: E w4-10#4          ← 1001 ms after D (dead-pid rule)
81: E w6-9#1           ← same millisecond: newcomer
82: L w6-9#1           ← newcomer refused
84: W w4-10#4          ← holder that already passed assertHeld published
85: X w4-10#4
```

A dead predecessor is broken after 1 s, then two processes enter in the same
millisecond. That is the put-back window, not a live pid judged dead. Linux CI
hit the published case in one 8 s pack run; this loop hit it once in 80.

### Not the 1 s dead-pid rule (c)

`judgedStale` returns false while `age < 1000` ms, and `process.kill(pid, 0)`
on a live pid does not throw `ESRCH`. The characterisation test holds a live
lock for 1.3 s; a waiter does not enter. The CI holder was a ~5 ms first hold,
so (c) is not this failure. A live holder *older* than 1 s is still protected
by `kill(pid, 0)` unless that probe lies; this round did not find it lying.

### Not a log-order artefact (a)

Each event is one `appendFileSync` (`O_APPEND`). `W` is logged after the
guarded append. A newcomer can only log `E` if `O_CREAT|O_EXCL` on the lock
path succeeded, which means the previous token was not there. The overlap in
the event log is an overlap in the lock protocol.

Production `registerBinding` calls `assertHeld()` and then `writeFileAtomic`
(write + `fsync` + rename). That `fsync` is the same kind of gap as the
worker’s 3 ms sleep.

## macOS interop

CI `37164306398` attempt 1, `test (macos-15)`: the 3+3 test ran **56.9 s**
(limit 240 s) and failed with the same overlap, not a timeout:

```
entries 1175 (js 471, py 704), writes 1163, lost 1, deaths js 6 py 5, workers 29
takeovers after a death: {"js->py":4,"py->js":4,"js->js":2,"py->py":1}
line 16: js2-4#1 wrote although a newcomer entered after it
line 17: js2-4#1 was displaced but its verify did not refuse
```

Local Darwin, `tests/helpers/lock-interop-measure.mjs`, 8 s contention only:

| | JS | Python |
|---|---|---|
| `_filelock` import / Node hello | 32–35 ms | 22–33 ms |
| enter → write | 3–9 ms (p50 7) | 2–9 ms (p50 7) |
| reacquire after leave | 0–1 ms | 0–2 ms |
| spawn → first enter | p50 3.1 s (min 1.0 s) | p50 4.1 s (min 27 ms) |

The 1.0 s floor on spawn-to-first-enter is the dead-pid rule after a `D`, not
Python startup. Put-back waits (2 s budget, 5 ms poll) did not dominate.
Local 3+3 test: 18.4 s, 734 entries, 0 lost, both takeover directions. The
macos-15 run was slower and hit the same published overlap. Do not raise the
timeout.

## Classification

**(b)** the known TOCTOU between verify and write, which is protocol-inherent
given today’s “`assertHeld()` then mutate” rule and the put-back window that
can move a live lock. Not (a). Not (c) for this CI log.

## Options

### (i) Breaker mutex shared by JS and Python

A second O_EXCL file taken around “re-stat, maybe rename, maybe create”. After
taking it, re-judge; if the token is no longer the stale one, do not rename.
A live lock is never moved aside, so a holder that passed `assertHeld()` keeps
the path until it releases.

- Cost: new protocol on both sides, stale rules for the mutex itself, Windows
  sharing, interop tests. Deadlock if a holder ever waits on the mutex.
  Conflicts with harness PR #73 (`_filelock.py`).
- Risk: medium-high (nested exclusion). Closes two-in-CS, not only the
  publish.

### (ii) Verify after preparing the write, then atomic rename

Write to a temp file (today’s `writeFileAtomic` already does), `assertHeld()`,
then rename into place; delete the temp on `LOCK_LOST`. The worker’s 3 ms
sleep (and production `fsync`) sit *before* the last verify. A displaced
holder logs `L` and does not publish. Same change in JS `registerBinding` /
`unregisterLocked`, the two test workers, and harness `binding.py`.

- Cost: write-path only; lock tokens and break/put-back stay. Harness follow-up
  after #73. Interop workers must verify immediately before the counter
  rename.
- Risk: low-medium. A last-rename race remains between verify and `rename`
  (microseconds). Two processes can still overlap in the section; they must
  not both publish. Matches the ruling: safety rests on verify-before-write.

### (iii) Accept the window and narrow the test

Treat “verify then write 3 ms later” as out of scope. The contention test
would allow a `W` after a newcomer if `assertHeld()` had already passed.

- Cost: small. Risk: high. Production `fsync` is that window. The test would
  stop catching the CI failure.

## Recommendation

Build **(ii)** next. Do not build (i) while `_filelock.py` is in harness PR
#73. Do not do (iii).

(ii) is what `assertHeld()`’s comment already asks for (“call it right before
writing”). The contention worker and `writeFileAtomic` currently leave a
multi-millisecond gap after that call. Closing the gap on both languages
makes the existing FR-L1 tests pass for the reason they were written, without
a second lock.

(i) remains the way to keep a single holder in the critical section. It is a
protocol change for a later round, with Copilot’s `_filelock.py` work landed
first.

The characterisation test in this PR asserts that today’s code still publishes
after displacement. Invert it when (ii) lands.

## (ii) implemented, Node side

`writeFileAtomic` takes an optional `beforeRename` hook. It runs after the temp
file is written, fsynced and closed, and again before every win32 rename retry
(a sharing-violation backoff reopens the window). If the hook throws, the temp
is deleted and the original error is rethrown. Unguarded callers are unchanged.

`writeRegistry` passes `assertHeld` as that hook. `registerBinding` and
`unregisterLocked` no longer call `assertHeld()` on their own; the check lives
inside the write. The JS contention worker and the Node interop worker use the
same order: slow prep (the 3 ms sleep, reading the payload, writing the temp),
then `assertHeld()`, then the publishing rename. They log `W` in a separate
append immediately after the rename returns. That publish-to-`W` gap is one
syscall; `checkEvents` is unchanged. The Python interop worker is unchanged
in this round (harness `binding.py` / `_filelock.py` follow after Copilot’s
PR #73).

The characterisation test is inverted: the same waiter-`rename` interleaving,
then `writeRegistry`; the displaced holder gets `RegistryLockLost`, the
registry is unchanged, no leftover `.tmp-*`, `checkEvents` reports the overlap
with `L` and without the two violations.

### Contention loop after (ii)

`node tests/helpers/lock-fr-l1-loop.mjs 200 8000 1` on Darwin / Node v26.8.2,
1772 s elapsed.

| | before (80 × 8 s) | after (200 × 8 s) |
|---|---|---|
| overlap (any) | 4 (5 %) | 4 (2 %) |
| overlap, displaced holder refused | 3 | 4 |
| overlap, displaced holder wrote | 1 (1.25 %) | **0** |
| holds | E 3842, W 3179, L 4, D 659 | E 9760, W 8104, L 4, D 1652 |
| `checkEvents` violations | 1 run | 0 |

The put-back window still lets a third process in (four overlaps in 200 runs).
Every displaced holder refused. Target for this round was zero published
overlaps; that held.

### Interop 3+3 after (ii)

Local Darwin, `tests/dist-hermes-lock-interop.test.js`, 10× in a row, all
passed. `lost` was 0 in every run. Durations 16.5–24.2 s (limit 240 s). Both
takeover directions appeared in each run. The Python worker still verifies
then sleeps 3 ms then writes; this sample did not hit a published overlap on
that side.

### Remaining window

The last `assertHeld()` and `rename` are still two syscalls. A displaced
holder can in principle pass the check and lose the path before the rename
lands (microseconds). Two processes can still overlap in the section; they
must not both publish. Option (i), a breaker mutex shared with Python, is
what would keep a single holder in the critical section. That stays a later
round, after harness PR #73.

## (ii) Python side

Harness [PR #77](https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/pull/77) adds
`before_replace` to `atomic_write_text` and passes `held.verify` from
`register_binding`. The last verify sits immediately before `os.replace`, and
again before every Windows sharing retry. `_filelock.py` is unchanged
(Copilot, harness issue #75).

This follow-up puts the Python interop worker on the same order as the Node
worker after #6: read the counter, write the temp, `verify` immediately before
`os.replace` (and before every Windows retry), `D` inside the hook, `W` after
the replace. The guarded write is test-local; it does not copy `binding.py`.

### Interop 3+3

Local Darwin, `tests/dist-hermes-lock-interop.test.js`:

| | after Node (ii), Python still verify-then-write | after Python (ii) |
|---|---|---|
| runs | 10 | 20 |
| passed | 10 | 20 |
| `lost` | 0 each run | 0 each run |
| duration | 16.5–24.2 s | 16.3–29.0 s (limit 240 s) |

No published overlap in either sample. Both takeover directions appeared in
each 20-run after the Python worker change.

### Node control loop

`node tests/helpers/lock-fr-l1-loop.mjs 100 8000 1` on Darwin / Node v26.8.2,
870 s. Overlaps 0, published overlaps 0, `checkEvents` violations 0 (E 4742,
W 3929, L 0, D 813). The Node write path from #6 is unchanged.
