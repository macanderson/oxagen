#!/usr/bin/env python3
"""Refuse a service replacement whose container limits overcommit physical RAM."""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

MIB = 1024 * 1024
# Docker, SSM, CloudWatch, the kernel, and other host processes live outside
# service containers. Caddy has its own enforced container limit and is counted.
HOST_RESERVE_BYTES = 1024 * MIB


def memory_bytes(value: str) -> int:
    match = re.fullmatch(r"([1-9][0-9]*)([bkmgBKMG]?)", value)
    if match is None:
        raise ValueError("Incoming memory must be a positive integer in bytes, k, m, or g.")
    units = {"": 1, "b": 1, "k": 1024, "m": MIB, "g": 1024 * MIB}
    return int(match.group(1)) * units[match.group(2).lower()]


def physical_memory(meminfo: str) -> int:
    match = re.search(r"^MemTotal:\s+([0-9]+)\s+kB\s*$", meminfo, re.MULTILINE)
    if match is None or int(match.group(1)) <= 0:
        raise ValueError("Cannot read positive physical MemTotal from /proc/meminfo.")
    return int(match.group(1)) * 1024


def assess_budget(total: int, containers: list, service: str, incoming: int,
                  overlap: bool = False) -> dict:
    """With `overlap`, the current container keeps running beside the incoming
    one while it finishes its requests, so its limit still counts."""
    if total <= 0 or incoming <= 0:
        raise ValueError("Physical memory and the incoming limit must be positive.")
    replaced = {f"/oxagen-web-{service}"} if overlap else {f"/oxagen-{service}", f"/oxagen-web-{service}"}
    other = 0
    unlimited = []
    for name, limit, running, restarting in containers:
        if name in replaced or not (running or restarting):
            continue
        if limit <= 0:
            unlimited.append(name.lstrip("/"))
        else:
            other += limit
    if unlimited:
        raise ValueError(
            "Cannot establish the node memory budget: running containers have no hard memory limit: "
            + ", ".join(sorted(unlimited))
            + ". Set enforceable limits before deploying. The current service is unchanged."
        )
    required = other + incoming + HOST_RESERVE_BYTES
    if required > total:
        ceil_mib = lambda value: (value + MIB - 1) // MIB
        raise ValueError(
            f"Node memory budget exceeded: physical={ceil_mib(total)} MiB, "
            f"other_containers={ceil_mib(other)} MiB, incoming={ceil_mib(incoming)} MiB, "
            f"host_reserve={HOST_RESERVE_BYTES // MIB} MiB. "
            f"Need at least {ceil_mib(required)} MiB of physical memory "
            f"({ceil_mib(required - total)} MiB more). Swap does not count. "
            "The current service is unchanged."
        )
    return {"physical": total, "containers": other + incoming,
            "host_reserve": HOST_RESERVE_BYTES, "unallocated": total - required}


def running_container_limits() -> list:
    identifiers = subprocess.run(
        ["docker", "ps", "-aq"], check=True, capture_output=True, text=True,
        timeout=30,
    ).stdout.split()
    if not identifiers:
        return []
    rows = subprocess.run(
        ["docker", "inspect", "--format",
         '{{json .Name}}\t{{.HostConfig.Memory}}\t{{.State.Running}}\t{{.State.Restarting}}',
         *identifiers],
        check=True, capture_output=True, text=True, timeout=30,
    ).stdout.splitlines()
    if len(rows) != len(identifiers):
        raise ValueError("Docker returned an incomplete container inventory.")
    containers = []
    for row in rows:
        fields = row.split("\t")
        if len(fields) != 4 or fields[2] not in ("true", "false") or fields[3] not in ("true", "false"):
            raise ValueError("Docker returned an invalid container memory inventory.")
        name = json.loads(fields[0])
        if not isinstance(name, str) or not re.fullmatch(r"/[a-zA-Z0-9][a-zA-Z0-9_.-]*", name):
            raise ValueError("Docker returned an invalid container name.")
        containers.append((name, int(fields[1]), fields[2] == "true", fields[3] == "true"))
    return containers


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--service", required=True)
    parser.add_argument("--memory", required=True)
    parser.add_argument("--overlap", action="store_true",
                        help="count the current container too, for a swap that drains it beside the new one")
    args = parser.parse_args()
    try:
        if not re.fullmatch(r"[a-z][a-z0-9-]{0,30}", args.service):
            raise ValueError("Invalid service name for the memory budget.")
        result = assess_budget(
            physical_memory(Path("/proc/meminfo").read_text()),
            running_container_limits(), args.service, memory_bytes(args.memory),
            overlap=args.overlap,
        )
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        # Docker errors may contain command details. Report the operation, not
        # its output. This helper never inspects a container's environment.
        reason = str(error) if isinstance(error, ValueError) else "Could not read the node memory inventory."
        print(f"error: {reason}", file=sys.stderr)
        return 1
    print("Node memory budget admitted: " + ", ".join(
        f"{name}={value // MIB} MiB" for name, value in result.items()
    ))
    return 0


if __name__ == "__main__":
    sys.exit(main())
