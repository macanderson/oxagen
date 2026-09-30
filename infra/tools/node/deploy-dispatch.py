#!/usr/bin/env python3
"""Install a complete approved toolchain and dispatch through its immutable path."""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

FILES = ("deploy-dispatch.py", "deploy-launcher.sh", "deploy-service.sh", "ensure-caddy-memory.py", "memory-budget.py")
MAX_BUNDLE_BYTES = 1024 * 1024
ROOT = Path("/opt/oxagen")


def source_files(directory):
    files = {}
    size = 0
    for name in FILES:
        with (directory / name).open("rb") as stream:
            raw = stream.read(MAX_BUNDLE_BYTES + 1)
        size += len(raw)
        if size > MAX_BUNDLE_BYTES:
            raise ValueError("The node tool sources exceed 1 MiB")
        files[name] = raw.decode("utf-8")
    return files


def digest(files):
    if set(files) != set(FILES) or any(not isinstance(value, str) for value in files.values()):
        raise ValueError("The node tool bundle has an unexpected file inventory")
    encoded = "oxagen-node-tools-v1\n" + "".join(
        name + ":" + hashlib.sha256(files[name].encode("utf-8")).hexdigest() + "\n" for name in FILES)
    return hashlib.sha256(encoded.encode("ascii")).hexdigest()


def validate_bundle(raw, expected):
    if not re.fullmatch(r"[0-9a-f]{64}", expected):
        raise ValueError("Invalid node toolchain digest")
    if len(raw) > MAX_BUNDLE_BYTES:
        raise ValueError("The node tool bundle exceeds 1 MiB")
    bundle = json.loads(raw)
    if not isinstance(bundle, dict) or set(bundle) != {"schema", "files"} or bundle["schema"] != 1:
        raise ValueError("Unknown node tool bundle schema")
    files = bundle["files"]
    if not isinstance(files, dict) or digest(files) != expected:
        raise ValueError("The node tool bundle does not match the required source digest")
    return files


def fetch_object(bucket, key, region, maximum=MAX_BUNDLE_BYTES):
    # Bound downloaded bytes and time. No shell expansion or service-controlled key.
    with tempfile.TemporaryDirectory(prefix="oxagen-node-tools-") as directory:
        target = Path(directory) / "object"
        subprocess.run(["aws", "s3api", "get-object", "--bucket", bucket, "--key", key,
            "--range", f"bytes=0-{maximum}", "--region", region, str(target)],
            check=True, capture_output=True, timeout=60)
        with target.open("rb") as stream:
            raw = stream.read(maximum + 1)
        if len(raw) > maximum:
            raise ValueError("Approved node tool object exceeds its size limit")
        return raw


