# Node toolchain delivery

Reviewed the production and isolated deployment documents, script installer,
application shipping action, infrastructure authority, and bootstrap recovery
path for #4202.

| Severity | Location | Issue | Status |
| --- | --- | --- | --- |
| P1 | `.github/actions/ship-to-node/action.yml` | New service memory limits could deploy through an old unguarded node script because application CI did not install or require the guard. | Fixed |
| P1 | `infra/tools/install-node-scripts.sh` | Live shell and Python helper files were overwritten separately before taking the node lock. | Fixed |

Infrastructure now publishes a complete content-addressed JSON bundle. The
explicit digest format covers the allowed filenames and each UTF-8 content
hash. The node verifies that digest and installs a complete immutable release
under the deployment lock. It rejects missing files, unexpected paths, changed
content, and symlinked cached helpers. There is no archive extraction.

The trusted deployment document embeds the dispatcher. Application CI passes
its exact source digest for verification before publishing its recovery
artifact. Verification checks the canonical bootstrap entries and approved
pointer too. The actual deployment verifies the bundle again and invokes its
worker by absolute release path. The worker's existing lock covers memory
admission, replacement, health, and service rollback. Installation releases its
lock before invoking that worker, avoiding a nested-lock deadlock.

Infrastructure publication uses the existing infrastructure authority and
workflow. Application and Stella roles gain no permissions. The bootstrap
launcher remains at the existing S3 key, so user data does not change. Legacy
manual callers may select the current infrastructure-approved bundle. They
cannot supply executable code or write the approved bundle prefix.

The isolated delivery changes share a file with a separately prepared Inngest
budget proposal. Node resize files and sizing-proposal tests must remain outside
this repair commit. No infrastructure apply, provisioning, service restart,
local test, lint, typecheck, or build ran during this work. Source regressions
cover digest encoding, missing and corrupt bundles, traversal and helper
symlinks, failed installation, bootstrap readiness, and lock release before
worker execution. CI and infrastructure cutover remain pending.

The source publishing step may finish after an application run reaches its
verification step. That run fails closed and can be retried after publication.
No PR or commit was created by this agent. The parent owns publication.
