#!/usr/bin/env python3
"""
browserd — persistent headless Chromium daemon for the Oxagen durable agent sandbox.

Lives at /usr/local/bin/browserd inside the `agent` Modal image.
Launched by browserctl on first use; stays alive across exec() calls because
the durable sandbox keeps processes running between HTTP requests to the runner.

Protocol: newline-delimited JSON over a Unix socket at /tmp/oxagen-browserd.sock.
Each connection carries exactly ONE request line → ONE response line → close.
The daemon is single-threaded (Playwright sync API is not thread-safe); commands
are serialised naturally by the accept loop.

Supported ops and their request/response shapes:

  navigate   {"op":"navigate","url":"<url>"}
             → {"ok":true,"url":"<final-url>","title":"<page-title>"}

  screenshot {"op":"screenshot","selector":"<css>","full":<bool>}
             selector and full are optional (full defaults false).
             → {"ok":true,"base64":"<png-b64>","width":<int>,"height":<int>}

  fill       {"op":"fill","selector":"<css>","value":"<text>"}
             → {"ok":true}

  submit     {"op":"submit","selector":"<css>"}   (selector optional)
             No selector → keyboard Enter on the focused element.
             → {"ok":true,"url":"<url-after-navigation>"}

  click      {"op":"click","selector":"<css>"}
             → {"ok":true,"url":"<url-after-click>"}

  refresh    {"op":"refresh"}
             → {"ok":true,"url":"<current-url>"}

  read       {"op":"read","selector":"<css>"}     (selector optional)
             No selector → full body inner text, truncated to 20 000 chars.
             → {"ok":true,"text":"<inner-text>"}

  shutdown   {"op":"shutdown"}
             → {"ok":true}  (daemon exits after sending response)

Error shape: {"ok":false,"error":"<message>"}
"""

import base64
import json
import os
import signal
import socket
import sys

SOCK_PATH = "/tmp/oxagen-browserd.sock"


def main() -> None:
    # Playwright import is intentionally lazy so that py_compile passes in
    # environments where playwright is not installed (e.g. the host dev machine
    # or CI lint steps).  The import only executes when the daemon actually runs
    # inside the agent Modal image where playwright is pre-installed.
    from playwright.sync_api import sync_playwright  # noqa: PLC0415

    pw = sync_playwright().start()
    context = pw.chromium.launch_persistent_context(
        user_data_dir="/tmp/oxagen-browser-profile",
        headless=True,
        args=["--no-sandbox", "--disable-dev-shm-usage"],
        viewport={"width": 1280, "height": 800},
    )
    page = context.pages[0] if context.pages else context.new_page()

    def _shutdown(*_args: object) -> None:
        try:
            context.close()
        except Exception:
            pass
        try:
            pw.stop()
        except Exception:
            pass
        sys.exit(0)

    signal.signal(signal.SIGTERM, _shutdown)

    # Remove stale socket file left by a previous daemon run.
    try:
        os.unlink(SOCK_PATH)
    except FileNotFoundError:
        pass

    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(SOCK_PATH)
    srv.listen(8)

    while True:
        try:
            conn, _ = srv.accept()
        except Exception:
            continue

        resp: dict
        try:
            # Accumulate bytes until newline terminator.
            data = b""
            while not data.endswith(b"\n"):
                chunk = conn.recv(4096)
                if not chunk:
                    break
                data += chunk

            if not data:
                conn.close()
                continue

            cmd = json.loads(data.decode("utf-8").strip())
            op = cmd.get("op", "")

            try:
                if op == "navigate":
                    url = cmd["url"]
                    page.goto(url, wait_until="load")
                    try:
                        page.wait_for_load_state("networkidle", timeout=15000)
                    except Exception:
                        pass
                    resp = {"ok": True, "url": page.url, "title": page.title()}

                elif op == "screenshot":
                    selector = cmd.get("selector")
                    full = bool(cmd.get("full", False))
                    if selector:
                        png = page.locator(selector).screenshot()
                    else:
                        png = page.screenshot(full_page=full)
                    vp = page.viewport_size or {"width": 1280, "height": 800}
                    resp = {
                        "ok": True,
                        "base64": base64.b64encode(png).decode(),
                        "width": vp["width"],
                        "height": vp["height"],
                    }

                elif op == "fill":
                    page.fill(cmd["selector"], cmd["value"])
                    resp = {"ok": True}

                elif op == "submit":
                    selector = cmd.get("selector")
                    if selector:
                        page.click(selector)
                    else:
                        page.keyboard.press("Enter")
                    try:
                        page.wait_for_load_state("networkidle", timeout=15000)
                    except Exception:
                        pass
                    resp = {"ok": True, "url": page.url}

                elif op == "click":
                    page.click(cmd["selector"])
                    resp = {"ok": True, "url": page.url}

                elif op == "refresh":
                    page.reload(wait_until="load")
                    resp = {"ok": True, "url": page.url}

                elif op == "read":
                    selector = cmd.get("selector", "body")
                    text = page.locator(selector).inner_text()
                    resp = {"ok": True, "text": text[:20000]}

                elif op == "shutdown":
                    conn.sendall((json.dumps({"ok": True}) + "\n").encode("utf-8"))
                    conn.close()
                    _shutdown()

                else:
                    resp = {"ok": False, "error": f"unknown op: {op!r}"}

            except Exception as exc:
                # Per-command errors must not crash the daemon.
                resp = {"ok": False, "error": str(exc)}

            conn.sendall((json.dumps(resp) + "\n").encode("utf-8"))

        except Exception:
            # Connection-level errors (malformed JSON, broken pipe, etc.)
            # are swallowed so the accept loop continues.
            pass
        finally:
            try:
                conn.close()
            except Exception:
                pass


if __name__ == "__main__":
    main()
