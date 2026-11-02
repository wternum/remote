"""Small Streamable HTTP client used to import the requested MCP project."""

import base64
import json
import os
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".mcp-import"
STATE = CACHE / "session.json"


def request(method, params=None, notification=False, initialize=False):
    CACHE.mkdir(exist_ok=True)
    endpoint_file = CACHE / "endpoint.base64"
    encoded_url = os.environ.get("MCP_URL_BASE64") or (
        endpoint_file.read_text().strip() if endpoint_file.exists() else ""
    )
    if not encoded_url:
        raise RuntimeError("Set MCP_URL_BASE64 to connect to the requested MCP server")
    state = {} if initialize or not STATE.exists() else json.loads(STATE.read_text())
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    if state.get("session_id"):
        headers["Mcp-Session-Id"] = state["session_id"]
        headers["MCP-Protocol-Version"] = state.get("protocol", "2025-03-26")
    body = {"jsonrpc": "2.0", "method": method}
    if not notification:
        body["id"] = uuid.uuid4().hex
    if params is not None:
        body["params"] = params
    req = urllib.request.Request(
        base64.b64decode(encoded_url).decode(),
        data=json.dumps(body).encode(),
        headers=headers,
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as response:
            text = response.read().decode()
            if response.headers.get("Mcp-Session-Id"):
                state["session_id"] = response.headers["Mcp-Session-Id"]
                state["protocol"] = "2025-03-26"
                STATE.write_text(json.dumps(state))
            if not text.strip():
                return {}
            if "text/event-stream" in response.headers.get("Content-Type", ""):
                events = [line[5:].strip() for line in text.splitlines() if line.startswith("data:")]
                result = next(json.loads(event) for event in reversed(events) if event)
            else:
                result = json.loads(text)
            if "error" in result:
                raise RuntimeError(json.dumps(result["error"], ensure_ascii=False))
            return result.get("result", result)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"HTTP {error.code}: {error.read().decode()}") from error


def main():
    command = sys.argv[1]
    if command == "initialize":
        result = request("initialize", {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "project-import-client", "version": "1.0.0"},
        }, initialize=True)
        (CACHE / "initialize.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
        request("notifications/initialized", notification=True)
        result = request("tools/list")
        (CACHE / "tools.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
    elif command == "call":
        result = request("tools/call", {"name": sys.argv[2], "arguments": json.loads(sys.argv[3])})
        if len(sys.argv) > 4:
            target = ROOT / sys.argv[4]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        result = request(command, json.loads(sys.argv[2]) if len(sys.argv) > 2 else {})
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()