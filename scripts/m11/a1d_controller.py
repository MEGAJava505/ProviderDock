import argparse
from contextlib import contextmanager
import ctypes as C
from ctypes import wintypes as W
from datetime import datetime, timedelta, timezone
import hashlib
import json
import msvcrt
import os
from pathlib import Path
import queue
import shutil
import socket
import subprocess
import sys
import threading
import time
import uuid

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from m11_a1d_io import BoundedWriter, M11_BUDGETS


PINNED_SHA256 = "1944c6e2a4f8e652f656e0d500b88a68a5f15f234258bef06a91a7aa6755d4ba"
K = C.WinDLL("kernel32", use_last_error=True)
A = C.WinDLL("advapi32", use_last_error=True)
U = C.WinDLL("userenv", use_last_error=True)
O = C.WinDLL("ole32", use_last_error=True)
P = C.c_void_p
SIZE = C.c_size_t


class GUID(C.Structure):
    _fields_ = [("Data1", W.DWORD), ("Data2", W.WORD), ("Data3", W.WORD), ("Data4", C.c_ubyte * 8)]


class WNODE_HEADER(C.Structure):
    _fields_ = [
        ("BufferSize", W.ULONG), ("ProviderId", W.ULONG), ("HistoricalContext", C.c_ulonglong),
        ("TimeStamp", C.c_longlong), ("Guid", GUID), ("ClientContext", W.ULONG), ("Flags", W.ULONG),
    ]


class EVENT_TRACE_PROPERTIES(C.Structure):
    _fields_ = [
        ("Wnode", WNODE_HEADER), ("BufferSize", W.ULONG), ("MinimumBuffers", W.ULONG),
        ("MaximumBuffers", W.ULONG), ("MaximumFileSize", W.ULONG), ("LogFileMode", W.ULONG),
        ("FlushTimer", W.ULONG), ("EnableFlags", W.ULONG), ("AgeLimit", W.LONG),
        ("NumberOfBuffers", W.ULONG), ("FreeBuffers", W.ULONG), ("EventsLost", W.ULONG),
        ("BuffersWritten", W.ULONG), ("LogBuffersLost", W.ULONG), ("RealTimeBuffersLost", W.ULONG),
        ("LoggerThreadId", W.HANDLE), ("LogFileNameOffset", W.ULONG), ("LoggerNameOffset", W.ULONG),
    ]


class STARTUPINFO(C.Structure):
    _fields_ = [
        ("cb", W.DWORD), ("lpReserved", W.LPWSTR), ("lpDesktop", W.LPWSTR), ("lpTitle", W.LPWSTR),
        ("dwX", W.DWORD), ("dwY", W.DWORD), ("dwXSize", W.DWORD), ("dwYSize", W.DWORD),
        ("dwXCountChars", W.DWORD), ("dwYCountChars", W.DWORD), ("dwFillAttribute", W.DWORD),
        ("dwFlags", W.DWORD), ("wShowWindow", W.WORD), ("cbReserved2", W.WORD),
        ("lpReserved2", P), ("hStdInput", W.HANDLE), ("hStdOutput", W.HANDLE), ("hStdError", W.HANDLE),
    ]


class STARTUPINFOEX(C.Structure):
    _fields_ = [("StartupInfo", STARTUPINFO), ("lpAttributeList", P)]


class PROCESS_INFORMATION(C.Structure):
    _fields_ = [("hProcess", W.HANDLE), ("hThread", W.HANDLE), ("dwProcessId", W.DWORD), ("dwThreadId", W.DWORD)]


class SECURITY_CAPABILITIES(C.Structure):
    _fields_ = [("AppContainerSid", P), ("Capabilities", P), ("CapabilityCount", W.DWORD), ("Reserved", W.DWORD)]


class BASIC_LIMITS(C.Structure):
    _fields_ = [
        ("ProcessTime", C.c_longlong), ("JobTime", C.c_longlong), ("LimitFlags", W.DWORD),
        ("MinimumWorkingSetSize", SIZE), ("MaximumWorkingSetSize", SIZE), ("ActiveProcessLimit", W.DWORD),
        ("Affinity", SIZE), ("PriorityClass", W.DWORD), ("SchedulingClass", W.DWORD),
    ]


class EXTENDED_LIMITS(C.Structure):
    _fields_ = [
        ("BasicLimitInformation", BASIC_LIMITS), ("IoInfo", C.c_ulonglong * 6),
        ("ProcessMemoryLimit", SIZE), ("JobMemoryLimit", SIZE), ("PeakProcessMemoryUsed", SIZE),
        ("PeakJobMemoryUsed", SIZE),
    ]


def signature(dll, name, result, arguments):
    function = getattr(dll, name)
    function.restype = result
    function.argtypes = arguments
    return function


