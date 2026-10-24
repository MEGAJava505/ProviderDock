import argparse
import hashlib
import json
from pathlib import Path
import xml.etree.ElementTree as ET
import ctypes as C
import os
from datetime import datetime, timedelta, timezone
from statistics import median

def device_path(path):
    path = str(Path(path).resolve())
    drive = path[:2]
    buffer = C.create_unicode_buffer(32768)
    if not C.windll.kernel32.QueryDosDeviceW(drive, buffer, len(buffer)):
        raise RuntimeError('QueryDosDevice failed')
    return buffer.value + path[2:]


def local(tag):
    return tag.rsplit("}", 1)[-1]


def value(element):
    return (element.text or "").strip()


def parse_events(path):
    events = []
    if not path.exists():
        return events
    for _, element in ET.iterparse(path, events=("end",)):
        if local(element.tag) != "Event":
            continue
        record = {"provider": None, "eventId": None, "version": None, "timeUtc": None, "executionPid": None, "data": {}}
        for node in element.iter():
            name = local(node.tag)
            if name == "Provider" and record["provider"] is None:
                record["provider"] = node.attrib.get("Name") or node.attrib.get("Guid")
            elif name == "EventID" and record["eventId"] is None:
                try:
                    record["eventId"] = int(value(node))
                except ValueError:
                    pass
            elif name == "Version" and record["version"] is None:
                try:
                    record["version"] = int(value(node))
                except ValueError:
                    pass
            elif name == "TimeCreated" and record["timeUtc"] is None:
                record["timeUtc"] = node.attrib.get("SystemTime")
            elif name == "Execution" and record["executionPid"] is None:
                record["executionPid"] = node.attrib.get("ProcessID")
            elif name == "Data":
                key = node.attrib.get("Name")
                if key:
                    record["data"][key] = value(node)
        events.append(record)
        element.clear()
    return events


def normalize_event_timestamps(sources):
    """Calibrate tracerpt timestamps to ETW payload creation times.

    On this host tracerpt emits a local offset of ``+04:59`` while the
    process payloads carry UTC FILETIME values.  Using the payload as an
    anchor keeps every provider on one clock without hard-coding a timezone.
    """
    deltas = []
    for event in sources.get("Process", []):
        if event.get("eventId") != 1:
            continue
        raw_created = event.get("data", {}).get("CreateTime")
        event_time = as_time(event.get("timeUtc"))
        created = as_time(creation_time(raw_created, None)) if raw_created else None
        if event_time is None or created is None:
            continue
        delta = (event_time - created).total_seconds()
        if abs(delta) <= 86400:
            deltas.append(delta)
    if not deltas:
        return {"status": "not-calibrated", "reason": "process-create-time-anchor-missing", "sampleCount": 0}
    offset = float(median(deltas))
    spread = max(abs(delta - offset) for delta in deltas)
    if spread > 0.5:
        return {"status": "not-calibrated", "reason": "process-create-time-anchors-inconsistent",
                "sampleCount": len(deltas), "offsetSeconds": offset, "maxDeviationSeconds": spread}
    for events in sources.values():
        for event in events:
            parsed = as_time(event.get("timeUtc"))
            if parsed is not None:
                event["timeUtc"] = (parsed - timedelta(seconds=offset)).astimezone(timezone.utc).isoformat(
                    timespec="microseconds").replace("+00:00", "Z")
    return {"status": "calibrated", "sampleCount": len(deltas), "offsetSeconds": offset,
            "maxDeviationSeconds": spread, "anchor": "Process.CreateTime"}


def integer(value):
    if value is None:
        return None
    try:
        return int(str(value), 0)
    except ValueError:
        return None


def payload_pid(event):
    for key, raw in event["data"].items():
        normalized = key.lower().replace("_", "")
        if normalized in {"pid", "processid", "processidentifier"}:
            parsed = integer(raw)
            if parsed is not None:
                return parsed
    return None


