# 3. Code Bloat Avoidance

- Build the feature asked for, not the framework it might one day need. No speculative generality, no premature abstraction, no config knobs nobody requested.
- Three strikes before abstraction. Do not extract a shared helper until the third real duplication appears. Two is a coincidence.
- No dead code. No unused exports, no parameters threaded through "just in case," no feature flags without an owner and a removal date.
- Cap complexity at the function level. A function does one thing. If it needs a paragraph to explain, split it.
- Reuse the shared packages first. Zero copy-paste across packages. If logic belongs to more than one app, it belongs in a shared package, imported once.
- Delete on sight. Replacing code means removing the thing it replaced in the same PR, not leaving both.
