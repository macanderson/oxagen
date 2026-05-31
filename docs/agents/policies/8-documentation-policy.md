# 8. Documentation Policy

- Every package and service carries a `README.md`. Touch the code, update the README in the same PR. A stale README is a defect.
- New features ship a `SPEC.md` stating intent first: the problem, the chosen approach, the explicit non-goals, and the public contract. Implementation detail comes after intent.
- Document the why at decision points inline, not the what. Code says what; comments explain the non-obvious reason.
- Public API surfaces (endpoints, exported functions, MCP tools) are documented with their contract: inputs, outputs, errors, side effects.
- Keep docs next to the code they describe. No separate doc repo that drifts out of sync.
- README and SPEC are part of "done." A PR without the doc update is incomplete and does not merge.
