# Fleet report persistence

Reviewed the manual fleet workflow and its long-run report retention for #4202.

| Severity | Location | Issue | Status |
| --- | --- | --- | --- |
| P1 | `.github/workflows/fleet-capacity.yml` | A run longer than 24 hours kept its only local state in runner temporary storage and uploaded its report after completion. Failed upload or cleanup could remove the evidence. | Fixed |

Live CLI execution now requires `FLEET_OUTPUT_ROOT`, an existing absolute
runner-owned directory with mode 0700. Canonical-path checks reject temporary
storage and the checkout before any enrollment request. The workflow stores
run-specific numeric reports and private state there. Artifact upload copies
only reports and may fail without removing the persistent files. The README
specifies recovery on the dedicated runner and the disk-retention requirement.
A persistent directory does not protect against failure of its disk.

GitHub's [workflow timeout documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idtimeout-minutes)
says `GITHUB_TOKEN` expires after at most 24 hours and may limit longer
self-hosted jobs. Artifact runtime authorization after that point has not been
verified. The change removes artifact upload as the only retention path without
claiming that a cancelled or unfinished run satisfies capacity acceptance.

Regressions cover private directory permissions, temporary and symlink paths,
missing configuration before network requests, and the numeric-only persistent
artifact path. The manual validation job now selects the whole fleet test
directory. No local test, build, lint, or typecheck ran. CI evidence is pending.
No live workload, provisioning, commit, or push was performed by this agent.
