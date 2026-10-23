"""M11 regression checks. Only Python helper children are launched, never OMP."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from m11_a1d_io import BoundedWriter, ControllerBudgets

spec = importlib.util.spec_from_file_location("m11_controller", Path(__file__).with_name("a1d_controller.py"))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)
import parse_etw as etw
SCENARIOS = {}


class WriterChecks(unittest.TestCase):
    def test_late_poll_preserves_flush_timeout_after_worker_finishes(self):
        now = [10.0]
        def slow_flush():
            now[0] += .3
            return True
        writer = BoundedWriter(lambda data: len(data), slow_flush,
                               write_timeout=.1, flush_timeout=.2, clock=lambda: now[0])
        writer.submit(b"abc\n")
        self.assertTrue(writer.close(join_timeout=1))
        result = writer.poll()
        self.assertTrue(result["flushTimedOut"])
        self.assertFalse(result["writeTimeout"])
        self.assertTrue(result["abandoned"])

    def test_bounded_wait_abandonment_is_persisted(self):
        release = threading.Event()
        def delayed_write(data):
            time.sleep(.05)
            return len(data)
        writer = BoundedWriter(delayed_write, lambda: release.wait(3),
                               write_timeout=.1, flush_timeout=.15)
        try:
            result = writer.write(b"abc\n")
            self.assertTrue(result["flushTimedOut"])
            self.assertTrue(writer.abandoned)
            self.assertTrue(writer.last_result["abandoned"])
        finally:
            release.set()
            writer.close(join_timeout=1)

    def test_flush_timeout_does_not_block_control_or_become_write_timeout(self):
        release = threading.Event()
        writer = BoundedWriter(lambda data: len(data), lambda: release.wait(3),
                               write_timeout=.1, flush_timeout=.2)
        try:
            start = time.monotonic()
            writer.submit(b'{"id":1}\n', request_id=1)
            self.assertLess(time.monotonic() - start, .05)
            while not writer.last_result["abandoned"] and time.monotonic() - start < 1:
                writer.poll()
                time.sleep(.01)
            result = writer.last_result
            self.assertTrue(result["flushTimedOut"])
            self.assertFalse(result["writeTimeout"])
            self.assertTrue(writer.abandoned)
            self.assertEqual(result["bytesWritten"], 9)
            self.assertIsNone(result["flushEndUtc"])
            json.dumps(result)
        finally:
            release.set()
            self.assertTrue(writer.close(join_timeout=1))

    def test_write_timeout_is_sticky_after_late_completion(self):
        release = threading.Event()
        def blocked(data):
            release.wait(3)
            return len(data)
        writer = BoundedWriter(blocked, lambda: True, write_timeout=.1, flush_timeout=.2)
        try:
            result = writer.write(b"abc\n")
            self.assertTrue(result["writeTimeout"])
            self.assertTrue(result["partial"])
            self.assertIsNone(result["writeEndUtc"])
            with self.assertRaises(RuntimeError):
                writer.submit(b"another\n")
            release.set()
            writer.close(join_timeout=1)
            self.assertTrue(writer.last_result["writeTimeout"])
            self.assertEqual(writer.last_result["flushMode"], "not-used")
        finally:
            release.set()
            writer.close(join_timeout=1)

    def test_late_poll_records_write_that_exceeded_its_deadline(self):
        now = [10.0]

        def slow_write(data):
            now[0] += .3
            return len(data)

        writer = BoundedWriter(slow_write, lambda: True, write_timeout=.1, flush_timeout=.2,
                               clock=lambda: now[0])
        writer.submit(b"abc\n")
        self.assertTrue(writer.close(join_timeout=1))
        result = writer.poll()
        self.assertTrue(result["writeTimeout"])
        self.assertTrue(result["abandoned"])
        self.assertEqual(result["bytesWritten"], 4)

    def test_partial_writes_are_counted_and_error_does_not_claim_delivery(self):
        calls = []
        def short(data):
            calls.append(data)
            if len(calls) == 2:
                raise BrokenPipeError("private path must not be serialized")
            return 2
        writer = BoundedWriter(short, lambda: self.fail("flush after failed write"))
        try:
            result = writer.write(b"abcdef\n")
            self.assertEqual(result["bytesWritten"], 2)
            self.assertTrue(result["partial"])
            self.assertEqual(result["partialWrites"][0]["bytes"], 2)
            self.assertEqual(result["writeError"], "BrokenPipeError")
            self.assertNotIn("private path", json.dumps(result))
        finally:
            writer.close(join_timeout=1)


class HelperProcess:
    mode = "reply"
    creation_delay = 0
    pids = []
    def __init__(self, *args, on_created=None):
        programs = {
            "capture": 'import sys; print("M11_CAPTURE_STDOUT_MARKER",flush=True); sys.stderr.write("M11_CAPTURE_STDERR_MARKER\\n"); sys.exit(7)',
            "reply": 'import sys,json; r=json.loads(sys.stdin.buffer.readline()); print(json.dumps({"jsonrpc":"2.0","id":r["id"],"result":{"agentInfo":{"version":"helper"}}}),flush=True); sys.stderr.write("terminal marker\\n"); sys.stdin.buffer.read()',
            "no-reader": 'import time; time.sleep(30)',
            "silent": 'import time,sys; time.sleep(30); sys.stdin.buffer.read()',
            "native-no-reader": 'import time; time.sleep(30)',
        }
        command = [sys.executable, "-c", programs[self.mode]]
        if self.mode == "native-no-reader":
            command = [str(Path(os.environ["SystemRoot"]) / "System32" / "ping.exe"), "-n", "31", "127.0.0.1"]
        self.child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            creationflags=0x08000000)
        self.pids.append(self.child.pid)
        self.in_write = os.dup(self.child.stdin.fileno())
        self.out_read = os.dup(self.child.stdout.fileno())
        self.err_read = os.dup(self.child.stderr.fileno())
        self.child.stdin.close()
        self.child.stdout.close()
        self.child.stderr.close()
        self.info = types.SimpleNamespace(dwProcessId=self.child.pid)
        self.created_at_utc = c.utc_now()
        self.attestation = {"helperOnly": True}
        if on_created:
            on_created(self)
        time.sleep(self.creation_delay)
    def resume(self):
        return c.utc_now()
    def poll(self):
        return self.child.poll()
    def wait(self, ms):
        try:
            return self.child.wait(timeout=ms / 1000)
        except subprocess.TimeoutExpired:
            return None
    def terminate(self, code=124):
        if self.child.poll() is None:
            self.child.kill()
        self.child.wait(timeout=3)
    def close(self):
        self.terminate()
        for name in ("in_write", "out_read", "err_read"):
            fd = getattr(self, name)
            if fd is not None:
                os.close(fd)
                setattr(self, name, None)


class ControllerChecks(unittest.TestCase):
    def test_watchdog_covers_setup_protocol_and_teardown(self):
        with self.assertRaises(ValueError):
            ControllerBudgets(protocol_seconds=70, watchdog_seconds=90).validate()

    def run_helper(self, mode="reply", full=False, budget_overrides=None, creation_delay=0):
        with tempfile.TemporaryDirectory(prefix="m11-helper-") as folder:
            root = Path(folder)
            for name in ("private", "logs", "work"):
                (root / name).mkdir()
            (root / "private/state.json").write_text(json.dumps({"actualLaunches": 0,
                "pinnedSource": "HELPER-ONLY", "workDirectory": str(root / "work")}))
            (root / "private/prepared.json").write_text(json.dumps({"executable": "HELPER-ONLY",
                "args": [], "cwd": str(root / "work"), "environment": {}}))
            HelperProcess.mode = mode
            HelperProcess.creation_delay = creation_delay
            options = {} if full else {"protocol_seconds": 1.0, "write_seconds": .2,
                "flush_seconds": .3, "teardown_seconds": 2.0}
            budgets = ControllerBudgets(**{**options, **(budget_overrides or {})})
            with patch.object(c, "ContainedProcess", HelperProcess), \
                 patch.object(c, "profile_sid", return_value=None), \
                 patch.object(c, "sha256_file", return_value=c.PINNED_SHA256), \
                 contextlib.redirect_stdout(io.StringIO()):
                c.actual(types.SimpleNamespace(root=str(root), helper_budgets=budgets))
            return json.loads((root / "private/actual.json").read_text(encoding="utf-8"))

    def test_watchdog_during_create_never_resumes_child(self):
        result = self.run_helper("no-reader", creation_delay=.2,
                                 budget_overrides={"watchdog_seconds": .1})
        self.assertTrue(result["watchdogFired"])
        self.assertNotIn("resumedAtUtc", result)
        self.assertEqual(result["protocolEndReason"], "total-watchdog")
        self.assertIsNotNone(result["watchdog"]["terminationUtc"])
        self.assertFalse(result["timing"]["deadlineSatisfied"]["protocol"])

    def test_control_reads_response_before_flush_can_finish(self):
        start = time.monotonic()
        result = self.run_helper()
        self.assertLess(time.monotonic() - start, 4)
        self.assertTrue(result["initializeResponseReceived"])
        self.assertEqual(result["exitCode"], 0)
        self.assertEqual(result["framesSent"], 1)
        self.assertEqual(result["framesReceived"], 1)
        self.assertTrue(result["requestResponseLinkage"][0]["matched"])
        for kind in ("stdout", "stderr"):
            self.assertTrue(result[kind + "Capture"]["eof"])
            self.assertTrue(result[kind + "Capture"]["complete"])
            self.assertEqual(result[kind + "Capture"]["pendingAtEof"], 0)
        self.assertNotIn("controllerDurationMs", result)
        self.assertGreater(result["totalMs"], result["setupMs"])

    def test_no_reader_keeps_controller_live_after_flush_timeout(self):
        result = self.run_helper("no-reader")
        self.assertTrue(result["initializeIo"]["flushTimedOut"])
        self.assertFalse(result["initializeIo"]["writeTimeout"])
        self.assertLess(result["initializeIo"]["controllerBlockedMs"], 5000)
        self.assertEqual(result["protocolEndReason"], "protocol-timeout")
        self.assertFalse(result["watchdogFired"])

    def test_native_no_reader_controller_returns_before_five_seconds(self):
        started = time.monotonic()
        result = self.run_helper("native-no-reader")
        self.assertLess(time.monotonic() - started, 5)
        self.assertTrue(result["initializeIo"]["writeTimeout"] or result["initializeIo"]["flushTimedOut"]
                        or result["initializeIo"]["flushResult"] is False)
        self.assertLess(result["initializeIo"]["controllerBlockedMs"], 5000)
        self.assertIn(result["protocolEndReason"], ("protocol-timeout", "process-exit"))
        self.assertFalse(result["watchdogFired"])


class SelfTestChecks(unittest.TestCase):
    def test_refuses_selftest_without_current_etw_context_before_spawning(self):
        with tempfile.TemporaryDirectory(prefix="m11-linkage-") as folder:
            root = Path(folder)
            (root / "private").mkdir()
            (root / "private/state.json").write_text("{}")
            with patch.object(c.subprocess, "Popen", side_effect=AssertionError("must not spawn")):
                with self.assertRaisesRegex(RuntimeError, "run-context"):
                    c.selftest(types.SimpleNamespace(root=str(root)))

    def test_helper_records_identity_expected_exit_and_exact_capture(self):
        with tempfile.TemporaryDirectory(prefix="m11-linkage-") as folder:
            root = Path(folder)
            HelperProcess.mode = "capture"
            HelperProcess.creation_delay = 0
            with patch.object(c, "ContainedProcess", HelperProcess), patch.object(c, "profile_sid", return_value=None):
                result = c.run_helper({"workDirectory": str(root)}, "HELPER-ONLY", [],
                    root / "stdout.log", root / "stderr.log", expected_exit=7)
            self.assertEqual(result["expectedExitCode"], 7)
            self.assertEqual(result["exitCode"], 7)
            self.assertTrue(result["exitMatched"])
            self.assertEqual(result["parentPid"], os.getpid())
            self.assertIsNotNone(result["createdAtUtc"])
            self.assertIsNotNone(result["exitObservedAtUtc"])
            for name in ("stdout", "stderr"):
                raw = (root / (name + ".log")).read_bytes()
                self.assertEqual(result[name + "Capture"]["bytes"], len(raw))
                self.assertEqual(result[name + "Capture"]["sha256"], hashlib.sha256(raw).hexdigest())
                self.assertTrue(result[name + "Capture"]["complete"])

class FullBudgetChecks(unittest.TestCase):
    def test_production_timeouts_with_child_not_reading_stdin(self):
        child = subprocess.Popen([str(Path(os.environ["SystemRoot"]) / "System32" / "ping.exe"), "-n", "31", "127.0.0.1"],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=0x08000000)
        time.sleep(.25)
        self.assertIsNone(child.poll(), "the no-reader helper must still be alive before the controller writes")
        duplicate = os.dup(child.stdin.fileno())
        child.stdin.close()
        writer = BoundedWriter(lambda data: os.write(duplicate, data),
            lambda: bool(c.flush_file_buffers(c.W.HANDLE(c.msvcrt.get_osfhandle(duplicate)))),
            write_timeout=.5, flush_timeout=.5,
            close_fn=lambda: os.close(duplicate))
        try:
            begin = time.monotonic()
            result = writer.write(b"M" * 4096)
            elapsed_ms = (time.monotonic() - begin) * 1000
            self.assertTrue(result["flushTimedOut"] or result["writeTimeout"] or result["flushResult"] is False)
            self.assertLess(elapsed_ms, 5000)
            self.assertIsNone(child.poll(), "the real pipe flush must time out while the child remains alive")
            child.kill()
            child.wait(timeout=5)
            self.assertTrue(writer.close(join_timeout=1))
            SCENARIOS["noReaderProductionTimeouts"] = {"elapsedMs": elapsed_ms, "io": result,
                                                      "childAliveAtTimeout": True, "childExited": True}
        finally:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=2)
            writer.close(join_timeout=1)

    def test_full_protocol_budget_for_thirty_second_silent_child(self):
        result = ControllerChecks().run_helper("silent", full=True)
        self.assertGreaterEqual(result["protocolMs"], 60_000)
        self.assertLess(result["protocolMs"], 65_000)
        self.assertEqual(result["protocolEndReason"], "protocol-timeout")
        self.assertFalse(result["watchdogFired"])
        self.assertTrue(result["initializeIo"]["flushTimedOut"])
        self.assertLess(result["initializeIo"]["controllerBlockedMs"], 5000)
        SCENARIOS["silent30s"] = {"timing": result["timing"], "watchdog": result["watchdog"], "io": result["initializeIo"]}
        print(json.dumps({"scenario": "silent-30s", "actualOmpLaunches": 0,
            "timing": result["timing"], "watchdog": result["watchdog"]}))


class EtwLifetimeChecks(unittest.TestCase):
    @staticmethod
    def filetime(stamp):
        delta = etw.as_time(stamp) - etw.datetime(1601, 1, 1, tzinfo=etw.timezone.utc)
        return str(int(delta.total_seconds() * 10_000_000))

    @staticmethod
    def event(event_id, at, data):
        return {"eventId": event_id, "version": 0, "timeUtc": at, "data": data}

    def test_process_start_stop_linkage_uses_filetime_creation_and_pid_lifetime(self):
        events = [
            self.event(1, "2026-10-22T01:00:10Z", {"ProcessID": "42", "ParentProcessID": "1",
                "CreateTime": self.filetime("2026-10-22T01:00:10Z"), "ProcessSequenceNumber": "5", "ImageName": "helper.exe"}),
            self.event(2, "2026-10-22T01:00:20Z", {"ProcessID": "42", "CreateTime": self.filetime("2026-10-22T01:00:10Z"),
                "ExitTime": self.filetime("2026-10-22T01:00:20Z"), "ExitCode": "7", "ProcessSequenceNumber": "5"}),
            self.event(1, "2026-10-22T01:00:30Z", {"ProcessID": "42", "ParentProcessID": "1",
                "CreateTime": self.filetime("2026-10-22T01:00:30Z"), "ProcessSequenceNumber": "6", "ImageName": "helper.exe"}),
            self.event(2, "2026-10-22T01:00:40Z", {"ProcessID": "42", "CreateTime": self.filetime("2026-10-22T01:00:30Z"),
                "ExitTime": self.filetime("2026-10-22T01:00:40Z"), "ExitCode": "0", "ProcessSequenceNumber": "6"}),
        ]
        observed = etw.lifetimes(events)
        self.assertEqual([p["createTimeUtc"] for p in observed],
                         ["2026-10-22T01:00:10.000000Z", "2026-10-22T01:00:30.000000Z"])
        self.assertEqual([p["exitCode"] for p in observed], [7, 0])
        self.assertTrue(all(p["stopEvent"] for p in observed))

    def test_network_rejects_events_outside_process_lifetime(self):
        life = {"pid": 42, "createTimeUtc": "2026-10-22T01:00:10Z",
                "exitTimeUtc": "2026-10-22T01:00:20Z", "imageRaw": "helper.exe"}
        events = [{"eventId": 1033, "version": 0, "timeUtc": "2026-10-22T01:00:" + seconds + "Z",
                   "data": {"PID": "42", "Status": "0"}} for seconds in ("09", "15", "21")]
        records, excluded = etw.network_events({"TCPIP": events}, [life])
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["timestampAsDecoded"], "2026-10-22T01:00:15Z")
        self.assertEqual(records[0]["createTimeUtc"], life["createTimeUtc"])
        self.assertEqual(excluded, 2)

    def test_wfp_image_only_event_requires_one_matching_live_identity(self):
        lives = [{"pid": pid, "createTimeUtc": "2026-10-22T01:00:10Z",
                  "exitTimeUtc": "2026-10-22T01:00:20Z", "imageRaw": "helper.exe"} for pid in (42, 43)]
        event = {"eventId": 1001, "version": 0, "timeUtc": "2026-10-22T01:00:15Z", "data": {"AppId": "helper.exe"}}
        records, excluded = etw.network_events({"WFP": [event]}, lives)
        self.assertEqual(records, [])
        self.assertEqual(excluded, 1)

    def test_child_scope_uses_creation_time_when_pid_is_reused(self):
        lives = [
            {"pid": 42, "parentPid": 1, "createTimeUtc": "2026-10-22T01:00:10Z", "exitTimeUtc": "2026-10-22T01:00:20Z"},
            {"pid": 42, "parentPid": 1, "createTimeUtc": "2026-10-22T01:00:30Z", "exitTimeUtc": "2026-10-22T01:00:40Z"},
            {"pid": 43, "parentPid": 42, "createTimeUtc": "2026-10-22T01:00:15Z", "exitTimeUtc": "2026-10-22T01:00:19Z"},
            {"pid": 44, "parentPid": 42, "createTimeUtc": "2026-10-22T01:00:35Z", "exitTimeUtc": "2026-10-22T01:00:39Z"},
        ]
        scoped = etw.scope_lifetimes(lives, 42, "2026-10-22T01:00:30Z")
        self.assertEqual({(p["pid"], p["createTimeUtc"]) for p in scoped},
                         {(42, "2026-10-22T01:00:30Z"), (44, "2026-10-22T01:00:35Z")})


if __name__ == "__main__":
    report = None
    if "--report" in sys.argv:
        index = sys.argv.index("--report")
        report = Path(sys.argv[index + 1])
        del sys.argv[index:index + 2]
    full = "--full" in sys.argv
    if full:
        sys.argv.remove("--full")
    classes = ("WriterChecks", "ControllerChecks", "SelfTestChecks", "EtwLifetimeChecks") + (("FullBudgetChecks",) if full else ())
    program = unittest.main(verbosity=2, defaultTest=classes, exit=False)
    if report:
        paths = list(Path(__file__).parent.glob("*.py")) + list(Path(__file__).parent.glob("*.mjs")) + list(Path(__file__).parent.glob("*.ps1")) + [Path(__file__).parents[1] / "m11_a1d_io.py"]
        result = {"status": "PASS" if program.result.wasSuccessful() and full else "NOT PROVEN",
                  "atUtc": c.utc_now(), "actualOmpLaunches": 0, "testsRun": program.result.testsRun,
                  "skipped": len(program.result.skipped), "scenarios": SCENARIOS,
                  "sourceHashes": {str(p.relative_to(Path(__file__).parents[1])).replace("\\", "/"): c.sha256_file(p) for p in paths}}
        c.write_json_new(report, result)
    raise SystemExit(0 if program.result.wasSuccessful() else 1)