create_profile = signature(U, "CreateAppContainerProfile", C.c_long, [W.LPCWSTR, W.LPCWSTR, W.LPCWSTR, P, W.DWORD, C.POINTER(P)])
delete_profile = signature(U, "DeleteAppContainerProfile", C.c_long, [W.LPCWSTR])
get_profile_folder = signature(U, "GetAppContainerFolderPath", C.c_long, [W.LPCWSTR, C.POINTER(W.LPWSTR)])
task_free = signature(O, "CoTaskMemFree", None, [P])
free_sid = signature(A, "FreeSid", P, [P])
convert_sid = signature(A, "ConvertSidToStringSidW", W.BOOL, [P, C.POINTER(W.LPWSTR)])
convert_string_sid = signature(A, "ConvertStringSidToSidW", W.BOOL, [W.LPCWSTR, C.POINTER(P)])
equal_sid = signature(A, "EqualSid", W.BOOL, [P, P])
local_free = signature(K, "LocalFree", P, [P])
initialize_attributes = signature(K, "InitializeProcThreadAttributeList", W.BOOL, [P, W.DWORD, W.DWORD, C.POINTER(SIZE)])
update_attribute = signature(K, "UpdateProcThreadAttribute", W.BOOL, [P, W.DWORD, SIZE, P, SIZE, P, P])
delete_attributes = signature(K, "DeleteProcThreadAttributeList", None, [P])
create_process = signature(K, "CreateProcessW", W.BOOL, [W.LPCWSTR, W.LPWSTR, P, P, W.BOOL, W.DWORD, P, W.LPCWSTR, P, C.POINTER(PROCESS_INFORMATION)])
create_file = signature(K, "CreateFileW", W.HANDLE, [W.LPCWSTR, W.DWORD, W.DWORD, P, W.DWORD, W.DWORD, W.HANDLE])
create_image_section = signature(K, "CreateFileMappingW", W.HANDLE, [W.HANDLE, P, W.DWORD, W.DWORD, W.DWORD, W.LPCWSTR])
close_handle = signature(K, "CloseHandle", W.BOOL, [W.HANDLE])
create_job = signature(K, "CreateJobObjectW", W.HANDLE, [P, W.LPCWSTR])
set_job = signature(K, "SetInformationJobObject", W.BOOL, [W.HANDLE, C.c_int, P, W.DWORD])
assign_job = signature(K, "AssignProcessToJobObject", W.BOOL, [W.HANDLE, W.HANDLE])
terminate_job = signature(K, "TerminateJobObject", W.BOOL, [W.HANDLE, W.UINT])
terminate_process = signature(K, "TerminateProcess", W.BOOL, [W.HANDLE, W.UINT])
resume_thread = signature(K, "ResumeThread", W.DWORD, [W.HANDLE])
wait_process = signature(K, "WaitForSingleObject", W.DWORD, [W.HANDLE, W.DWORD])
get_exit = signature(K, "GetExitCodeProcess", W.BOOL, [W.HANDLE, C.POINTER(W.DWORD)])
get_process_times = signature(K, "GetProcessTimes", W.BOOL, [W.HANDLE, P, P, P, P])
open_token = signature(A, "OpenProcessToken", W.BOOL, [W.HANDLE, W.DWORD, C.POINTER(W.HANDLE)])
token_information = signature(A, "GetTokenInformation", W.BOOL, [W.HANDLE, C.c_int, P, W.DWORD, C.POINTER(W.DWORD)])
sid_count = signature(A, "GetSidSubAuthorityCount", C.POINTER(C.c_ubyte), [P])
sid_authority = signature(A, "GetSidSubAuthority", C.POINTER(W.DWORD), [P, W.DWORD])
flush_file_buffers = signature(K, "FlushFileBuffers", W.BOOL, [W.HANDLE])
control_trace = signature(A, "ControlTraceW", W.ULONG, [C.c_ulonglong, W.LPCWSTR, P, W.ULONG])


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json_new(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, indent=2, ensure_ascii=False)
        stream.write("\n")


def check(result, operation):
    if not result:
        raise RuntimeError(f"{operation}:win32={C.get_last_error()}")
    return result


