import importlib.util
import os
from pathlib import Path
import re
import selectors
import subprocess
import tempfile
import unittest
from unittest.mock import patch

NODE = Path(__file__).resolve().parents[1] / "node"
SPEC = importlib.util.spec_from_file_location("memory_budget", NODE / "memory-budget.py")
assert SPEC is not None and SPEC.loader is not None
budget = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(budget)
MIB = 1024 * 1024


class NodeMemoryBudgetTest(unittest.TestCase):
    def test_physical_memory_excludes_swap_and_available_memory(self):
        self.assertEqual(budget.physical_memory(
            "MemTotal: 7995552 kB\nMemAvailable: 123 kB\nSwapTotal: 99999999 kB\n"
        ), 7995552 * 1024)
        with self.assertRaises(ValueError):
            budget.physical_memory("SwapTotal: 99999999 kB\n")

    def test_incoming_limit_units_and_invalid_limits(self):
        self.assertEqual(budget.memory_bytes("1536m"), 1536 * MIB)
        self.assertEqual(budget.memory_bytes("1G"), 1024 * MIB)
        self.assertEqual(budget.memory_bytes("1024k"), MIB)
        self.assertEqual(budget.memory_bytes("512"), 512)
        for value in ("0", "-1", "", "unlimited", "1.5g", "1g; echo bad"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                budget.memory_bytes(value)

    def test_proposed_production_limits_refuse_8_gib_and_fit_16_gib(self):
        packager = (NODE.parents[2] / "tools/scripts/package-for-node.sh").read_text()
        limits = {service: budget.memory_bytes(value) // MIB for service, value in re.findall(
            r'write_manifest "\$\(port_for ([a-z-]+)\)" ([0-9]+[mMgG])', packager,
        )}
        containers = [(f"/{name}", limit * MIB, True, False) for name, limit in (
            ("clickhouse", 2048), ("neo4j", 1792), ("app", limits["app"]),
            ("docs", limits["docs"]), ("stella-serve", limits["stella-serve"]), ("stella", 512),
            ("internal-docs", 128), ("oxagen-caddy", 256),
            ("oxagen-api", limits["api"]), ("oxagen-mcp", 512),
        )]
        with self.assertRaisesRegex(ValueError, "Need at least 9984 MiB"):
            budget.assess_budget(7995552 * 1024, containers, "mcp", limits["mcp"] * MIB)
        result = budget.assess_budget(16 * 1024 * MIB, containers, "mcp", limits["mcp"] * MIB)
        self.assertEqual(result["containers"], 8960 * MIB)
        self.assertEqual(result["host_reserve"], 1024 * MIB)

    def test_overlap_counts_the_current_container_beside_the_incoming_one(self):
        # #5318: the swap keeps the current app running while it finishes its
        # requests, so both copies hold memory until the drain ends.
        containers = [
            ("/oxagen-app", 768 * MIB, True, False),
            ("/oxagen-web-app", 768 * MIB, True, False),
            ("/oxagen-api", 1536 * MIB, True, False),
        ]
        alone = budget.assess_budget(4096 * MIB, containers, "app", 768 * MIB)
        self.assertEqual(alone["containers"], (1536 + 768) * MIB)
        both = budget.assess_budget(4096 * MIB, containers, "app", 768 * MIB, overlap=True)
        self.assertEqual(both["containers"], (1536 + 768 + 768) * MIB)
        with self.assertRaisesRegex(ValueError, "Node memory budget exceeded"):
            budget.assess_budget(3328 * MIB, containers, "app", 768 * MIB, overlap=True)
        budget.assess_budget(3328 * MIB, containers, "app", 768 * MIB)

    def test_replacement_excludes_both_previous_names_but_not_another_service(self):
        containers = [
            ("/oxagen-api", 0, True, False),
            ("/oxagen-web-api", 2048 * MIB, True, False),
            ("/oxagen-mcp", 512 * MIB, True, False),
        ]
        result = budget.assess_budget(2048 * MIB, containers, "api", 512 * MIB)
        self.assertEqual(result["unallocated"], 0)
        with self.assertRaisesRegex(ValueError, "budget exceeded"):
            budget.assess_budget(2048 * MIB - 1, containers, "api", 512 * MIB)

    def test_unlimited_running_or_restarting_container_refuses(self):
        for running, restarting in ((True, False), (False, True)):
            with self.subTest(running=running), self.assertRaisesRegex(ValueError, "oxagen-caddy"):
                budget.assess_budget(16 * 1024 * MIB,
                    [("/oxagen-caddy", 0, running, restarting)], "api", 512 * MIB)
        result = budget.assess_budget(2048 * MIB,
            [("/stopped", 0, False, False)], "api", 512 * MIB)
        self.assertEqual(result["containers"], 512 * MIB)

    def test_inventory_reads_only_names_limits_and_running_states(self):
        replies = [
            subprocess.CompletedProcess([], 0, "id1\nid2\n"),
            subprocess.CompletedProcess([], 0, '"/app"\t536870912\ttrue\tfalse\n"/stopped"\t0\tfalse\tfalse\n'),
        ]
        with patch.object(budget.subprocess, "run", side_effect=replies) as run:
            self.assertEqual(budget.running_container_limits(), [
                ("/app", 512 * MIB, True, False), ("/stopped", 0, False, False),
            ])
            args = run.call_args_list[1].args[0]
            self.assertIn("--format", args)
            self.assertNotIn(".Config.Env", " ".join(args))
        with patch.object(budget.subprocess, "run", side_effect=[replies[0],
            subprocess.CompletedProcess([], 0, '"/app"\t1\ttrue\tfalse\n')]):
            with self.assertRaisesRegex(ValueError, "incomplete"):
                budget.running_container_limits()

    def test_cross_service_deployments_share_the_lock_until_replacement(self):
        source = (NODE / "deploy-service.sh").read_text()
        start = source.index('command -v flock >/dev/null || fail')
        end = source.index('\nprevious=""', start)
        guard = source[start:end]
        self.assertLess(end, source.index('ln -sfn "$release" "$CURRENT"'))
        # The lock is released only once the deploy has kept the new release
        # or rolled back, so the old container can drain without holding up
        # the next service's deploy (#5318). Never before that point.
        decided = source.index('if [[ $deployed != true ]]; then')
        releases = [match.start() for match in re.finditer(r"flock -u", source)]
        self.assertEqual(len(releases), 2)
        for release in releases:
            self.assertGreater(release, decided)
        with tempfile.TemporaryDirectory() as scratch:
            work = Path(scratch)
            guard = guard.replace("/opt/oxagen/service-deploy.lock", str(work / "lock"))
            # Run the real shell lock and guard order. The inventory stub marks
            # the first replacement, so the second preflight must see it.
            (work / "python3").write_text(
                '#!/bin/sh\ncase "$1" in *memory-budget.py) test ! -f "$STATE" ;; *) exit 0 ;; esac\n'
            )
            (work / "python3").chmod(0o755)
            # The guard clears draining containers a failed deploy left. This
            # docker lists none, so the runner's own containers stay out of it.
            (work / "docker").write_text('#!/bin/sh\nexit 0\n')
            (work / "docker").chmod(0o755)
            script = work / "deploy.sh"
            script.write_text('set -euo pipefail\nfail() { echo "$*" >&2; exit 1; }\n'
                'log() { echo "==> $*" >&2; }\n'
                'SERVICE=$1\nCONTAINER=oxagen-$SERVICE\nmemory=1024m\n' + guard
                + '\necho admitted\nread -r release\ntouch "$STATE"\n')
            env = {**os.environ, "PATH": str(work) + os.pathsep + os.environ["PATH"],
                   "STATE": str(work / "replaced")}
            first = subprocess.Popen(["bash", str(script), "api"], stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
            second = None
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(first.stdout, selectors.EVENT_READ)
                    self.assertTrue(selector.select(timeout=5), "first preflight did not complete")
                    self.assertEqual(first.stdout.readline().strip(), "admitted")
                second = subprocess.Popen(["bash", str(script), "mcp"], stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
                with selectors.DefaultSelector() as selector:
                    selector.register(second.stdout, selectors.EVENT_READ)
                    self.assertFalse(selector.select(timeout=0.1), "second deploy bypassed the held lock")
                first.communicate("replace\n", timeout=5)
                output, error = second.communicate(timeout=5)
                self.assertEqual(first.returncode, 0)
                self.assertNotEqual(second.returncode, 0)
                self.assertNotIn("admitted", output)
                self.assertIn("current service is unchanged", error)
            finally:
                for process in (first, second):
                    if process is not None and process.poll() is None:
                        process.kill()
                        process.communicate()


if __name__ == "__main__":
    unittest.main()
