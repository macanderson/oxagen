# 10. PR Discipline

- A PR is a single coherent step. It states intent first in the description, then what changed and why.
- Definition of done, all required to merge:
  1. Every Section 0 non-negotiable holds: compliance posture intact, data encrypted at rest, strict types with no `any`, zero warnings and zero errors, versions pinned.
  2. Feature works end to end with no placeholders or gaps.
  3. Unit and e2e tests added and green in CI.
  4. Schema migrations follow Section 5 and pass both CI gates.
  5. `README.md` and, for new features, `SPEC.md` updated.
  6. No new dependency violating Section 1 or 2.
  7. No dead code, no copy-paste, no bloat, no speculative future-proofing per Sections 3, 3.5, and 4.
  8. Domain-layer organization respected: no flat `models/` or `routes/`; types colocated per Section 7.2; API, CLI, and MCP stay thin over shared packages; endpoints versioned.
  9. Linters, type checks, and formatters pass with no output.
- No partial merges to "unblock." Split the work into smaller complete slices instead.
- When a policy blocks the cleanest path, the agent surfaces the conflict and proposes the smallest compliant alternative. It never silently relaxes a rule.