def process_creation_utc(handle):
    creation, exit_time, kernel, user = (C.c_ulonglong() for _ in range(4))
    check(get_process_times(handle, C.byref(creation), C.byref(exit_time), C.byref(kernel), C.byref(user)), "process-times")
    return datetime.fromtimestamp((creation.value - 116444736000000000) / 10000000, timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def run_context(root):
    path = root / "private/run-context.json"
    if not path.is_file():
        raise RuntimeError("run-context-missing")
    context = json.loads(path.read_text(encoding="utf-8"))
    sessions = context.get("sessions", [])
    if not context.get("runId") or len(sessions) != 5 or len({s["name"] for s in sessions}) != 5:
        raise RuntimeError("run-context-invalid")
    if context.get("controllerSha256") != sha256_file(__file__):
        raise RuntimeError("run-context-controller-hash-mismatch")
    expected_sources = {
        "scripts/m11/a1d_controller.py": __file__,
        "scripts/m11_a1d_io.py": Path(__file__).resolve().parents[1] / "m11_a1d_io.py",
        "scripts/m11/parse_etw.py": Path(__file__).with_name("parse_etw.py"),
        "scripts/m11/test_controller.py": Path(__file__).with_name("test_controller.py"),
    }
    observed = {name: sha256_file(path) for name, path in expected_sources.items()}
    if context.get("sourceHashes") != observed:
        raise RuntimeError("run-context-source-hash-mismatch")
    return context


def mark_setup_start(args):
    root = Path(args.root).resolve()
    write_json_new(root / "private/setup-start.json", {"atUtc": utc_now(), "monotonic": time.monotonic()})
    print(json.dumps({"setupStartRecorded": True}))
    return 0


def token_value(handle, kind):
    size = W.DWORD()
    token_information(handle, kind, None, 0, C.byref(size))
    buffer = C.create_string_buffer(size.value)
    check(token_information(handle, kind, buffer, size.value, C.byref(size)), "token-info")
    return buffer


def profile_sid(state):
    sid = P()
    check(convert_string_sid(state["sidText"], C.byref(sid)), "profile-sid")
    return sid


def environment_block(values):
    clean = {str(key): str(value) for key, value in values.items() if value is not None}
    return C.create_unicode_buffer("\0".join(f"{key}={clean[key]}" for key in sorted(clean)) + "\0\0")


def owned_cwd(path, state):
    candidate = Path(path).resolve()
    work = Path(state["workDirectory"]).resolve()
    try:
        candidate.relative_to(work)
    except ValueError as error:
        raise RuntimeError("session-new-cwd-outside-owned-workdir") from error
    if not candidate.is_dir():
        raise RuntimeError("session-new-cwd-invalid")
    return str(candidate)


@contextmanager
def executable_image(path):
    """Hold a Windows image section through CreateProcess; do not map or run it.

    Preparing and retaining SEC_IMAGE was faster than CreateProcess alone for
    cold images on this host. Both operations stay inside the setup budget.
    Deny writes/deletion and keep both handles private to this controller.
    """
    # GENERIC_READ, FILE_SHARE_READ, OPEN_EXISTING; no inheritable handle.
    handle = create_file(str(path), 0x80000000, 1, None, 3, 0, None)
    if handle == P(-1).value:
        raise RuntimeError(f"image-open:win32={C.get_last_error()}")
    section = None
    try:
        # PAGE_READONLY | SEC_IMAGE: Windows performs its normal image checks.
        section = check(create_image_section(handle, None, 0x1000002, 0, 0, None), "image-section-create")
        yield
    finally:
        if section:
            close_handle(section)
        close_handle(handle)


class ContainedProcess:
    def __init__(self, executable, arguments, cwd, environment, sid, on_created=None):
        timing_started = time.monotonic()
        self.creation_timings = []

        def mark(phase):
            self.creation_timings.append({
                "phase": phase,
                "atUtc": utc_now(),
                "elapsedMs": round((time.monotonic() - timing_started) * 1000, 3),
            })

        mark("init-start")
        self.in_read, self.in_write = os.pipe()
        self.out_read, self.out_write = os.pipe()
        self.err_read, self.err_write = os.pipe()
        self.child_fds = [self.in_read, self.out_write, self.err_write]
        mark("pipes-created")
        child_handles = [msvcrt.get_osfhandle(fd) for fd in self.child_fds]
        for handle in child_handles:
            os.set_handle_inheritable(handle, True)
        self.info = PROCESS_INFORMATION()
        self.job = None
        self.attributes = None
        self.resumed = False
        size = SIZE()
        initialize_attributes(None, 3, 0, C.byref(size))
        self.attributes = C.create_string_buffer(size.value)
        check(initialize_attributes(self.attributes, 3, 0, C.byref(size)), "attributes-init")
        capabilities = SECURITY_CAPABILITIES(sid, None, 0, 0)
        child_policy = W.DWORD(0)
        inherited = (W.HANDLE * 3)(*child_handles)
        check(update_attribute(self.attributes, 0, 0x20009, C.byref(capabilities), C.sizeof(capabilities), None, None), "attributes-security")
        check(update_attribute(self.attributes, 0, 0x2000E, C.byref(child_policy), C.sizeof(child_policy), None, None), "attributes-child-policy")
        check(update_attribute(self.attributes, 0, 0x20002, inherited, C.sizeof(inherited), None, None), "attributes-handles")
        mark("attributes-configured")
        startup = STARTUPINFOEX()
        startup.StartupInfo.cb = C.sizeof(startup)
        startup.StartupInfo.dwFlags = 0x100 | 0x1
        startup.StartupInfo.wShowWindow = 0
        startup.StartupInfo.hStdInput, startup.StartupInfo.hStdOutput, startup.StartupInfo.hStdError = child_handles
        startup.lpAttributeList = C.cast(self.attributes, P)
        env = environment_block(environment)
        command = C.create_unicode_buffer(subprocess.list2cmdline([str(executable)] + list(arguments)))
        try:
            mark("image-validation-begin")
            with executable_image(executable):
                mark("image-validated")
                created_at = utc_now()
                mark("create-process-begin")
                check(create_process(str(executable), command, None, None, True, 0x80000 | 0x400 | 0x4 | 0x08000000, env, str(cwd), C.byref(startup), C.byref(self.info)), "create-process")
                mark("create-process-returned")
            self.create_requested_at_utc = created_at
            self.created_at_utc = utc_now()
            self.created_at_utc = process_creation_utc(self.info.hProcess)
            mark("process-creation-time-read")
            if on_created:
                on_created(self)
            mark("created-callback-complete")
            self.job = check(create_job(None, None), "job-create")
            limits = EXTENDED_LIMITS()
            limits.BasicLimitInformation.LimitFlags = 0x2000 | 0x8
            limits.BasicLimitInformation.ActiveProcessLimit = 1
            check(set_job(self.job, 9, C.byref(limits), C.sizeof(limits)), "job-limits")
            check(assign_job(self.job, self.info.hProcess), "job-assign")
            mark("job-assigned")
            token = W.HANDLE()
            check(open_token(self.info.hProcess, 8, C.byref(token)), "process-token")
            try:
                is_container = W.DWORD.from_buffer(token_value(token, 29)).value == 1
                capability_count = W.DWORD.from_buffer(token_value(token, 30)).value
                package_buffer = token_value(token, 31)
                package_sid = C.cast(package_buffer, C.POINTER(P))[0]
                same_sid = bool(equal_sid(package_sid, sid))
                integrity_buffer = token_value(token, 25)
                integrity_sid = C.cast(integrity_buffer, C.POINTER(P))[0]
                count = sid_count(integrity_sid)[0]
                integrity = sid_authority(integrity_sid, count - 1)[0]
                self.attestation = {
                    "isAppContainer": is_container,
                    "capabilityCount": capability_count,
                    "packageIdentityMatches": same_sid,
                    "integrityRid": integrity,
                    "jobKillOnClose": True,
                    "activeProcessLimit": 1,
                    "childProcessCreationDenied": False,
                    "inheritedHandlesRestrictedToStdio": True,
                }
                if not is_container or capability_count != 0 or not same_sid or integrity != 4096:
                    raise RuntimeError("process-attestation-rejected")
                mark("attestation-complete")
            finally:
                close_handle(token)
        except Exception:
            if self.info.hProcess:
                terminate_process(self.info.hProcess, 1)
                wait_process(self.info.hProcess, 3000)
            self.close()
            raise
        for fd in self.child_fds:
            os.close(fd)
        self.child_fds = []
        mark("init-complete")

    def resume(self):
        if resume_thread(self.info.hThread) == 0xFFFFFFFF:
            raise RuntimeError("resume-thread-failed")
        self.resumed = True
        return utc_now()

    def poll(self):
        if wait_process(self.info.hProcess, 0) != 0:
            return None
        code = W.DWORD()
        check(get_exit(self.info.hProcess, C.byref(code)), "exit-code")
        return code.value

    def wait(self, milliseconds):
        result = wait_process(self.info.hProcess, milliseconds)
        if result == 258:
            return None
        check(result == 0, "wait-process")
        return self.poll()

    def terminate(self, code=124):
        if self.job:
            check(terminate_job(self.job, code), "terminate-job")
        elif self.info.hProcess:
            check(terminate_process(self.info.hProcess, code), "terminate-process")

    def close(self):
        if self.job:
            close_handle(self.job)
            self.job = None
        for name in ["hThread", "hProcess"]:
            handle = getattr(self.info, name)
            if handle:
                close_handle(handle)
                setattr(self.info, name, None)
        if self.attributes:
            delete_attributes(self.attributes)
            self.attributes = None
        for key in ["in_write", "out_read", "err_read"]:
            fd = getattr(self, key, None)
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass
                setattr(self, key, None)
        for fd in self.child_fds:
            try:
                os.close(fd)
            except OSError:
                pass
        self.child_fds = []


def grant(path, sid_text, rights):
    process = subprocess.run(
        ["icacls.exe", str(path), "/grant", "*" + sid_text + ":" + rights],
        capture_output=True, timeout=10, creationflags=0x08000000,
    )
    if process.returncode != 0:
        raise RuntimeError(f"owned-fixture-acl-rejected:exit={process.returncode}")


def prepare(args):
    root = Path(args.root).resolve()
    if root.exists():
        raise RuntimeError("owned-root-already-exists")
    root.mkdir(parents=True)
    for name in ["program", "logs", "dumps", "etw", "private"]:
        (root / name).mkdir()
    pinned = Path(args.pinned).resolve()
    if sha256_file(pinned) != PINNED_SHA256:
        raise RuntimeError("pinned-binary-hash-mismatch")
    shutil.copy2(pinned, root / "program" / "omp.exe")
    shutil.copy2(Path(args.node_probe).resolve(), root / "program" / "node-probe.exe")
    for script in ["capture-probe.mjs", "negative-network.mjs"]:
        shutil.copy2(Path(__file__).with_name(script), root / "program" / script)
    sid = P()
    name = "ProviderDock.M11.A1D." + uuid.uuid4().hex
    created = False
    try:
        result = create_profile(name, "ProviderDock M11 A1-D", "Fresh diagnostic profile; zero capabilities", None, 0, C.byref(sid))
        if result != 0:
            raise RuntimeError(f"profile-create-failed:hresult={result}")
        created = True
        text = W.LPWSTR()
        check(convert_sid(sid, C.byref(text)), "sid-format")
        try:
            sid_text = text.value
        finally:
            local_free(C.cast(text, P))
        profile_folder = W.LPWSTR()
        folder_result = get_profile_folder(sid_text, C.byref(profile_folder))
        if folder_result != 0:
            raise RuntimeError(f"profile-folder-failed:hresult={folder_result}")
        try:
            work = Path(profile_folder.value) / "Temp" / "m11-a1d-owned"
        finally:
            task_free(C.cast(profile_folder, P))
        work.mkdir(parents=True, exist_ok=False)
        grant(root, sid_text, "(OI)(CI)(RX)")
        state = {
            "createdAtUtc": utc_now(),
            "profileName": name,
            "profileIdentitySha256": hashlib.sha256(name.encode()).hexdigest(),
            "sidText": sid_text,
            "workDirectory": str(work),
            "root": str(root),
            "programDirectory": str(root / "program"),
            "pinnedSource": str(pinned),
            "copiedOmpSha256": sha256_file(root / "program" / "omp.exe"),
            "pinnedSourceSha256": sha256_file(pinned),
            "profileCapabilities": 0,
            "actualLaunches": 0,
        }
        write_json_new(root / "private" / "state.json", state)
        print(json.dumps({"status": "PASS", "profileIdentitySha256": state["profileIdentitySha256"], "actualLaunches": 0}))
    except Exception:
        if created:
            delete_profile(name)
        raise
    finally:
        if sid:
            free_sid(sid)


def helper_environment(state):
    work = state["workDirectory"]
    return {
        "SYSTEMROOT": os.environ["SYSTEMROOT"], "WINDIR": os.environ["WINDIR"],
        "COMSPEC": os.environ["COMSPEC"], "TEMP": work, "TMP": work,
        "HOME": work, "USERPROFILE": work, "APPDATA": work, "LOCALAPPDATA": work,
    }


def capture_stream(fd, path, result, key, frames=None, mode="xb"):
    pending = b""
    count = 0
    digest = hashlib.sha256()
    frame_offset = 0
    result.update({key: 0, "complete": False, "eof": False, "pendingAtEof": None,
                   "sha256": digest.hexdigest(), "redactions": 0, "error": None})
    try:
        with os.fdopen(fd, "rb", closefd=True) as source, open(path, mode) as destination:
            while True:
                chunk = os.read(source.fileno(), 4096)
                if not chunk:
                    result["eof"] = True
                    break
                destination.write(chunk)
                destination.flush()
                count += len(chunk)
                digest.update(chunk)
                result[key] = count
                result["sha256"] = digest.hexdigest()
                if count > 2 * 1024 * 1024:
                    raise RuntimeError("output-limit-exceeded")
                if frames is not None:
                    pending += chunk
                    while b"\n" in pending:
                        line, pending = pending.split(b"\n", 1)
                        boundary = {"beginByte": frame_offset, "endByte": frame_offset + len(line) + 1}
                        frame_offset += len(line) + 1
                        if not line.strip():
                            continue
                        try:
                            frame = json.loads(line.decode("utf-8"))
                            if not isinstance(frame, dict):
                                raise ValueError("frame-is-not-an-object")
                            frames.put({"type": "frame", "value": frame, "bytes": len(line) + 1, "atUtc": utc_now(), **boundary})
                        except (UnicodeError, ValueError) as error:
                            frames.put({"type": "parse-error", "class": type(error).__name__, "bytes": len(line) + 1, "atUtc": utc_now(), **boundary})
            destination.flush()
            os.fsync(destination.fileno())
        result.update({"complete": True, "pendingAtEof": len(pending), "pendingBytesAtEof": len(pending)})
        if pending and frames is not None:
            frames.put({"type": "parse-error", "class": "incomplete-frame-at-eof", "bytes": len(pending),
                        "atUtc": utc_now(), "beginByte": frame_offset, "endByte": count})
    except Exception as error:
        result["error"] = type(error).__name__
        if isinstance(error, RuntimeError):
            result["errorReason"] = str(error)
        if frames is not None:
            frames.put({"type": "capture-error", "atUtc": utc_now()})
    finally:
        result["endedAtUtc"] = utc_now()
        if frames is not None:
            frames.put({"type": "capture-ended", "atUtc": utc_now(), "eof": result["eof"], "complete": result["complete"]})


def run_helper(state, executable, arguments, stdout_path, stderr_path, timeout_ms=10000, expected_exit=0):
    sid = profile_sid(state)
    process = None
    result = {"startedAtUtc": utc_now(), "stdoutBytes": 0, "stderrBytes": 0,
              "parentPid": os.getpid(), "expectedExitCode": expected_exit}
    try:
        process = ContainedProcess(executable, arguments, state["workDirectory"], helper_environment(state), sid)
        result.update({"pid": process.info.dwProcessId, "createdAtUtc": process.created_at_utc,
                       "attestation": process.attestation,
                       "creationTimings": getattr(process, "creation_timings", [])})
        out_result, err_result = {}, {}
        out_thread = threading.Thread(target=capture_stream, args=(process.out_read, stdout_path, out_result, "bytes"), daemon=True)
        err_thread = threading.Thread(target=capture_stream, args=(process.err_read, stderr_path, err_result, "bytes"), daemon=True)
        process.out_read = process.err_read = None
        out_thread.start(); err_thread.start()
        result["resumedAtUtc"] = process.resume()
        try:
            os.close(process.in_write)
        finally:
            process.in_write = None
        code = process.wait(timeout_ms)
        if code is None:
            process.terminate(124)
            code = process.wait(1000)
            result["watchdogFired"] = True
        else:
            result["watchdogFired"] = False
        out_thread.join(3); err_thread.join(3)
        result.update({"exitCode": code, "exitMatched": code == expected_exit, "exitObservedAtUtc": utc_now(),
                       "stdoutBytes": out_result.get("bytes"), "stderrBytes": err_result.get("bytes"),
                       "stdoutCapture": dict(out_result), "stderrCapture": dict(err_result),
                       "captureComplete": out_result.get("complete", False) and err_result.get("complete", False) and not out_thread.is_alive() and not err_thread.is_alive()})
        return result
    finally:
        if process:
            process.close()
        local_free(sid)


def loopback_selftest():
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    listener.settimeout(3)
    payload = b"M" * 64
    result = {"port": listener.getsockname()[1], "bytes": len(payload), "requests": 0,
              "pid": os.getpid(), "createdAtUtc": process_creation_utc(W.HANDLE(-1)),
              "parentPid": os.getppid(), "startedAtUtc": utc_now()}
    errors = []

    def server():
        try:
            connection, _ = listener.accept()
            with connection:
                connection.settimeout(3)
                received = b""
                while len(received) < len(payload):
                    chunk = connection.recv(len(payload) - len(received))
                    if not chunk:
                        break
                    received += chunk
                connection.sendall(received)
                result["serverReceivedBytes"] = len(received)
                result["serverSentBytes"] = len(received)
                result["requests"] = 1
        except Exception as error:
            errors.append(type(error).__name__)

    thread = threading.Thread(target=server, daemon=True)
    thread.start()
    with socket.create_connection(listener.getsockname(), timeout=3) as client:
        client.sendall(payload)
        echoed = b""
        while len(echoed) < len(payload):
            chunk = client.recv(len(payload) - len(echoed))
            if not chunk:
                break
            echoed += chunk
    thread.join(3)
    listener.close()
    result.update({"endedAtUtc": utc_now(), "clientSentBytes": len(payload), "clientReceivedBytes": len(echoed), "errors": errors, "status": "PASS" if echoed == payload and not errors and result["requests"] == 1 else "FAIL"})
    return result


def selftest(args):
    root = Path(args.root).resolve()
    context = run_context(root)
    live_loss = etw_loss([s["name"] for s in context["sessions"]])
    if not loss_zero(live_loss):
        raise RuntimeError("selftest-etw-sessions-unavailable-or-loss")
    state = json.loads((root / "private" / "state.json").read_text(encoding="utf-8"))
    program = root / "program"
    cmd = subprocess.Popen([os.environ["COMSPEC"], "/d", "/c", "exit", "7"], creationflags=0x08000000)
    cmd_handle_cached = cmd._handle is not None
    cmd_created = process_creation_utc(W.HANDLE(int(cmd._handle)))
    cmd_code = cmd.wait(timeout=5)
    capture = run_helper(
        state, program / "node-probe.exe", ["--preserve-symlinks-main", str(program / "capture-probe.mjs")],
        root / "logs" / "selftest-capture-stdout.log", root / "logs" / "selftest-capture-stderr.log",
        expected_exit=7,
    )
    capture_stdout = (root / "logs" / "selftest-capture-stdout.log").read_text(encoding="utf-8")
    capture_stderr = (root / "logs" / "selftest-capture-stderr.log").read_text(encoding="utf-8")
    negative = run_helper(
        state, program / "node-probe.exe", ["--preserve-symlinks-main", str(program / "negative-network.mjs")],
        root / "logs" / "selftest-negative-stdout.log", root / "logs" / "selftest-negative-stderr.log",
    )
    negative_payload = json.loads((root / "logs" / "selftest-negative-stdout.log").read_text(encoding="utf-8").strip())
    loopback = loopback_selftest()
    passed = (
        cmd_handle_cached and cmd_code == 7 and capture["exitCode"] == 7 and capture['captureComplete'] and negative['captureComplete'] and
        "M11_CAPTURE_STDOUT_MARKER" in capture_stdout and "M11_CAPTURE_STDERR_MARKER" in capture_stderr and
        negative["exitCode"] == 0 and negative_payload.get("status") == "PASS" and
        (negative_payload.get("code") == "EACCES" or abs(negative_payload.get("errno") or 0) == 10013) and loopback["status"] == "PASS"
    )
    observation = {
        "recordedAtUtc": utc_now(), "status": "PASS" if passed else "BLOCKED", "actualLaunches": 0,
        "runId": context["runId"], "sessions": context["sessions"], "controllerSha256": context["controllerSha256"],
        "controllerPid": os.getpid(), "controllerCreatedAtUtc": process_creation_utc(W.HANDLE(-1)),
        "liveLossBefore": live_loss,
        "cmdExitSeven": {"pid": cmd.pid, "parentPid": os.getpid(), "createdAtUtc": cmd_created,
                         "expectedExitCode": 7, "exitObservedAtUtc": utc_now(),
                         "handleCachedBeforeWait": cmd_handle_cached, "exitCode": cmd_code, "exitMatched": cmd_code == 7},
        "captureFailurePath": capture,
        "captureMarkers": {"stdout": "M11_CAPTURE_STDOUT_MARKER" in capture_stdout, "stderr": "M11_CAPTURE_STDERR_MARKER" in capture_stderr,
                           "stdoutBytes": capture["stdoutBytes"], "stderrBytes": capture["stderrBytes"]},
        "negativeDirectTcp": {**negative, "probe": negative_payload, "targetClass": "TEST-NET-1:443"},
        "loopback": loopback,
        "decodedVerification": {"status": "pending", "reason": "decoded after stop; same ETL sources required"},
    }
    write_json_new(root / "private" / "selftest.json", observation)
    print(json.dumps({"status": observation["status"], "actualLaunches": 0}))
    return 0 if passed else 1


def actual(args):
    root = Path(args.root).resolve()
    state = json.loads((root / "private/state.json").read_text(encoding="utf-8"))
    prepared = json.loads((root / "private/prepared.json").read_text(encoding="utf-8"))
    context = None
    if not hasattr(args, "helper_budgets"):
        context = run_context(root)
        test = json.loads((root / "private/selftest.json").read_text(encoding="utf-8"))
        if test.get("status") != "PASS" or test.get("runId") != context["runId"] or test.get("sessions") != context["sessions"] or test.get("controllerSha256") != context["controllerSha256"]:
            raise RuntimeError("selftest-current-run-linkage-mismatch")
    observation_path = root / "private/actual.json"
    if observation_path.exists() or state.get("actualLaunches") != 0:
        raise RuntimeError("actual-launch-budget-already-consumed")
    write_json_new(root / "private/actual-attempt.lock", {"atUtc": utc_now(), "attemptLimit": 1})
    budgets = getattr(args, "helper_budgets", M11_BUDGETS)
    session_new = bool(getattr(args, "session_new", False))
    if context is not None and session_new != (context.get("protocolMode") == "a1-final"):
        raise RuntimeError("protocol-mode-context-mismatch")
    started = time.monotonic()
    setup_marker = root / "private/setup-start.json"
    if setup_marker.is_file():
        setup_record = json.loads(setup_marker.read_text(encoding="utf-8"))
    elif context is not None:
        raise RuntimeError("setup-marker-missing")
    else:
        setup_record = {"atUtc": utc_now(), "monotonic": started}
    setup_started = float(setup_record["monotonic"])
    protocol_started = protocol_ended = teardown_started = None
    process = writer = watchdog = sid = None
    threads = []
    frames = queue.Queue()
    out_result, err_result = {}, {}
    timings, parse_results, boundaries, linkage = [], [], [], []
    response = session_response = None
    writers = []
    sent_ids = set()
    sent_bytes = 0
    before_inventory = None
    watchdog_lock = threading.Lock()
    watchdog_state = {"scheduledAtUtc": setup_record["atUtc"],
                      "scheduleUtc": (datetime.fromisoformat(setup_record["atUtc"].replace("Z", "+00:00")) + timedelta(seconds=budgets.watchdog_seconds)).isoformat().replace("+00:00", "Z"),
                      "fireUtc": None, "terminationUtc": None,
                      "reason": "total-watchdog", "budgetSeconds": budgets.watchdog_seconds}
    obs = {"status": "NOT PROVEN", "startedAtUtc": utc_now(), "actualLaunches": 0, "retries": 0,
           "binarySha256": PINNED_SHA256, "providerRequests": 0, "inferenceRequests": 0,
           "providerCostUsd": 0, "budgets": vars(budgets), "framesSent": 0, "framesReceived": 0,
           "initializeResponseReceived": False, "initializeResponseHasError": False,
           "protocolEndReason": "not-started", "declaredHelpers": ["conhost.exe"],
           "watchdogFired": False, "initializeIo": None}
    obs["runId"] = context["runId"] if context else "NO-OMP-HELPER"
    obs["etwLiveLoss"] = []
    obs.update(protocolMode="a1-final" if session_new else "diagnostic", sessionNewIo=None,
               sessionNewResponseReceived=False, sessionNewResponseHasError=False, sessionNewValid=False)

    def submit_request(request_id, method, params):
        duplicate = os.dup(process.in_write)
        request_writer = BoundedWriter(lambda data: os.write(duplicate, data),
            lambda: bool(flush_file_buffers(W.HANDLE(msvcrt.get_osfhandle(duplicate)))),
            write_timeout=budgets.write_seconds, flush_timeout=budgets.flush_seconds,
            close_fn=lambda: os.close(duplicate))
        payload = (json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method,
                               "params": params}, separators=(",", ":")) + "\n").encode("utf-8")
        key = "initializeIo" if request_id == 1 else "sessionNewIo"
        writers.append((request_id, key, request_writer, len(payload)))
        sent_ids.add(request_id)
        obs[key] = request_writer.submit(payload, request_id=request_id)
        event(method + "-submitted", requestId=request_id, payloadBytes=len(payload),
              payloadSha256=hashlib.sha256(payload).hexdigest())
        return request_writer

    def poll_writers():
        nonlocal sent_bytes
        for request_id, key, request_writer, size in writers:
            io_state = request_writer.poll()
            obs[key] = io_state
            if io_state["bytesWritten"] == size and request_id not in completed_sends:
                completed_sends.add(request_id)
                obs["framesSent"] += 1
                boundaries.append({"direction": "sent", "requestId": request_id,
                    "beginByte": sent_bytes, "endByte": sent_bytes + size, "bytes": size,
                    "atUtc": io_state["writeEndUtc"]})
                sent_bytes += size

    completed_sends = set()

    def inventory():
        return {str(p.relative_to(state["workDirectory"])): {"size": p.stat().st_size, "sha256": sha256_file(p)}
                for p in Path(state["workDirectory"]).rglob("*") if p.is_file()}

    def event(name, **details):
        timings.append({"event": name, "atUtc": utc_now(), "elapsedMs": round((time.monotonic() - started) * 1000, 3), **details})

    def created(child):
        nonlocal process
        with watchdog_lock:
            process = child
            if obs["watchdogFired"]:
                child.terminate(124)
                watchdog_state["terminationUtc"] = utc_now()
        obs.update(actualLaunches=1, pid=child.info.dwProcessId, createdAtUtc=child.created_at_utc)
        state["actualLaunches"] = 1
        (root / "private/state.json").write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
        write_json_new(root / "private/actual-live.json", {"controllerPid": os.getpid(),
                       "controllerCreatedAtUtc": process_creation_utc(W.HANDLE(-1)),
                       "ompPid": child.info.dwProcessId, "createObservedAtUtc": child.created_at_utc})

    def consume(item):
        nonlocal response, session_response
        kind = item["type"]
        if kind in ("capture-error", "capture-ended"):
            event(kind, complete=item.get("complete"), eof=item.get("eof"))
            return
        boundary = {k: item[k] for k in ("beginByte", "endByte", "bytes", "atUtc")}
        boundaries.append({"direction": "received", **boundary})
        obs["framesReceived"] += 1
        if kind == "parse-error":
            parse_results.append({**boundary, "status": "invalid", "errorClass": item["class"]})
            return
        frame = item["value"]
        request_id = frame.get("id")
        matched = (frame.get("jsonrpc") == "2.0" and type(request_id) is int
                   and request_id in sent_ids and (("result" in frame) != ("error" in frame)))
        parse_results.append({**boundary, "status": "parsed", "matchesRequest": matched})
        if matched:
            if request_id == 1:
                response = frame
            else:
                session_response = frame
            linkage.append({"requestId": request_id, "responseId": request_id, "matched": True, "hasError": "error" in frame, "atUtc": item["atUtc"]})

    def expire():
        with watchdog_lock:
            obs["watchdogFired"] = True
            watchdog_state["fireUtc"] = utc_now()
            if process is not None:
                try:
                    process.terminate(124)
                    watchdog_state["terminationUtc"] = utc_now()
                except Exception as error:
                    watchdog_state["terminationError"] = type(error).__name__

    watchdog_delay = max(0, budgets.watchdog_seconds - (time.monotonic() - setup_started))
    watchdog = threading.Timer(watchdog_delay, expire)
    watchdog.daemon = True
    watchdog.start()
    try:
        if context:
            snapshot = etw_loss([s["name"] for s in context["sessions"]])
            obs["etwLiveLoss"].append({"atUtc": utc_now(), "sessions": snapshot})
            if not loss_zero(snapshot):
                raise RuntimeError("etw-loss-before-create")
        for name in ("stdout", "stderr"):
            (root / "logs" / f"omp-{name}.raw.log").open("xb").close()
        if sha256_file(prepared["executable"]) != PINNED_SHA256 or sha256_file(state["pinnedSource"]) != PINNED_SHA256:
            raise RuntimeError("actual-binary-hash-mismatch")
        if time.monotonic() - setup_started > budgets.setup_seconds:
            raise RuntimeError("setup-budget-exceeded-before-create")
        sid = profile_sid(state)
        before_inventory = inventory()
        process = ContainedProcess(Path(prepared["executable"]), prepared["args"], prepared["cwd"], prepared["environment"], sid, on_created=created)
        obs.update(pid=process.info.dwProcessId, createdAtUtc=process.created_at_utc,
                   processAttestation=process.attestation,
                   processCreationTimings=getattr(process, "creation_timings", []))
        for attr, name, result, frame_queue in (("out_read", "stdout", out_result, frames), ("err_read", "stderr", err_result, None)):
            thread = threading.Thread(target=capture_stream, args=(getattr(process, attr), root / "logs" / f"omp-{name}.raw.log", result, "bytes", frame_queue, "ab"), daemon=True)
            setattr(process, attr, None)
            thread.start()
            threads.append(thread)
        with watchdog_lock:
            if obs["watchdogFired"]:
                raise RuntimeError("total-watchdog")
            if time.monotonic() - setup_started > budgets.setup_seconds:
                raise RuntimeError("setup-budget-exceeded-before-resume")
            obs["resumedAtUtc"] = process.resume()
            protocol_started = time.monotonic()
        event("ResumeThread")
        writer = submit_request(1, "initialize", {"protocolVersion": 1, "clientCapabilities": {},
            "clientInfo": {"name": "m11-fix-diagnostic", "version": "1"}})
        deadline = protocol_started + budgets.protocol_seconds
        next_loss_query = protocol_started
        while True:
            if obs["watchdogFired"]:
                obs["protocolEndReason"] = "total-watchdog"
                break
            if context and time.monotonic() >= next_loss_query:
                snapshot = etw_loss([s["name"] for s in context["sessions"]])
                obs["etwLiveLoss"].append({"atUtc": utc_now(), "sessions": snapshot})
                if not loss_zero(snapshot):
                    raise RuntimeError("etw-loss-during-protocol")
                next_loss_query = time.monotonic() + .5
            poll_writers()
            while not frames.empty():
                consume(frames.get_nowait())
            if response is not None:
                if not session_new or "error" in response:
                    obs["protocolEndReason"] = "initialize-response"
                    break
                if not isinstance(response.get("result"), dict) or response["result"].get("protocolVersion") != 1:
                    raise RuntimeError("invalid-initialize-response")
                if 2 not in sent_ids:
                    writer = submit_request(2, "session/new", {"cwd": owned_cwd(prepared["cwd"], state), "mcpServers": []})
                if session_response is not None:
                    obs["protocolEndReason"] = "session-new-response"
                    break
            if out_result.get("error") or err_result.get("error"):
                raise RuntimeError("stream-capture-failed")
            code = process.poll()
            if code is not None:
                obs["exitCode"] = code
                obs["protocolEndReason"] = "process-exit"
                break
            if time.monotonic() >= deadline:
                obs["protocolEndReason"] = "protocol-timeout"
                break
            time.sleep(.01)
        protocol_ended = time.monotonic()
    except Exception as error:
        obs["controllerErrorClass"] = type(error).__name__
        obs["controllerError"] = str(error) if isinstance(error, RuntimeError) else "controller-error-redacted"
        obs["protocolEndReason"] = "total-watchdog" if obs["watchdogFired"] else "controller-error"
    finally:
        teardown_started = time.monotonic()
        if protocol_started is not None and protocol_ended is None:
            protocol_ended = teardown_started
        teardown_deadline = teardown_started + budgets.teardown_seconds
        for _, _, request_writer, _ in writers:
            request_writer.close()
        if process is not None:
            try:
                if process.in_write is not None:
                    os.close(process.in_write)
                    process.in_write = None
                    event("stdin-eof-requested", writerStillActive=writer.thread_alive if writer else False)
                code = process.wait(min(1000, max(0, int((teardown_deadline - time.monotonic()) * 500))))
                if code is None:
                    process.terminate(124 if obs["protocolEndReason"] == "protocol-timeout" else 125)
                    obs["forcedTeardown"] = True
                    process.wait(max(0, min(1000, int((teardown_deadline - time.monotonic()) * 1000))))
                obs["exitCode"] = process.poll()
                obs["exitObservedAtUtc"] = utc_now()
                for thread in threads:
                    thread.join(max(0, min(2, teardown_deadline - time.monotonic())))
                for _, key, request_writer, _ in writers:
                    request_writer.close(join_timeout=max(0, min(.5, teardown_deadline - time.monotonic())))
                    obs[key] = request_writer.last_result
                obs["writerThreadFinished"] = all(not item[2].thread_alive for item in writers)
                event("process-exit", exitCode=obs["exitCode"])
            except Exception as error:
                obs["teardownError"] = type(error).__name__
            finally:
                watchdog.cancel()
                with watchdog_lock:
                    process.close()
                    process = None
        else:
            watchdog.cancel()
        if sid:
            local_free(sid)
        while not frames.empty():
            consume(frames.get_nowait())
        poll_writers()
        obs["initializeResponseReceived"] = response is not None
        obs["initializeResponseHasError"] = bool(response and "error" in response)
        initialize_result = response.get("result") if response and isinstance(response.get("result"), dict) else None
        obs["initializeResponseProtocolVersion"] = initialize_result.get("protocolVersion") if initialize_result else None
        obs["sessionNewResponseReceived"] = session_response is not None
        obs["sessionNewResponseHasError"] = bool(session_response and "error" in session_response)
        session_result = session_response.get("result") if session_response else None
        if isinstance(session_result, dict):
            session_id = session_result.get("sessionId")
            try:
                valid_id = isinstance(session_id, str) and str(uuid.UUID(session_id)) == session_id.lower()
            except ValueError:
                valid_id = False
            config_options = session_result.get("configOptions")
            modes = session_result.get("modes")
            valid_contract = (valid_id and isinstance(config_options, list) and isinstance(modes, dict)
                              and isinstance(modes.get("availableModes"), list)
                              and isinstance(modes.get("currentModeId"), str))
            obs["sessionNewValid"] = valid_contract
            if valid_contract:
                obs["sessionNewResponse"] = {"sessionId": session_id}
        agent_info = response.get("result", {}).get("agentInfo") if response and isinstance(response.get("result"), dict) else None
        version = agent_info.get("version") if isinstance(agent_info, dict) else None
        obs["runtimeHeader"] = {"status": "observed" if isinstance(version, str) else "not-observed",
                                "version": version if isinstance(version, str) else None,
                                "reason": None if isinstance(version, str) else "no-runtime-version-in-initialize-response"}
        obs["runtimeVersion"] = obs["runtimeHeader"]["version"]
        obs["stdoutCapture"], obs["stderrCapture"] = dict(out_result), dict(err_result)
        for name in ("stdout", "stderr"):
            capture = obs[name + "Capture"]
            obs[name + "Bytes"] = capture.get("bytes", 0)
            obs[name + "Sha256"] = capture.get("sha256")
        obs["captureThreadsFinished"] = len(threads) == 2 and all(not t.is_alive() for t in threads)
        obs["frameBoundaries"], obs["parseResults"], obs["requestResponseLinkage"] = boundaries, parse_results, linkage
        obs["parseErrors"] = [item for item in parse_results if item["status"] != "parsed"]
        obs["watchdog"] = dict(watchdog_state)
        obs["ompExit"] = {"code": obs.get("exitCode"), "atUtc": obs.get("exitObservedAtUtc"), "source": "GetExitCodeProcess"}
        try:
            write_json_new(root / "private/fixture-effects.json", {"before": before_inventory, "after": inventory()})
        except Exception as error:
            obs["fixtureInventoryError"] = type(error).__name__
        ended = time.monotonic()
        setup_end = protocol_started or teardown_started
        obs["setupStartedAtUtc"] = setup_record["atUtc"]
        obs["setupMs"] = round((setup_end - setup_started) * 1000, 3)
        obs["protocolMs"] = round((protocol_ended - protocol_started) * 1000, 3) if protocol_started is not None else 0
        obs["teardownMs"] = round((ended - teardown_started) * 1000, 3)
        obs["totalMs"] = round((ended - setup_started) * 1000, 3)
        obs["timing"] = {k: obs[k] for k in ("setupMs", "protocolMs", "teardownMs", "totalMs")}
        obs["timing"]["deadlineSatisfied"] = {
            "setup": obs["setupMs"] <= budgets.setup_seconds * 1000,
            "protocol": protocol_started is not None and obs["protocolEndReason"] != "total-watchdog"
                        and obs["protocolMs"] <= (budgets.protocol_seconds + .1) * 1000
                        and (obs["protocolEndReason"] != "protocol-timeout" or obs["protocolMs"] >= budgets.protocol_seconds * 1000),
            "teardown": obs["teardownMs"] <= budgets.teardown_seconds * 1000,
            "total": not obs["watchdogFired"] and obs["totalMs"] <= budgets.watchdog_seconds * 1000}
        obs["endedAtUtc"] = utc_now()
        obs["handshakeTimeline"] = timings
        obs["status"] = "OBSERVED" if obs.get("pid") and obs.get("exitCode") is not None else "NOT PROVEN"
        obs["normalizedCause"] = "initialize-response-observed" if response is not None else obs["protocolEndReason"] + "-underlying-cause-not-established"
        protocol_failed = (obs.get("controllerError") or obs.get("teardownError") or obs.get("watchdogFired")
                           or obs.get("parseErrors") or (session_new and not obs.get("sessionNewValid"))
                           or (session_new and obs.get("protocolEndReason") != "session-new-response"))
        obs["controllerExit"] = {"code": 1 if protocol_failed else 0,
                                 "atUtc": obs["endedAtUtc"], "source": "controller-return-code"}
        write_json_new(observation_path, obs)
        print(json.dumps({"status": obs["status"], "actualLaunches": obs["actualLaunches"], "exitCode": obs.get("exitCode"), "timing": obs["timing"]}))
    return obs["controllerExit"]["code"]


