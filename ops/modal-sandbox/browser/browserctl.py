#!/usr/bin/env python3
"""
browserctl — thin Unix-socket client for browserd.

Reads ONE JSON command from stdin, ensures browserd is running (spawning it
detached if not), sends the command, prints the JSON response to stdout, exits.

Exit codes: 0 on {"ok":true}, 1 on {"ok":false} or any transport/parse error.

Usage (from a durable sandbox exec call with stdin set to the JSON command):
  echo '{"op":"navigate","url":"http://localhost:3000"}' | python3 /usr/local/bin/browserctl

The sandbox exec `stdin` field is the canonical way to pass the command so that
no shell-escaping of special characters is required.

NOTE for local development: `browserctl` requires Chromium/playwright which are
only installed inside the `agent` Modal image.  To test locally, symlink
ops/modal-sandbox/browser/browserctl.py to a directory on PATH and ensure
playwright is installed in the active Python environment.
"""

import json
import socket
import subprocess
import sys
import time
from subprocess import DEVNULL

SOCK_PATH = "/tmp/oxagen-browserd.sock"
DAEMON_BIN = "/usr/local/bin/browserd"
POLL_INTERVAL = 0.5
MAX_WAIT = 40.0


def _try_connect() -> "socket.socket | None":
    """Return a connected socket to browserd, or None if the daemon is not up."""
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.connect(SOCK_PATH)
        return s
    except (ConnectionRefusedError, FileNotFoundError, OSError):
        return None


def _ensure_daemon() -> None:
    """Spawn browserd if not already running; wait up to MAX_WAIT seconds."""
    probe = _try_connect()
    if probe is not None:
        probe.close()
        return

    # Daemon not up — launch it detached so it survives this process's exit.
    subprocess.Popen(
        ["python3", DAEMON_BIN],
        start_new_session=True,
        stdout=DEVNULL,
        stderr=DEVNULL,
    )

    deadline = time.monotonic() + MAX_WAIT
    while time.monotonic() < deadline:
        time.sleep(POLL_INTERVAL)
        probe = _try_connect()
        if probe is not None:
            probe.close()
            return

    raise RuntimeError(f"browserd did not become ready within {MAX_WAIT}s")


def main() -> None:
    raw = sys.stdin.read().strip()
    if not raw:
        print(json.dumps({"ok": False, "error": "no command on stdin"}))
        sys.exit(1)

    try:
        cmd = json.loads(raw)
    except json.JSONDecodeError as exc:
        print(json.dumps({"ok": False, "error": f"invalid JSON on stdin: {exc}"}))
        sys.exit(1)

    try:
        _ensure_daemon()
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        sys.exit(1)

    s = _try_connect()
    if s is None:
        print(json.dumps({"ok": False, "error": "could not connect to browserd after start"}))
        sys.exit(1)

    try:
        s.sendall((json.dumps(cmd) + "\n").encode("utf-8"))

        # Accumulate bytes until the response newline terminator.
        response = b""
        while not response.endswith(b"\n"):
            chunk = s.recv(4096)
            if not chunk:
                break
            response += chunk
    finally:
        s.close()

    line = response.decode("utf-8").strip()
    if not line:
        print(json.dumps({"ok": False, "error": "empty response from browserd"}))
        sys.exit(1)

    # Print the raw JSON line as-is so the TS caller can parse stdout directly.
    print(line)

    try:
        parsed = json.loads(line)
        sys.exit(0 if parsed.get("ok") else 1)
    except Exception:
        sys.exit(1)


if __name__ == "__main__":
    main()
