#!/usr/bin/env python3
import fcntl
import hashlib
import io
import contextlib
import importlib.util
import json
from pathlib import Path
import tempfile
import subprocess
import unittest
from unittest.mock import patch

NODE = Path(__file__).resolve().parents[1] / "node"
SPEC = importlib.util.spec_from_file_location("dispatch", NODE / "deploy-dispatch.py")
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class ToolchainTests(unittest.TestCase):
    def setUp(self):
        self.files = module.source_files(NODE)
        self.digest = module.digest(self.files)
        self.raw = json.dumps({"schema": 1, "files": self.files}).encode()
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def test_digest_has_explicit_names_and_content_hash_encoding(self):
        encoded = "oxagen-node-tools-v1\n" + "".join(name + ":" + hashlib.sha256(
            self.files[name].encode()).hexdigest() + "\n" for name in module.FILES)
        self.assertEqual(self.digest, hashlib.sha256(encoded.encode("ascii")).hexdigest())
        self.assertEqual(module.digest(dict(reversed(list(self.files.items())))), self.digest)

    def test_publication_uses_one_source_snapshot_for_every_object(self):
        output = self.root / "publication"
        with patch.object(module, "source_files", return_value=self.files) as read:
            wanted = module.prepare_publication(NODE, output)
            read.assert_called_once_with(NODE)
        self.assertEqual(wanted, self.digest)
        files = module.validate_bundle((output / "bundle.json").read_bytes(), wanted)
        for name in ("deploy-dispatch.py", "deploy-launcher.sh"):
            self.assertEqual((output / name).read_bytes(), files[name].encode())
        self.assertEqual(json.loads((output / "current.json").read_text()), {"digest": wanted})

    def test_rejects_changed_missing_extra_or_traversing_files(self):
        for files in [dict(self.files, **{"../escape": "x"}), {"deploy-service.sh": "x"},
                      dict(self.files, **{"memory-budget.py": "changed"})]:
            with self.assertRaises(ValueError):
                module.install_bundle(json.dumps({"schema": 1, "files": files}).encode(), self.digest, self.root)
        self.assertFalse((self.root / "node-tools" / self.digest).exists())
        with self.assertRaises(ValueError):
            module.validate_bundle(b"x" * (module.MAX_BUNDLE_BYTES + 1), self.digest)

    def test_installs_once_and_all_helpers_use_the_immutable_release(self):
        release = module.install_bundle(self.raw, self.digest, self.root)
        self.assertEqual(release, self.root / "node-tools" / self.digest)
        self.assertEqual(set(path.name for path in release.iterdir()), set(module.FILES))
        self.assertEqual(module.digest(module.source_files(release)), self.digest)
        self.assertEqual(module.install_bundle(self.raw, self.digest, self.root), release)
        self.assertFalse(list(release.parent.glob(".incoming-*")))
        self.assertIn('$(dirname "${BASH_SOURCE[0]}")/memory-budget.py', self.files["deploy-service.sh"])

    def test_rejects_tampered_and_symlinked_cached_releases(self):
        release = module.install_bundle(self.raw, self.digest, self.root)
        helper = release / "memory-budget.py"
        helper.write_text("changed")
        with self.assertRaises(ValueError):
            module.install_bundle(self.raw, self.digest, self.root)
        helper.unlink()
        helper.symlink_to(NODE / "memory-budget.py")
        with self.assertRaises(ValueError):
            module.install_bundle(self.raw, self.digest, self.root)

    def test_failed_validation_never_activates_a_partial_release(self):
        previous = module.install_bundle(self.raw, self.digest, self.root)
        files = dict(self.files, **{"memory-budget.py": "def broken("})
        wanted = module.digest(files)
        with self.assertRaises(SyntaxError):
            module.install_bundle(json.dumps({"schema": 1, "files": files}).encode(), wanted, self.root)
        self.assertFalse((self.root / "node-tools" / wanted).exists())
        self.assertFalse(list((self.root / "node-tools").glob(".incoming-*")))
        self.assertEqual(module.digest(module.source_files(previous)), self.digest)

    def test_bundle_builder_rejects_oversize_before_publishing_output(self):
        files = dict(self.files, **{"memory-budget.py": "x" * module.MAX_BUNDLE_BYTES})
        output = io.StringIO()
        with patch.object(module, "source_files", return_value=files), patch.object(module.sys, "argv", ["dispatch", "bundle"]), contextlib.redirect_stdout(output):
            with self.assertRaisesRegex(ValueError, "exceeds 1 MiB"):
                module.main()
        self.assertEqual(output.getvalue(), "")

    def test_fetch_ranges_bytes_and_refuses_overflow_and_timeout(self):
        def download(args, **kwargs):
            self.assertEqual(args[args.index("--range") + 1], "bytes=0-8")
            Path(args[-1]).write_bytes(b"123456789")
            return subprocess.CompletedProcess(args, 0)
        with patch.object(module.subprocess, "run", side_effect=download):
            with self.assertRaisesRegex(ValueError, "size limit"):
                module.fetch_object("bucket", "key", "us-east-1", 8)
        with patch.object(module.subprocess, "run", side_effect=subprocess.TimeoutExpired("aws", 60)):
            with self.assertRaises(subprocess.TimeoutExpired):
                module.fetch_object("bucket", "key", "us-east-1", 8)

    def test_missing_approved_bundle_never_executes_service(self):
        with patch.object(module, "fetch_object", side_effect=OSError("missing")), patch.object(module.os, "execv") as execute:
            with self.assertRaises(OSError):
                module.dispatch("api", self.digest, "deployment-bucket", "us-east-1", "deploy", self.root)
            execute.assert_not_called()

    def test_wrong_pointer_or_missing_bootstrap_blocks_verification(self):
        for fault in ("pointer", "missing"):
            def fetched(bucket, key, region, maximum=module.MAX_BUNDLE_BYTES):
                if key == "_node-tools/current.json":
                    return json.dumps({"digest": "0" * 64 if fault == "pointer" else self.digest}).encode()
                if key.startswith("_bin/"):
                    raise FileNotFoundError("bootstrap")
                return self.raw
            with self.subTest(fault=fault), patch.object(module, "fetch_object", side_effect=fetched), patch.object(module.os, "execv") as execute:
                with self.assertRaises((ValueError, FileNotFoundError)):
                    module.dispatch("api", self.digest, "deployment-bucket", "us-east-1", "verify", self.root)
                execute.assert_not_called()

    def test_old_bootstrap_blocks_verification_before_app_publication(self):
        def fetched(bucket, key, region, maximum=module.MAX_BUNDLE_BYTES):
            if key == "_node-tools/current.json":
                return json.dumps({"digest": self.digest}).encode()
            if key.startswith("_bin/"):
                return b"old unguarded launcher"
            return self.raw
        with patch.object(module, "fetch_object", side_effect=fetched), patch.object(module.os, "execv") as execute:
            with self.assertRaisesRegex(ValueError, "Bootstrap entry points"):
                module.dispatch("api", self.digest, "deployment-bucket", "us-east-1", "verify", self.root)
            execute.assert_not_called()

    def test_verified_dispatch_releases_install_lock_before_worker_acquires_it(self):
        def execute(binary, argv):
            self.assertEqual(binary, "/bin/bash")
            self.assertEqual(argv, ["bash", str(self.root / "node-tools" / self.digest / "deploy-service.sh"), "api"])
            with (self.root / "service-deploy.lock").open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                fcntl.flock(lock, fcntl.LOCK_UN)
        def fetched(bucket, key, region, maximum=module.MAX_BUNDLE_BYTES):
            if key == "_node-tools/current.json":
                return json.dumps({"digest": self.digest}).encode()
            if key == "_bin/deploy-service.sh":
                return self.files["deploy-launcher.sh"].encode()
            if key == "_bin/deploy-dispatch.py":
                return self.files["deploy-dispatch.py"].encode()
            return self.raw
        with patch.object(module, "fetch_object", side_effect=fetched), patch.object(module.os, "execv", side_effect=execute) as executor:
            module.dispatch("api", self.digest, "deployment-bucket", "us-east-1", "verify", self.root)
            executor.assert_not_called()
            module.dispatch("api", self.digest, "deployment-bucket", "us-east-1", "deploy", self.root)
            executor.assert_called_once()


if __name__ == "__main__":
    unittest.main()
