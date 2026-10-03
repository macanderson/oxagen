"""A slow request across a real container swap (#5318).

deploy-service-smoke.test.sh holds the swap's order of calls against a
recording docker. This test runs the same functions, extracted from
deploy-service.sh, against real Docker: a container serving a slow request is
retired, a new one starts on the same port, and the slow request must still
answer from the old one. A container with no SIGTERM handler must still give
up the port, by SIGKILL. It needs Docker, so it runs in the node swap workflow
(.github/workflows/node-swap.yml) on a GitHub runner, never on a laptop.
"""

import json
import re
import socket
import subprocess
import threading
import time
import unittest
import urllib.request
import uuid
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "node" / "deploy-service.sh"
IMAGE = "node:24.21.0-alpine"

# The service in the container: `/` answers its name at once, `/slow` after
# SLOW_MS. With GRACEFUL=1 it does what Next's server does on SIGTERM: close
# the listener and exit once the open requests finish. Without it, node runs as
# PID 1 with no handler and ignores SIGTERM, as the api and mcp did.
SERVER = r"""
const http = require("node:http");
const name = process.env.NAME;
const server = http.createServer((req, res) => {
  const reply = () => res.end(name);
  if (req.url === "/slow") setTimeout(reply, Number(process.env.SLOW_MS));
  else reply();
});
server.listen(Number(process.env.PORT), "127.0.0.1");
if (process.env.GRACEFUL === "1") {
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}
"""


def functions(*names):
    source = SCRIPT.read_text()
    out = []
    for name in names:
        match = re.search(rf"^{name}\(\) \{{\n.*?^\}}\n", source, re.S | re.M)
        if match is None:
            raise AssertionError(f"deploy-service.sh defines no {name}()")
        out.append(match.group(0))
    return "\n".join(out)


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def get(port, path, timeout):
    request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", headers={"Connection": "close"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.status, response.read().decode()


def wait_for(port, name, seconds=120):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            if get(port, "/", 2) == (200, name):
                return
        except OSError:
            pass
        time.sleep(0.25)
    raise AssertionError(f"no container answered {name} on port {port} within {seconds}s")


def run_args(container, port, name, graceful, slow_ms):
    return ["docker", "run", "-d", "--name", container, "--restart", "unless-stopped",
            "--network", "host", "-e", f"PORT={port}", "-e", f"NAME={name}",
            "-e", f"GRACEFUL={graceful}", "-e", f"SLOW_MS={slow_ms}", IMAGE, "node", "-e", SERVER]


class SwapTest(unittest.TestCase):
    def setUp(self):
        self.container = f"oxagen-swaptest-{uuid.uuid4().hex[:8]}"
        self.port = free_port()
        subprocess.run(["docker", "pull", "-q", IMAGE], check=True, capture_output=True, timeout=300)

    def tearDown(self):
        names = subprocess.run(["docker", "ps", "-a", "--format", "{{.Names}}"],
                               capture_output=True, text=True).stdout.split()
        for name in names:
            if name.startswith(self.container):
                subprocess.run(["docker", "rm", "-f", name], capture_output=True)

    def swap(self, old_graceful):
        """Start the old container, hold a slow request open, run the swap, return the slow result."""
        subprocess.run(run_args(self.container, self.port, "old", old_graceful, 8000),
                       check=True, capture_output=True, timeout=60)
        wait_for(self.port, "old")

        slow = {}
        def request():
            try:
                slow["result"] = get(self.port, "/slow", 30)
            except OSError as error:
                slow["error"] = repr(error)
        thread = threading.Thread(target=request)
        thread.start()
        time.sleep(1)  # the slow request is in progress on the old container

        new = " ".join(f"'{arg}'" if arg != SERVER else '"$SERVER"'
                       for arg in run_args(self.container, self.port, "new", "1", 8000))
        harness = "\n".join([
            "set -euo pipefail",
            "log() { echo \"==> $*\"; }",
            f"CONTAINER={self.container} port={self.port} health_path=/ release_id=T1",
            "PORT_RELEASE_SECONDS=3 drain_seconds=30 overlap=true draining=''",
            functions("port_released", "retire_current", "finish_draining"),
            "retire_current",
            new + " >/dev/null",
            "for _ in $(seq 1 240); do [[ $(curl -s --max-time 1 http://127.0.0.1:$port/) == new ]] && break; sleep 0.25; done",
            "echo answered=$(curl -s --max-time 1 http://127.0.0.1:$port/)",
            "finish_draining",
        ])
        swap = subprocess.run(["bash", "-c", harness], capture_output=True, text=True, timeout=120,
                              env={"PATH": "/usr/local/bin:/usr/bin:/bin", "SERVER": SERVER})
        thread.join(40)
        self.assertEqual(swap.returncode, 0, swap.stdout + swap.stderr)
        self.assertIn("answered=new", swap.stdout)
        left = subprocess.run(["docker", "ps", "-a", "--format", "{{.Names}}"],
                              capture_output=True, text=True).stdout.split()
        self.assertNotIn(f"{self.container}-draining-T1", left, "the drained container should be removed")
        return slow, swap.stdout

    def test_a_slow_request_finishes_on_the_old_container(self):
        slow, log = self.swap(old_graceful="1")
        self.assertEqual(slow.get("result"), (200, "old"), json.dumps(slow) + "\n" + log)
        self.assertIn("closed port", log)
        self.assertIn("finished its requests", log)

    def test_a_container_with_no_handler_gives_up_the_port_by_sigkill(self):
        slow, log = self.swap(old_graceful="0")
        self.assertIn("stopping it now", log)
        # SIGKILL cuts the request off, as every deploy did before #5318.
        self.assertNotIn("result", slow)


if __name__ == "__main__":
    unittest.main()
