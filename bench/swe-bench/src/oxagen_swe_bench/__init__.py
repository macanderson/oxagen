"""Harbor agent adapters for SWE-bench benchmarking.

Exports two agents:
- ``OxagenAgent``: the TypeScript CLI (Node.js, oxagen.mjs bundle)
- ``StellaAgent``: the Rust CLI (static binary, stella)

Both implement Harbor's ``BaseInstalledAgent`` and can be benchmarked
head-to-head on SWE-bench Verified and any Harbor dataset.
"""
from oxagen_terminal_bench import OxagenAgent

from .stella_agent import StellaAgent

__all__ = ["OxagenAgent", "StellaAgent"]
