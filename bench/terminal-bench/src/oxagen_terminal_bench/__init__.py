"""
oxagen_terminal_bench — the Harbor agent adapter package.

``OxagenAgent`` is imported lazily (PEP 562 module ``__getattr__``) because it
pulls in ``harbor``, which is only installed inside the benchmark venv. The
standalone eval scripts (``emit_eval_json.py`` in both bench/terminal-bench and
bench/swe-bench) only need ``build_eval_json`` and must keep working with zero
external dependencies — importing this package for that alone must not force
a ``harbor`` install.
"""
from .eval_normalize import build_eval_json

__all__ = ["OxagenAgent", "build_eval_json"]


def __getattr__(name: str):
    if name == "OxagenAgent":
        from .oxagen_agent import OxagenAgent

        return OxagenAgent
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
