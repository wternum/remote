"""Read the remote project through MCP, preserving and checking file hashes."""

import hashlib
import json
import re
from pathlib import Path

from mcp_client import CACHE, ROOT, request

PREFIX = "merge-project-ui-layouts/"
DESTINATION = ROOT / "remote-project" / "merge-project-ui-layouts"
PROGRESS = CACHE / "import-progress.json"


def save_progress(states):
    PROGRESS.write_text(json.dumps(states, ensure_ascii=False))


def reconstruct(state):
    lines = state["lines"]
    total = state["total_lines"]
    if any(str(number) not in lines for number in range(1, total + 1)):
        return None
    content = [lines[str(number)] for number in range(1, total + 1)]
    expected = state.get("version", "").removeprefix("sha256:")
    for separator in ["\n", "\r\n"]:
        for suffix in ["", separator]:
            candidate = (separator.join(content) + suffix).encode("utf-8")
            if hashlib.sha256(candidate).hexdigest() == expected:
                return candidate
            if hashlib.sha256(b"\xef\xbb\xbf" + candidate).hexdigest() == expected:
                return b"\xef\xbb\xbf" + candidate
    return None


def main():
    manifest = json.loads((CACHE / "manifest-full.json").read_text())["structuredContent"]
    if manifest["summary"]["truncated"]:
        raise RuntimeError("The manifest must be complete before importing.")
    paths = [entry["path"] for entry in manifest["files"]]
    if PREFIX + ".gitignore" not in paths:
        paths.append(PREFIX + ".gitignore")
    states = json.loads(PROGRESS.read_text()) if PROGRESS.exists() else {}
    for path in paths:
        states.setdefault(path, {"next": 1, "lines": {}, "status": "pending"})
    reads = CACHE / "reads"
    reads.mkdir(exist_ok=True)
    batch_number = len(list(reads.glob("*.json")))
    while True:
        pending = [path for path in paths if states[path]["status"] == "pending"]
        if not pending:
            break
        batch = pending[:8]
        arguments = {"files": [
            {"path": path, "start_line": states[path]["next"], "end_line": states[path]["next"] + 399}
            for path in batch
        ]}
        result = request("tools/call", {"name": "read_files", "arguments": arguments})
        batch_number += 1
        (reads / f"{batch_number:04}.json").write_text(json.dumps(result, ensure_ascii=False))
        returned = result.get("structuredContent", {}).get("files", [])
        if not returned:
            raise RuntimeError(json.dumps(result, ensure_ascii=False))
        for entry in returned:
            path = entry["path"]
            state = states[path]
            if entry["status"] != "success":
                state["status"] = "needs_fallback"
                state["reason"] = entry.get("error", entry["status"])
                continue
            state["version"] = entry["version"]
            state["total_lines"] = entry["total_lines"]
            if entry.get("truncated_line_numbers"):
                state["status"] = "needs_fallback"
                state["reason"] = {"long_lines": entry["truncated_line_numbers"]}
                continue
            for line in entry.get("content", "").split("\n"):
                match = re.match(r"^(\d+): ?(.*)$", line)
                if match:
                    state["lines"][match[1]] = match[2]
            end = entry.get("end_line") or 0
            state["next"] = entry.get("next_start_line") or end + 1
            if end >= state["total_lines"] or state["total_lines"] == 0:
                contents = reconstruct(state)
                if contents is None:
                    state["status"] = "needs_fallback"
                    state["reason"] = "Original byte hash not reproduced from numbered text"
                else:
                    target = DESTINATION / path.removeprefix(PREFIX)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(contents)
                    state["status"] = "verified"
                    state.pop("lines", None)
            elif not entry.get("content") or state["next"] <= arguments["files"][batch.index(path)]["start_line"]:
                state["status"] = "needs_fallback"
                state["reason"] = "Read did not advance"
        save_progress(states)
        complete = sum(state["status"] == "verified" for state in states.values())
        print(f"Read batch {batch_number}: verified {complete}/{len(paths)} files", flush=True)
    fallback = {path: {k: v for k, v in state.items() if k != "lines"}
                for path, state in states.items() if state["status"] != "verified"}
    (CACHE / "read-fallback.json").write_text(json.dumps(fallback, ensure_ascii=False, indent=2))
    print(json.dumps({"total": len(paths), "verified": len(paths) - len(fallback), "fallback": fallback}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()