def etw_loss(names):
    records = []
    for name in names:
        total = C.sizeof(EVENT_TRACE_PROPERTIES) + 4096
        buffer = C.create_string_buffer(total)
        properties = EVENT_TRACE_PROPERTIES.from_buffer(buffer)
        properties.Wnode.BufferSize = total
        properties.LoggerNameOffset = C.sizeof(EVENT_TRACE_PROPERTIES)
        properties.LogFileNameOffset = C.sizeof(EVENT_TRACE_PROPERTIES) + 2048
        result = control_trace(0, name, buffer, 0)
        records.append({
            "name": name, "atUtc": utc_now(), "queryResult": int(result), "numberOfBuffers": int(properties.NumberOfBuffers),
            "freeBuffers": int(properties.FreeBuffers), "eventsLost": int(properties.EventsLost),
            "buffersWritten": int(properties.BuffersWritten), "logBuffersLost": int(properties.LogBuffersLost),
            "realTimeBuffersLost": int(properties.RealTimeBuffersLost), "logFileMode": int(properties.LogFileMode),
        })
    return records


def loss_zero(records):
    return bool(records) and all(item["queryResult"] == item["eventsLost"] == item["logBuffersLost"] == item["realTimeBuffersLost"] == 0 for item in records)


def query_etw(args):
    records = etw_loss(args.names)
    all_queried = bool(records) and all(item["queryResult"] == 0 for item in records)
    all_loss_zero = loss_zero(records)
    write_json_new(args.output, {"recordedAtUtc": utc_now(), "sessions": records,
                                 "allQueried": all_queried, "allLossZero": all_loss_zero})
    print(json.dumps({"sessions": len(records), "allQueried": all_queried, "allLossZero": all_loss_zero}))
    return 0 if all_queried and all_loss_zero else 1


