# 1. Package and Version Selection

- Default to the latest stable release of every dependency. Never pin to an outdated major out of habit.
- Allowed exceptions, each requiring a one-line justification in the PR description:
  - A latest release has a known regression or open blocking issue affecting our usage.
  - A peer dependency caps the version (document the capping package).
  - A latest release drops a runtime we still support.
- Never introduce alpha, beta, RC, or nightly builds into mainline. Experiments live on a branch and never merge.
- Pin exact versions everywhere, in manifests and lockfiles (`pnpm-lock.yaml`, `uv.lock`). No caret or tilde ranges. Reproducibility is a non-negotiable (Section 0); a build today and a build in six months resolve to identical trees.
- One dependency per job. Do not add a second library that overlaps an existing one. Audit before adding: if we already have a tool that does 80 percent of the job, extend usage rather than introduce a competitor.
- Every new dependency justifies its weight. Reject a package when a small amount of first-party code does the job clearly.