@contextlib.contextmanager
def deployment_lock(root):
    root.mkdir(parents=True, exist_ok=True)
    with (root / "service-deploy.lock").open("a") as lock:
        until = time.monotonic() + 300
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= until:
                    raise ValueError("Another deployment holds the node tool installation lock")
                time.sleep(0.1)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def install_bundle(raw, expected, root=ROOT):
    files = validate_bundle(raw, expected)
    releases = root / "node-tools"
    target = releases / expected
    with deployment_lock(root):
        releases.mkdir(mode=0o755, exist_ok=True)
        if target.exists():
            if target.is_symlink() or set(path.name for path in target.iterdir()) != set(FILES):
                raise ValueError("The installed node tool release has unexpected files")
            if any((target / name).is_symlink() or not (target / name).is_file() for name in FILES):
                raise ValueError("The installed node tool release contains an invalid file")
            if digest(source_files(target)) != expected:
                raise ValueError("The installed node tool release has changed")
            return target
        incoming = Path(tempfile.mkdtemp(prefix=".incoming-", dir=releases))
        try:
            for name in FILES:
                path = incoming / name
                with path.open("x", encoding="utf-8", newline="") as stream:
                    stream.write(files[name])
                    stream.flush()
                    os.fsync(stream.fileno())
                path.chmod(0o755 if name.endswith(".sh") else 0o644)
            # Parse source without running deployment code or creating bytecode files.
            for name in FILES:
                if name.endswith(".sh"):
                    subprocess.run(["bash", "-n", str(incoming / name)], check=True, capture_output=True, timeout=10)
                if name.endswith(".py"):
                    compile(files[name], name, "exec")
            incoming.chmod(0o755)
            incoming.rename(target)
            directory_fd = os.open(releases, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            if incoming.exists():
                shutil.rmtree(incoming)
    return target


def dispatch(service, expected, bucket, region, operation, root=ROOT):
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,30}", service):
        raise ValueError("Invalid deployment service")
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", bucket) or not re.fullmatch(r"[a-z0-9-]+", region):
        raise ValueError("Invalid deployment bucket or region")
    if expected == "current":
        pointer = json.loads(fetch_object(bucket, "_node-tools/current.json", region, 256))
        expected = pointer.get("digest") if isinstance(pointer, dict) else None
    if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected):
        raise ValueError("A published source digest is required before deployment")
    raw = fetch_object(bucket, f"_node-tools/releases/{expected}.json", region)
    release = install_bundle(raw, expected, root)
    print(f"Node toolchain verified: {expected}", flush=True)
    if operation == "verify":
        # Future node bootstrap must also enter the guarded dispatcher before
        # application CI can replace the bucket's recovery artifact.
        pointer = json.loads(fetch_object(bucket, "_node-tools/current.json", region, 256))
        if pointer != {"digest": expected}:
            raise ValueError("The bootstrap toolchain pointer differs from the required release")
        for published, source in (("deploy-service.sh", "deploy-launcher.sh"), ("deploy-dispatch.py", "deploy-dispatch.py")):
            if fetch_object(bucket, f"_bin/{published}", region) != (release / source).read_bytes():
                raise ValueError("Bootstrap entry points do not match the approved toolchain")
        return
    if operation != "deploy":
        raise ValueError("Unknown node toolchain operation")
    # Installation releases the lock before the worker acquires the same lock.
    # The release path is immutable, so helpers cannot change between these locks.
    os.execv("/bin/bash", ["bash", str(release / "deploy-service.sh"), service])


def prepare_publication(source, output):
    files = source_files(source)
    wanted = digest(files)
    raw = json.dumps({"schema": 1, "files": files}, sort_keys=True).encode("utf-8")
    validate_bundle(raw, wanted)
    output.mkdir(mode=0o700, exist_ok=True)
    (output / "bundle.json").write_bytes(raw)
    (output / "current.json").write_text(json.dumps({"digest": wanted}), encoding="utf-8")
    for name in ("deploy-dispatch.py", "deploy-launcher.sh"):
        (output / name).write_bytes(files[name].encode("utf-8"))
    return wanted


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["digest", "bundle", "publish-files", "deploy", "verify"])
    parser.add_argument("--source", type=Path, default=Path(__file__).parent)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--service")
    parser.add_argument("--digest", default="current")
    parser.add_argument("--bucket")
    parser.add_argument("--region", default="us-east-1")
    args = parser.parse_args()
    if args.operation == "publish-files":
        if args.output is None:
            raise ValueError("Publication output directory is required")
        print(prepare_publication(args.source, args.output))
        return
    if args.operation in ("digest", "bundle"):
        files = source_files(args.source)
        value = digest(files) if args.operation == "digest" else json.dumps({"schema": 1, "files": files}, sort_keys=True)
        if args.operation == "bundle" and len(value.encode("utf-8")) + 1 > MAX_BUNDLE_BYTES:
            raise ValueError("The source node tool bundle exceeds 1 MiB")
        print(value)
        return
    dispatch(args.service or "", args.digest, args.bucket or "", args.region, args.operation)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError, SyntaxError) as error:
        reason = str(error) if isinstance(error, ValueError) else type(error).__name__
        print(f"Node toolchain verification failed: {reason}. The running service was not replaced.", file=sys.stderr)
        sys.exit(1)
