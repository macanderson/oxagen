#!/usr/bin/env python3
"""Apply the proxy's memory budget before admitting service deployments."""
import json
from pathlib import Path
import subprocess

LIMIT = 256 * 1024 * 1024
FORMAT = '{"pid":{{.State.Pid}},"running":{{.State.Running}},"memory":{{.HostConfig.Memory}},"swap":{{.HostConfig.MemorySwap}}}'


def inspect():
    result = subprocess.run(
        ["docker", "inspect", "--format", FORMAT, "oxagen-caddy"],
        check=True, capture_output=True, text=True, timeout=30,
    )
    return json.loads(result.stdout)


def memory_used(pid):
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        raise RuntimeError("Caddy has no running process")
    entries = Path(f"/proc/{pid}/cgroup").read_text().splitlines()
    paths = [entry[3:] for entry in entries if entry.startswith("0::")]
    if len(paths) != 1:
        raise RuntimeError("Caddy memory accounting requires cgroup v2")
    root = Path("/sys/fs/cgroup").resolve()
    group = (root / paths[0].lstrip("/")).resolve()
    if group == root or root not in group.parents:
        raise RuntimeError("Caddy cgroup path is invalid")
    used = int((group / "memory.current").read_text())
    if used < 0:
        raise RuntimeError("Caddy memory accounting is invalid")
    return used


def main():
    state = inspect()
    if state.get("running") is not True:
        raise RuntimeError("Caddy must be running before service deployment")
    if state.get("memory") == LIMIT and state.get("swap") == LIMIT:
        return
    used = memory_used(state.get("pid"))
    if used > LIMIT * 3 // 4:
        raise RuntimeError(
            f"Caddy uses {used} bytes; refusing to shrink its budget to {LIMIT} bytes. "
            "Drain proxy load before retrying deployment."
        )
    subprocess.run(
        ["docker", "update", "--memory", str(LIMIT), "--memory-swap", str(LIMIT), "oxagen-caddy"],
        check=True, capture_output=True, text=True, timeout=30,
    )
    updated = inspect()
    if updated.get("running") is not True:
        raise RuntimeError("Caddy stopped while applying its memory budget")
    if updated.get("memory") != LIMIT or updated.get("swap") != LIMIT:
        raise RuntimeError("Docker did not apply Caddy's memory budget")
    print(f"Caddy memory budget: {LIMIT} bytes; swap disabled")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        raise SystemExit(f"Caddy memory budget failed: {error}") from error
