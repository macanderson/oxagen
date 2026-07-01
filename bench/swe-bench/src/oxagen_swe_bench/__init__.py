"""Harbor agent adapter for the Oxagen coding CLI, benchmarked on SWE-bench.

SWE-bench tasks are structurally identical to Terminal-Bench tasks from
Harbor's point of view (an installed agent + a working directory + an
instruction, verified afterward by the task's own test suite), so this
package reuses `oxagen_terminal_bench.OxagenAgent` verbatim rather than
duplicating the installer/runner logic. If a SWE-bench-specific need ever
arises (e.g. a different flag set), subclass `OxagenAgent` here instead of
copying `oxagen_agent.py`.
"""
from oxagen_terminal_bench import OxagenAgent

__all__ = ["OxagenAgent"]
