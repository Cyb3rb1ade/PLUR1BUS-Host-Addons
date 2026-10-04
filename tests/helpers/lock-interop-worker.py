"""TEST ONLY: a Python contender for the shared bindings-registry lock (tests/dist-hermes-lock-interop.test.js).

Uses the harness ExclusiveLockFile (tests/fixtures/hermes/python/_filelock.py, a byte copy of
hosts/hermes/plur1bus/_filelock.py). Per hold it appends to <home>/events.log: E (entered), slow prep
(read the counter, write the temp), then ``held.verify()`` immediately before the publishing replace:
L when that refuses (nothing written) or W right after the replace, then X (left). Every ``die_every``-th
hold (0 = never) logs D after verify and before the replace, then kills itself while still holding
(SIGKILL; TerminateProcess on Windows). It stops when ``until`` passes or the stop file exists.

The guarded publish is test-local (temp, fsync, verify, replace, Windows sharing retries). It does not
import harness ``binding.py``.

Each event is one atomic append: one ``os.write`` on an O_APPEND fd on POSIX, one ``WriteFile`` on a
FILE_APPEND_DATA handle on Windows (the CRT's O_APPEND seeks then writes, which is not atomic across processes).
``PLUR1BUS_LOCK_TEST_TIMES=1`` appends a millisecond timestamp (``checkEvents`` ignores it).

Usage: python -B lock-interop-worker.py <fixture python dir> <plur1bus home> <id> <die_every> <until_epoch_ms> <stop file>
"""

import errno
import os
import signal
import sys
import time

sys.dont_write_bytecode = True  # no __pycache__ beside the byte-copied fixture
sys.path.insert(0, sys.argv[1])
from _filelock import ExclusiveLockFile, LockLost, LockTimeout  # noqa: E402

home, wid, die_every, until, stop = sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5]), sys.argv[6]
lock = ExclusiveLockFile(os.path.join(home, "hosts", ".hermes-bindings.lock"))
events = os.path.join(home, "events.log")
counter = os.path.join(home, "counter")

if os.name == "nt":
    import ctypes
    from ctypes import wintypes

    _k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _k32.CreateFileW.restype = wintypes.HANDLE
    _k32.CreateFileW.argtypes = (wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE)
    _k32.WriteFile.restype = wintypes.BOOL
    _k32.WriteFile.argtypes = (wintypes.HANDLE, wintypes.LPCVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID)
    _k32.CloseHandle.argtypes = (wintypes.HANDLE,)
    _INVALID = ctypes.c_void_p(-1).value

    def append(path, data):
        # FILE_APPEND_DATA, share read/write/delete, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL: every write lands at the end
        h = _k32.CreateFileW(path, 0x0004, 0x0007, None, 4, 0x80, None)
        if not h or h == _INVALID:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            n = wintypes.DWORD()
            if not _k32.WriteFile(h, data, len(data), ctypes.byref(n), None) or n.value != len(data):
                raise ctypes.WinError(ctypes.get_last_error())
        finally:
            _k32.CloseHandle(h)

else:

    def append(path, data):
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            if os.write(fd, data) != len(data):
                raise OSError("short append")
        finally:
            os.close(fd)


def log(kind, seq):
    extra = f" {int(time.time() * 1000)}" if os.environ.get("PLUR1BUS_LOCK_TEST_TIMES") else ""
    append(events, f"{kind} {wid} {seq}{extra}\n".encode())


def die():
    os.kill(os.getpid(), signal.SIGTERM if os.name == "nt" else signal.SIGKILL)
    time.sleep(10)


def _publish(path, text, before_replace):
    """Temp, fsync, then ``before_replace`` immediately before ``os.replace`` and every Windows retry."""
    tmp = f"{path}.tmp-{os.getpid()}"
    try:
        os.unlink(tmp)
    except FileNotFoundError:
        pass
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        payload = text if isinstance(text, (bytes, bytearray)) else text.encode("utf-8")
        os.write(fd, payload)
        os.fsync(fd)
    finally:
        os.close(fd)
    try:
        deadline = time.monotonic() + 10.0
        delay = 0.05
        while True:
            try:
                before_replace()
                os.replace(tmp, path)
                return
            except PermissionError as e:
                transient = os.name == "nt" and (
                    getattr(e, "winerror", None) in (5, 32, 33) or e.errno in (errno.EACCES, errno.EPERM, errno.EBUSY)
                )
                if not transient or time.monotonic() >= deadline:
                    raise
                time.sleep(delay)
                delay = min(delay * 2, 1.0)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


seq = 0
while time.time() * 1000 < until and not os.path.exists(stop):
    try:
        with lock.hold(timeout=10.0) as held:
            seq += 1
            log("E", seq)
            time.sleep(0.002)
            time.sleep(0.003)  # slow prep first: the last verify sits immediately before publish
            n = 0
            if os.path.exists(counter):
                with open(counter, encoding="utf-8") as f:
                    n = int(f.read() or "0")

            def hook() -> None:
                held.verify()
                if die_every and seq % die_every == 0:
                    log("D", seq)
                    die()  # dies holding the lock, after verify and before the replace

            try:
                _publish(counter, str(n + 1), hook)
            except LockLost:
                log("L", seq)  # displaced (FR-L1): the write is refused
                log("X", seq)
                continue
            log("W", seq)
            log("X", seq)
    except LockTimeout:
        pass