def image_alias(raw, state, root):
    if not raw:
        return "UNKNOWN_IMAGE"
    lowered = raw.lower().replace("/", "\\")
    if lowered.endswith("\\omp.exe"):
        return "FRESH_PINNED_OMP_BINARY"
    if lowered.endswith("\\conhost.exe"):
        return "WINDOWS_CONSOLE_HOST"
    if lowered.endswith("\\python.exe") or lowered.endswith("\\python3.exe"):
        return "ACTUAL_PYTHON_CONTROLLER"
    if lowered.endswith("\\node-probe.exe"):
        return "SELFTEST_NODE_HELPER"
    return "OTHER_REDACTED_IMAGE"


def as_time(raw):
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def same_creation(left, right):
    a, b = as_time(left), as_time(right)
    return a is not None and b is not None and abs((a - b).total_seconds()) <= .001


def creation_time(raw, fallback):
    parsed = as_time(raw)
    if parsed is not None:
        return parsed.isoformat(timespec="microseconds").replace("+00:00", "Z")
    try:
        filetime = int(str(raw), 0)
        if filetime > 0:
            return (datetime(1601, 1, 1, tzinfo=timezone.utc) + timedelta(microseconds=filetime / 10)).isoformat(timespec="microseconds").replace("+00:00", "Z")
    except (TypeError, ValueError, OverflowError):
        pass
    return creation_time(fallback, fallback) if raw != fallback and as_time(fallback) else fallback


def within(life, timestamp):
    start, end, at = as_time(life.get("createTimeUtc")), as_time(life.get("exitTimeUtc")), as_time(timestamp)
    return start is not None and end is not None and at is not None and start <= at <= end


def lifetimes(events):
    starts, stops = [], []
    for event in events:
        pid = payload_pid(event)
        if pid is None or event["eventId"] not in (1, 2):
            continue
        data = event["data"]
        item = {"pid": pid, "createTimeUtc": data.get("CreateTime"),
                "processSequenceNumber": data.get("ProcessSequenceNumber"),
                "eventId": event["eventId"], "version": event["version"]}
        if event["eventId"] == 1:
            starts.append({**item, "createTimeUtc": creation_time(item["createTimeUtc"], event["timeUtc"]),
                           "parentPid": integer(data.get("ParentProcessID") or data.get("ParentProcessId")),
                           "parentProcessSequenceNumber": data.get("ParentProcessSequenceNumber"),
                           "imageRaw": data.get("ImageName") or data.get("ImageFileName"),
                           "startEventTimeUtc": event["timeUtc"]})
        else:
            stops.append({**item, "createTimeUtc": creation_time(item["createTimeUtc"], None) if item["createTimeUtc"] is not None else None,
                          "exitTimeUtc": creation_time(data.get("ExitTime"), event["timeUtc"]), "stopEventTimeUtc": event["timeUtc"],
                          "exitCode": integer(data.get("ExitCode"))})
    result = []
    for start in starts:
        next_starts = [item for item in starts if item["pid"] == start["pid"] and
                       as_time(item["startEventTimeUtc"]) > as_time(start["startEventTimeUtc"])]
        next_start = min(next_starts, key=lambda item: as_time(item["startEventTimeUtc"])) if next_starts else None
        matching = [stop for stop in stops if stop["pid"] == start["pid"] and
                    (stop["createTimeUtc"] is None or same_creation(stop["createTimeUtc"], start["createTimeUtc"])) and
                    as_time(stop["stopEventTimeUtc"]) >= as_time(start["startEventTimeUtc"]) and
                    (next_start is None or as_time(stop["stopEventTimeUtc"]) < as_time(next_start["startEventTimeUtc"])) and
                    (not start["processSequenceNumber"] or not stop["processSequenceNumber"] or
                     start["processSequenceNumber"] == stop["processSequenceNumber"])]
        stop = matching[0] if len(matching) == 1 else None
        result.append({**start, "exitTimeUtc": stop["exitTimeUtc"] if stop else None,
                       "exitCode": stop["exitCode"] if stop else None,
                       "stopEvent": {"eventId": 2, "version": stop["version"]} if stop else None})
    return result


def scope_lifetimes(lives, pid, created):
    roots = [p for p in lives if p["pid"] == pid and same_creation(p["createTimeUtc"], created)]
    if len(roots) != 1:
        return []
    scoped = roots[:]
    for parent in scoped:
        for child in lives:
            if child in scoped or child.get("parentPid") != parent["pid"] or not within(parent, child["createTimeUtc"]):
                continue
            parent_sequence = child.get("parentProcessSequenceNumber")
            if parent_sequence and parent.get("processSequenceNumber") and parent_sequence != parent["processSequenceNumber"]:
                continue
            scoped.append(child)
    return scoped


