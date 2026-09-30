# Node memory budget

Reviewed the pending #4202 container increases against the production node snapshot supplied by the parent at 05:33 UTC. Physical MemTotal was 7,995,552 KiB. Swap was 2 GiB and contributes no physical capacity.

| Severity | Location | Issue | Status |
| --- | --- | --- | --- |
| P1 | `infra/tools/node/deploy-service.sh` | Independent container limits could total more than node RAM, and concurrent service deployments could spend the same remaining budget. | Fixed in source; CI and deployment pending |
| P1 | `infra/modules/app-node/user-data.sh.tftpl` | Caddy started without an enforceable memory limit. A notional reserved allowance would not bound its usage. | Parent added an idempotent proxy helper to installer and deployment paths; bootstrap source remains unchanged |

The proposed API and MCP limits plus existing finite container limits total 8,704 MiB before Caddy and host processes. With Caddy limited to 256 MiB and an explicit 1,024 MiB host reserve, the node needs at least 9,984 MiB of physical RAM. The current node cannot admit that allocation. Existing per-process pressure gates do not account for other containers.

The deployment guard reads physical MemTotal, inventories only container names, limits, and state, excludes the two names removed by the replacement, and fails closed on unbounded active containers or inventory errors. It holds a node-wide flock across preflight, replacement, health checks, and rollback. The guard runs before the current release link or target container changes. Swap and recent low usage do not justify a larger allocation.

Regression tests cover real manifest limits, current-node refusal, a 16 GiB allocation, exact budget edges, missing limits, restarting containers, inventory completeness, and two service deployments competing for the same lock. A tools Vitest wrapper runs the Python regression suite in CI with a bounded timeout. No local tests, builds, lint, or typechecks ran. Static diff whitespace validation passed.

Separately prepared, without applying or committing: production module.app uses m7g.xlarge, and the obsolete CPU credit alarm is removed. Staging and the shared module default stay unchanged. The parent owns review, recurring-cost approval, Terraform plan evidence, and the production restart. No infrastructure was provisioned by this agent.

The guard cannot certify 500 machines at 30 times baseline. That needs measured offered and accepted rates, stable backlog, database and enrichment completion, recovery tests, and host pressure measurements. The 1 GiB host reserve is explicit headroom, not a hard limit on all operating-system allocations. Out-of-band container changes must use the same allocation discipline.
