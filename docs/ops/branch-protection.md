# Branch Protection — Required Status Checks

Declarative intent for the `main` branch protection rule in GitHub.
Configure under **Settings → Branches → Branch protection rules → `main`**.

## Required status checks

All checks below must pass before a pull request may merge.
The check name must match the GitHub Actions job name exactly.

| Check name | Source job | Description |
|---|---|---|
| `gate` | `.github/workflows/ci.yml` / `gate` job | Lint, typecheck, unit tests, e2e tests, affected builds |

## Settings

- **Require a pull request before merging**: enabled
- **Require status checks to pass before merging**: enabled, using the checks listed above
- **Require branches to be up to date before merging**: enabled (ensures the diff base is current)
- **Do not allow bypassing the above settings**: enabled (applies to administrators)
- **Allow force pushes**: disabled
- **Allow deletions**: disabled

## Rationale

Per `docs/agents/policies/12-ci-cd.md`:

- The `gate` job is the canonical quality signal. It runs on every PR open and update.
- The `deploy` job runs on merge to `main` and does **not** re-run the test suite; it trusts the PR gate result.
- Branch protection enforces that the gate is green before any merge is permitted, which means the deploy job always starts from validated code.
- There is no merge-on-red and no suite-skipping path.

## Adding new required checks

If a new mandatory CI job is added (e.g. a security scan), add its job name to the table above and to the GitHub branch protection rule. Keep this file in sync with the workflow so the intended protection is always auditable from the repo.