def network_events(sources, scoped):
    records, excluded = [], 0
    for source, events in sources.items():
        for event in events:
            if "EventsLost" in event["data"]:
                continue
            pid = payload_pid(event)
            correlation = "payload PID and process lifetime"
            if source == "DNS" and pid is None:
                pid = integer(event.get("executionPid"))
                correlation = "DNS execution PID and process lifetime"
            if source == "KernelNetwork" and pid is None:
                pid = integer(event.get("executionPid"))
                correlation = "Kernel-Network execution PID and process lifetime"
            candidates = [p for p in scoped if p["pid"] == pid and within(p, event["timeUtc"])]
            if source == "WFP" and pid is None:
                app = event["data"].get("AppId", "").casefold()
                candidates = [p for p in scoped if app and (p.get("imageRaw") or "").casefold() == app and within(p, event["timeUtc"])]
                correlation = "exact AppId and unique process lifetime"
            if len(candidates) != 1:
                excluded += 1
                continue
            life = candidates[0]
            status = integer(event["data"].get("Status"))
            records.append({"source": source, "eventId": event["eventId"], "version": event["version"],
                            "pid": life["pid"], "createTimeUtc": life["createTimeUtc"], "exitTimeUtc": life["exitTimeUtc"],
                            "timestampAsDecoded": event["timeUtc"], "correlation": correlation,
                            "denied": (source == "WFP" and event["eventId"] in (1001, 1003, 1005)) or status in (0xc0000022, 10013),
                            "status": event["data"].get("Status"),
                            "payloadBytes": integer(event["data"].get("size")) if source == "KernelNetwork" else None})
    return records, excluded


def source_hashes(root, sources):
    records = []
    for kind, events in sources.items():
        headers = [e for e in events if "EventsLost" in e["data"] and "BuffersLost" in e["data"]]
        header = headers[0]["data"] if len(headers) == 1 else {}
        records.append({"kind": kind, "eventsLost": integer(header.get("EventsLost")),
                        "buffersLost": integer(header.get("BuffersLost")),
                        "xmlSha256": hashlib.sha256((root / "private" / (kind + ".xml")).read_bytes()).hexdigest(),
                        "etlSha256": hashlib.sha256((root / "etw" / (kind + ".etl")).read_bytes()).hexdigest()})
    return records


