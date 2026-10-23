"""Bounded protocol I/O used by the M11 diagnostic controller.

The controller must never call a potentially blocking pipe flush on its
coordination thread.  This module keeps the worker small and portable so the
timeout contract can be exercised without the pinned OMP binary.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import math
import queue
import threading
import time
from typing import Any, Callable


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


WriteFn = Callable[[bytes], int | None]
FlushFn = Callable[[], bool | None]


@dataclass(frozen=True)
class ControllerBudgets:
    setup_seconds: float = 15.0
    protocol_seconds: float = 60.0
    teardown_seconds: float = 15.0
    watchdog_seconds: float = 120.0
    write_seconds: float = 2.0
    flush_seconds: float = 5.0

    def validate(self) -> None:
        if any(not math.isfinite(v) or v <= 0 for v in vars(self).values()):
            raise ValueError("budgets must be finite and positive")
        if self.setup_seconds > 15:
            raise ValueError("setup budget exceeds 15 seconds")
        if self.protocol_seconds < 60:
            raise ValueError("protocol budget is below 60 seconds")
        if self.teardown_seconds > 15:
            raise ValueError("teardown budget exceeds 15 seconds")
        if self.watchdog_seconds < 90:
            raise ValueError("watchdog budget is below 90 seconds")
        if self.write_seconds > 2 or self.flush_seconds > 5:
            raise ValueError("I/O budget exceeds the M11 limit")
        if self.watchdog_seconds < self.setup_seconds + self.protocol_seconds + self.teardown_seconds:
            raise ValueError("watchdog cannot cover setup, protocol and teardown")


M11_BUDGETS = ControllerBudgets()
M11_BUDGETS.validate()


@dataclass
class _WriteJob:
    payload: bytes
    result: dict[str, Any]
    write_done: threading.Event = field(default_factory=threading.Event)
    done: threading.Event = field(default_factory=threading.Event)
    lock: threading.Lock = field(default_factory=threading.Lock)
    submitted_at: float = 0.0
    write_ended: float | None = None
    flush_started: float | None = None
    flush_ended: float | None = None


class BoundedWriter:
    """Run one write/flush operation away from the controller thread.

    ``write_timeout`` bounds the write milestone and ``flush_timeout`` bounds
    the flush milestone independently.  A timed-out worker is intentionally
    abandoned: the caller can continue protocol processing and close its own
    descriptor during teardown.  The daemon worker is never joined from the
    control path.
    """

    def __init__(
        self,
        write_fn: WriteFn,
        flush_fn: FlushFn,
        *,
        write_timeout: float = 2.0,
        flush_timeout: float = 5.0,
        clock: Callable[[], float] = time.monotonic,
        close_fn: Callable[[], None] = lambda: None,
    ) -> None:
        if not all(math.isfinite(v) and v > 0 for v in (write_timeout, flush_timeout)):
            raise ValueError("writer timeouts must be positive")
        self._write_fn = write_fn
        self._flush_fn = flush_fn
        self.write_timeout = write_timeout
        self.flush_timeout = flush_timeout
        self._clock = clock
        self._close_fn = close_fn
        self._queue: queue.Queue[_WriteJob | None] = queue.Queue()
        self._closed = False
        self._abandoned = False
        self._last_job: _WriteJob | None = None
        self._submitted_at: float | None = None
        self._thread = threading.Thread(target=self._run, name="m11-bounded-writer", daemon=True)
        self._thread.start()

    @staticmethod
    def _snapshot(job: _WriteJob) -> dict[str, Any]:
        with job.lock:
            return {**job.result, "partialWrites": [dict(item) for item in job.result["partialWrites"]]}

    @staticmethod
    def _update(job: _WriteJob, **values: Any) -> None:
        with job.lock:
            job.result.update(values)

    def _run(self) -> None:
        try:
            self._work()
        finally:
            self._close_fn()

    def _work(self) -> None:
        while True:
            job = self._queue.get()
            if job is None:
                return
            payload = job.payload
            phase = "write"
            try:
                self._update(job, writeBeginUtc=utc_now())
                offset = 0
                partial_writes: list[dict[str, Any]] = []
                while offset < len(payload):
                    if self._snapshot(job)["abandoned"]:
                        break
                    returned = self._write_fn(payload[offset:])
                    count = len(payload) - offset if returned is None else int(returned)
                    if count <= 0 or count > len(payload) - offset:
                        raise OSError("invalid-write-count")
                    partial_writes.append({"offset": offset, "bytes": count, "atUtc": utc_now()})
                    offset += count
                    self._update(job, bytesWritten=offset, partialWrites=list(partial_writes))
                job.write_ended = self._clock()
                self._update(
                    job,
                    writeEndUtc=utc_now(),
                    partial=offset != len(payload),
                )
                job.write_done.set()
                if self._snapshot(job)["abandoned"] or offset != len(payload):
                    continue
                phase = "flush"
                job.flush_started = self._clock()
                self._update(job, flushMode="bounded", flushBeginUtc=utc_now())
                flush_result = self._flush_fn()
                job.flush_ended = self._clock()
                self._update(
                    job,
                    flushEndUtc=utc_now(),
                    flushResult=True if flush_result is None else bool(flush_result),
                )
            except BaseException as error:  # the worker must always release its event
                snapshot = self._snapshot(job)
                if phase == "write":
                    job.write_ended = self._clock()
                    self._update(
                        job,
                        writeEndUtc=snapshot["writeEndUtc"] or utc_now(),
                        partial=snapshot["bytesWritten"] != snapshot["bytesAttempted"],
                        writeError=snapshot["writeError"] or type(error).__name__,
                        flushMode="not-used",
                    )
                else:
                    job.flush_ended = self._clock()
                    self._update(job, flushEndUtc=utc_now(), flushError=type(error).__name__)
            finally:
                job.write_done.set()
                self._update(job, completed=True)
                job.done.set()

    def submit(self, payload: bytes, *, request_id: str | int | None = None) -> dict[str, Any]:
        if self._closed or self._abandoned:
            raise RuntimeError("bounded writer is closed or abandoned")
        if self._last_job is not None and not self._last_job.done.is_set():
            raise RuntimeError("bounded writer has an active request")
        started = self._clock()
        result: dict[str, Any] = {
            "requestId": request_id,
            "payloadBytes": len(payload),
            "payloadSha256": hashlib.sha256(payload).hexdigest(),
            "encoding": "utf-8",
            "framing": "newline-delimited-json",
            "newline": payload.endswith(b"\n"),
            "writeBeginUtc": None,
            "writeEndUtc": None,
            "bytesAttempted": len(payload),
            "bytesWritten": 0,
            "partial": bool(payload),
            "partialWrites": [],
            "writeError": None,
            "writeTimeout": False,
            "writeTimeoutMs": int(self.write_timeout * 1000),
            "flushMode": "not-used",
            "flushBeginUtc": None,
            "flushEndUtc": None,
            "flushResult": None,
            "flushError": None,
            "flushTimeoutMs": int(self.flush_timeout * 1000),
            "flushTimedOut": False,
            "controllerBlockedMs": 0.0,
            "abandoned": False,
            "completed": False,
        }
        job = _WriteJob(payload, result, submitted_at=started)
        self._last_job = job
        self._submitted_at = started
        self._queue.put(job)
        return self._snapshot(job)

    def poll(self) -> dict[str, Any] | None:
        job = self._last_job
        if job is None or self._submitted_at is None:
            return None
        if not self._abandoned:
            now = self._clock()
            snapshot = self._snapshot(job)
            write_end = job.write_ended if job.write_ended is not None else now
            if write_end - job.submitted_at >= self.write_timeout:
                self._abandoned = True
                values = {"writeTimeout": True, "abandoned": True}
                if not job.write_done.is_set():
                    values["writeError"] = "write-timeout"
                self._update(job, **values)
            elif job.write_done.is_set() and snapshot["writeError"] is None:
                flush_started = job.flush_started
                flush_end = job.flush_ended if job.flush_ended is not None else now
                if flush_started is not None and flush_end - flush_started >= self.flush_timeout:
                    self._abandoned = True
                    self._update(job, flushTimedOut=True, abandoned=True)
        snapshot = self._snapshot(job)
        snapshot["controllerBlockedMs"] = 0.0
        return snapshot

    def write(self, payload: bytes, *, request_id: str | int | None = None) -> dict[str, Any]:
        """Compatibility helper for focused tests; the controller uses submit/poll."""
        started = self._clock()
        self.submit(payload, request_id=request_id)
        deadline = started + max(self.write_timeout, self.flush_timeout)
        while self._clock() < deadline:
            result = self.poll()
            if result is not None and (result["completed"] or result["abandoned"]):
                result["controllerBlockedMs"] = round((self._clock() - started) * 1000, 3)
                return result
            time.sleep(0.005)
        result = self.poll() or {}
        if not result.get("completed"):
            self._abandoned = True
            if self._last_job is not None:
                if self._last_job.flush_started is not None:
                    self._update(self._last_job, flushTimedOut=True, abandoned=True)
                else:
                    self._update(self._last_job, writeTimeout=True, writeError="write-timeout", abandoned=True)
                result = self._snapshot(self._last_job)
        result["controllerBlockedMs"] = round((self._clock() - started) * 1000, 3)
        return result

    def close(self, *, join_timeout: float = 0.0) -> bool:
        if not self._closed:
            self._closed = True
            self._queue.put(None)
        if join_timeout > 0:
            self._thread.join(join_timeout)
        return not self._thread.is_alive()

    @property
    def abandoned(self) -> bool:
        return self._abandoned

    @property
    def last_result(self) -> dict[str, Any] | None:
        return self.poll()

    @property
    def thread_alive(self) -> bool:
        return self._thread.is_alive()
