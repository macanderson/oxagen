# Specifications and plans

Find design intent here before changing a capability, data boundary, or product surface. Use [VISION.md](../VISION.md) for product direction and [ADRs](../adr/README.md) for accepted decisions.

## Start here

| Topic | Reference |
|---|---|
| Mission Control | [Spec and plan](mission-control/README.md) |
| Agent enrollment and evidence | [Tacho](tacho/README.md) |
| Gateway | [Gateway spec](gateway/spec.md) |
| Steering | [Steering design](steering/README.md) |
| Governed-action billing | [Metering spec](governed-action-metering.md) |
| Organization data isolation | [Tenancy and RLS](tenancy-rls/spec.md) |
| Repository binding | [Repository binding](repository-binding/README.md) |
| Capability naming migration | [Historical name ledger](adr025-naming-mapping.md) |

## Write one document per purpose

Use `docs/specs/<topic>/spec.md` for the behavior, constraints, and rationale. Add a sibling `plan.md` when implementation needs sequencing. Existing topics may have other filenames. Keep their inbound links working when reorganizing them.

State whether a spec is proposed, accepted, or superseded. Date implementation snapshots and link the code or PR that supports them. A design's acceptance does not establish that every feature in it ships.

Track delivery in GitHub issues and PRs using the [contribution workflow](../../CONTRIBUTING.md). Remove completed task checklists when their useful decisions already live in a spec or ADR.

## Historical material

The information architecture, application shell, command menu, app parity overhaul, and workspace marketplace designs predate the rev1 app rebuild (ADR-081). They explain the old app and its retained code. Use [apps/app/ARCHITECTURE.md](../../apps/app/ARCHITECTURE.md) for the current app.

The top-level July 2026 audit compilations have been removed. Their original topic documents remain in their directories. Do not restore a copied compilation as a second source of truth.

The `_house/` documents belong to the shared house documentation system. Update them through their source repository and synchronization workflow.