def decoded_selftest(root, sources, lives, hashes, context):
    test = json.loads((root / "private/selftest.json").read_text(encoding="utf-8"))
    checks, errors = [], []
    if test.get("runId") != context["runId"] or test.get("sessions") != context["sessions"] or test.get("controllerSha256") != context["controllerSha256"]:
        errors.append("selftest-run-or-sessions-mismatch")
    for key in ("cmdExitSeven", "captureFailurePath", "negativeDirectTcp"):
        observed = test[key]
        found = [p for p in lives if p["pid"] == observed["pid"] and same_creation(p["createTimeUtc"], observed["createdAtUtc"])]
        life = found[0] if len(found) == 1 else None
        matched = bool(life and life["parentPid"] == observed["parentPid"] and
                       life["exitCode"] == observed["expectedExitCode"] == observed["exitCode"] and life["stopEvent"])
        checks.append({"kind": key, "pid": observed["pid"], "createdAtUtc": observed["createdAtUtc"],
                       "parentPid": observed["parentPid"], "expectedExitCode": observed["expectedExitCode"],
                       "nativeExitCode": observed["exitCode"], "etwExitCode": life["exitCode"] if life else None, "matched": matched})
        if not matched:
            errors.append(key + "-lifecycle-mismatch")
    for probe in ("capture", "negative"):
        record = test["captureFailurePath" if probe == "capture" else "negativeDirectTcp"]
        for stream in ("stdout", "stderr"):
            raw = (root / "logs" / f"selftest-{probe}-{stream}.log").read_bytes()
            capture = record[stream + "Capture"]
            if capture["bytes"] != len(raw) or capture["sha256"] != hashlib.sha256(raw).hexdigest() or not capture["complete"]:
                errors.append(probe + "-" + stream + "-capture-mismatch")
    negative = test["negativeDirectTcp"]
    negative_lives = [p for p in lives if p["pid"] == negative["pid"] and same_creation(p["createTimeUtc"], negative["createdAtUtc"])]
    scoped_sources = {"TCPIP": sources["Transport"], "WFP": sources["WFP"]}
    denied, _ = network_events(scoped_sources, negative_lives)
    tcp_denied = [e for e in denied if e["source"] == "TCPIP" and e["eventId"] in (1034, 1044) and integer(e["status"]) == 0xc0000022]
    wfp_denied = [e for e in denied if e["source"] == "WFP" and e["eventId"] == 1001]
    if not tcp_denied or not wfp_denied:
        errors.append("negative-probe-os-denial-not-observed")
    loop = test["loopback"]
    loop_lives = [p for p in lives if p["pid"] == loop["pid"] and same_creation(p["createTimeUtc"], loop["createdAtUtc"])]
    loop_events = [e for e in sources["KernelNetwork"] if payload_pid(e) == loop["pid"] and
                   any(within(p, e["timeUtc"]) for p in loop_lives) and
                   as_time(loop["startedAtUtc"]) <= as_time(e["timeUtc"]) <= as_time(loop["endedAtUtc"])]
    sent = sum(integer(e["data"].get("size")) or 0 for e in loop_events if e["eventId"] == 10)
    received = sum(integer(e["data"].get("size")) or 0 for e in loop_events if e["eventId"] == 11)
    if sent != 128 or received != 128 or loop["requests"] != 1 or loop["clientSentBytes"] != 64 or loop["clientReceivedBytes"] != 64:
        errors.append("loopback-64-byte-exchange-not-observed")
    if any(s["eventsLost"] != 0 or s["buffersLost"] != 0 for s in hashes):
        errors.append("decoded-sources-loss-or-header-missing")
    return {"status": "PASS" if not errors else "NOT PROVEN", "runId": context["runId"],
            "sessions": context["sessions"], "decodedWhen": "decoded after stop", "sources": hashes,
            "processLifecycle": checks, "negativeTransportEvents": tcp_denied, "wfpDropEvents": wfp_denied,
            "loopback": {"pid": loop["pid"], "createdAtUtc": loop["createdAtUtc"], "port": loop["port"],
                         "bytesPerDirection": 64, "sentBytesBothEndpoints": sent, "receivedBytesBothEndpoints": received},
            "errors": errors}