def cleanup(args):
    root = Path(args.root).resolve()
    state = json.loads((root / "private" / "state.json").read_text(encoding="utf-8"))
    result = delete_profile(state["profileName"])
    observation = {"recordedAtUtc": utc_now(), "profileIdentitySha256": state["profileIdentitySha256"], "deleteHresult": int(result), "deleted": result == 0}
    write_json_new(root / "private" / "profile-cleanup.json", observation)
    print(json.dumps(observation))
    return 0 if result == 0 else 1


def main():
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    mark_setup_parser = subparsers.add_parser("mark-setup-start")
    mark_setup_parser.add_argument("--root", required=True)
    prepare_parser = subparsers.add_parser("prepare")
    prepare_parser.add_argument("--root", required=True)
    prepare_parser.add_argument("--pinned", required=True)
    prepare_parser.add_argument("--node-probe", required=True)
    selftest_parser = subparsers.add_parser("selftest")
    selftest_parser.add_argument("--root", required=True)
    actual_parser = subparsers.add_parser("actual")
    actual_parser.add_argument("--root", required=True)
    actual_parser.add_argument("--session-new", action="store_true")
    query_parser = subparsers.add_parser("query-etw")
    query_parser.add_argument("--output", required=True)
    query_parser.add_argument("names", nargs="+")
    cleanup_parser = subparsers.add_parser("cleanup")
    cleanup_parser.add_argument("--root", required=True)
    args = parser.parse_args()
    handlers = {"mark-setup-start": mark_setup_start, "prepare": prepare, "selftest": selftest, "actual": actual, "query-etw": query_etw, "cleanup": cleanup}
    return handlers[args.command](args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({"status": "BLOCKED", "errorClass": type(error).__name__, "error": str(error) if isinstance(error, RuntimeError) else "local-error-redacted"}), file=sys.stderr)
        sys.exit(1)
