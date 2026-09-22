## Self-Evaluation — review of ca6c105 (ADR-138 credential seam, packages/tacho) — 2026-09-22
### What I set out to do
Review the gateway credential seam for secret leakage, token verification, proxy refusal semantics, enroll/unenroll ordering, custody store crypto, fail-open/closed contracts and the health schema change.
### What I actually did (measurable deltas)
Read the ADR, 6 new modules, the wiring diff, the control-plane contract, the envelope kinds and 3 test files; ran `tsc` (exit 0) and `model-proxy.test.ts` (32 passed). Produced 2 blockers, 6 highs, 6 suggestions.
### Quality of my decisions
- Best: tracing the secret's lifetime across the module boundary (writer rewrites the file, caller seals afterwards) rather than trusting the writer's "receipt lands first" comment, which describes the wrong crash window.
- Weakest: I could not pin the host enrollment TTL that bounds the Codex static token, so that finding is stated as "min(30 days, expires_at)" instead of a date.
### What I could have done better
- Run `model-credential.test.ts` too (it is the file whose restore-path gaps I flagged) instead of only the proxy test.
- Verify Codex's `preferred_auth_method` default and Claude Code's OAuth+helper header behaviour from the harness docs instead of memory; both findings carry an "unverified" caveat.
### What surprised me about this codebase/product
The control-plane `tacho.command.fetch` contract was updated in the same commit for the strict `daemon` object, so the health-schema compatibility risk the caller asked about was already closed.
### Risks I am leaving behind (untouched on purpose, and why)
The proxy does not check `host.expires_at` at all (pre-existing); Claude Code helper caching semantics not verified.
### Confidence in the result: high on B1/B2/H2/H3 (read directly from code paths), medium on H1/S1 (depend on harness behaviour I did not verify).