def public_process(life, root, state):
    alias = image_alias(life.get("imageRaw"), state, root)
    known = {"FRESH_PINNED_OMP_BINARY": root / "program/omp.exe",
             "WINDOWS_CONSOLE_HOST": Path(os.environ["SYSTEMROOT"]) / "System32/conhost.exe",
             "ACTUAL_PYTHON_CONTROLLER": Path(__import__("sys").executable)}.get(alias)
    return {key: val for key, val in life.items() if key != "imageRaw"} | {
        "imageAlias": alias, "imageSha256": hashlib.sha256(known.read_bytes()).hexdigest() if known and known.exists() else None,
        "imageHashReason": None if known and known.exists() else "image-not-in-declared-paths",
        "exactDevicePathMatched": bool(known and device_path(known).casefold() == (life.get("imageRaw") or "").casefold()),
        "rawImagePathSha256": hashlib.sha256((life.get("imageRaw") or "").encode()).hexdigest()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    args = parser.parse_args()
    root = Path(args.root).resolve()
    private = root / "private"
    context = json.loads((private / "run-context.json").read_text(encoding="utf-8"))
    stopped = json.loads((private / "session-stop.json").read_text(encoding="utf-8"))
    if {s["name"] for s in stopped["sessions"]} != {s["name"] for s in context["sessions"]} or any(s["stopExit"] != 0 for s in stopped["sessions"]):
        raise RuntimeError("same-run-sessions-not-stopped")
    state = json.loads((private / "state.json").read_text(encoding="utf-8"))
    actual = json.loads((private / "actual.json").read_text(encoding="utf-8"))
    live = json.loads((private / "actual-live.json").read_text(encoding="utf-8"))
    if actual.get("runId") != context["runId"]:
        raise RuntimeError("actual-run-context-mismatch")
    sources = {s["kind"]: parse_events(private / (s["kind"] + ".xml")) for s in context["sessions"]}
    time_normalization = normalize_event_timestamps(sources)
    hashes = source_hashes(root, sources)
    lives = lifetimes(sources["Process"])
    scoped = scope_lifetimes(lives, actual["pid"], actual["createdAtUtc"])
    processes = [public_process(p, root, state) for p in scoped]
    controllers = [p for p in lives if p["pid"] == live["controllerPid"] and
                   same_creation(p["createTimeUtc"], live["controllerCreatedAtUtc"])]
    controller = public_process(controllers[0], root, state) if len(controllers) == 1 else None
    network, excluded = network_events({"TCPIP": sources["Transport"], "WFP": sources["WFP"],
                                         "KernelNetwork": sources["KernelNetwork"], "DNS": sources["DNS"]}, scoped)
    sent = [e["payloadBytes"] for e in network if e["source"] == "KernelNetwork" and e["eventId"] in (10, 26, 42, 58)]
    received = [e["payloadBytes"] for e in network if e["source"] == "KernelNetwork" and e["eventId"] in (11, 27, 43, 59)]
    totals = {
        "transportAttemptEvents": sum(e["source"] == "TCPIP" and e["eventId"] in (1033, 1034, 1043, 1044) for e in network),
        "transportAllowedEvents": sum(e["source"] == "TCPIP" and e["eventId"] in (1033, 1043) and integer(e["status"]) == 0 for e in network),
        "transportDeniedEvents": sum(e["source"] == "TCPIP" and e["eventId"] in (1034, 1044) and integer(e["status"]) == 0xc0000022 for e in network),
        "wfpDropEvents": sum(e["source"] == "WFP" and e["eventId"] == 1001 for e in network),
        "sentBytes": sum(sent) if None not in sent else None,
        "receivedBytes": sum(received) if None not in received else None,
        "connectAcceptEvents": sum(e["source"] == "KernelNetwork" and e["eventId"] in (12, 15, 28, 31) for e in network),
        "dnsEvents": sum(e["source"] == "DNS" for e in network)}
    counters = {}
    for key, total in totals.items():
        source = "TCPIP" if key.startswith("transport") else "WFP" if key.startswith("wfp") else "DNS" if key.startswith("dns") else "KernelNetwork"
        counters[key] = {"source": source, "unit": "bytes" if key.endswith("Bytes") else "events",
                         "baseline": 0, "final": total, "delta": total,
                         "filter": "PID plus creation-to-exit lifetime; unique exact AppId lifetime only for WFP without payload PID",
                         "reason": "size-not-observed" if total is None else None}
    counters["providerRequests"] = {"source": "ETW does not decode HTTP", "unit": "requests",
                                     "baseline": None, "final": None, "delta": None, "reason": "not-observed; permission budget is zero"}
    decoded = decoded_selftest(root, sources, lives, hashes, context)
    tree_complete = bool(processes) and all(p["stopEvent"] for p in processes) and controller is not None and controller["stopEvent"] is not None
    summary = {
        "recordedAtUtc": datetime.now(timezone.utc).isoformat(), "runId": context["runId"],
        "decodedWhen": "decoded after stop", "sessionsStoppedAtUtc": stopped["atUtc"],
        "timeNormalization": time_normalization,
        "ompPid": actual["pid"], "controller": controller, "processes": processes,
        "scopedIdentities": [{"pid": p["pid"], "createTimeUtc": p["createTimeUtc"], "exitTimeUtc": p["exitTimeUtc"]} for p in scoped],
        "processTreeComplete": tree_complete, "orphanCount": sum(p["stopEvent"] is None for p in processes),
        "networkEvents": network, "networkCounters": counters, "excludedNetworkEvents": excluded,
        "etlLoss": hashes, "selfTestLinkage": decoded,
        "sourceCounts": {kind: len(events) for kind, events in sources.items()}}
    with (private / "etw-summary.json").open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(summary, stream, indent=2, ensure_ascii=False)
        stream.write("\n")
    print(json.dumps({"processes": len(processes), "networkEvents": len(network), "treeComplete": tree_complete,
                      "selfTestLinkage": decoded["status"]}))
    return 0 if tree_complete and decoded["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
