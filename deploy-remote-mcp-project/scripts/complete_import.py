"""Recover text exceeding the MCP reader's single-line limit without changes."""

import base64
import gzip
import hashlib
import json
import re
import shlex
import sys

from mcp_client import CACHE, ROOT, request

if "--export" in sys.argv:
    exceptions = json.loads((CACHE / "read-fallback.json").read_text())
    paths = [path.removeprefix("merge-project-ui-layouts/") for path in exceptions]
    code = 'const fs=require("fs"),z=require("zlib");const paths=' + json.dumps(paths) + ';'
    code += 'const data=paths.map(path=>({path,base64:fs.readFileSync(path).toString("base64")}));'
    code += 'const text=z.gzipSync(Buffer.from(JSON.stringify(data))).toString("base64");'
    # Short lines avoid the host PTY rewriting characters at its wrap boundary.
    code += 'process.stdout.write("MCP_ARCHIVE_BEGIN\\n"+text.match(/.{1,60}/g).join("\\n")+"\\nMCP_ARCHIVE_END\\n");'
    exported = request("tools/call", {"name": "run_command", "arguments": {
        "cwd": "merge-project-ui-layouts", "command": "sleep 4 && node -e " + shlex.quote(code), "timeout_ms": 120000,
    }})
    (CACHE / "export-command.json").write_text(json.dumps(exported, ensure_ascii=False))

result = json.loads((CACHE / "export-command.json").read_text())["structuredContent"]
output = result.get("output", "")
offset = result["next_offset"]
while offset < result["total_output_bytes"]:
    response = request("tools/call", {"name": "get_command_output", "arguments": {
        "command_id": result["command_id"], "offset": offset, "max_bytes": 131072,
    }})
    chunk = response["structuredContent"]
    output += chunk.get("output", "")
    following = chunk.get("next_offset", offset + len(chunk.get("output", "").encode()))
    if following <= offset:
        raise RuntimeError("Remote output did not advance")
    offset = following
    print(f"Read export output: {offset}/{result['total_output_bytes']} bytes", flush=True)

(CACHE / "oversized-export.txt").write_text(output)
output = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", output).replace("\r", "")
pattern = r"MCP_ARCHIVE_BEGIN(?:\\n|\n)([A-Za-z0-9+/=\s]+?)(?:\\n|\n)MCP_ARCHIVE_END"
matches = re.findall(pattern, output)
if not matches:
    raise RuntimeError("Lossless export markers were not found")
archive = json.loads(gzip.decompress(base64.b64decode(max(matches, key=len))))
states = json.loads((CACHE / "import-progress.json").read_text())
for entry in archive:
    relative = entry["path"]
    if relative.startswith("/") or ".." in relative.split("/"):
        raise RuntimeError("Unsafe archive path")
    contents = base64.b64decode(entry["base64"])
    key = "merge-project-ui-layouts/" + relative
    expected = states[key]["version"].removeprefix("sha256:")
    if hashlib.sha256(contents).hexdigest() != expected:
        raise RuntimeError("Hash mismatch: " + relative)
    target = ROOT / "remote-project" / "merge-project-ui-layouts" / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(contents)
    states[key]["status"] = "verified"
    states[key]["transport"] = "read-only lossless export after reader line truncation"
    states[key].pop("lines", None)

(CACHE / "import-progress.json").write_text(json.dumps(states, ensure_ascii=False, indent=2))
verified = sum(state["status"] == "verified" for state in states.values())
report = {"files": len(states), "verified": verified, "oversized_files": len(archive),
          "bytes": sum(path.stat().st_size for path in (ROOT / "remote-project").rglob("*") if path.is_file())}
(CACHE / "import-report.json").write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
if verified != len(states):
    raise RuntimeError("Not all source files were imported")