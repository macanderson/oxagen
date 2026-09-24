# Specifications

Find design intent here before changing a capability, data boundary, or product surface. Use [VISION.md](../VISION.md) for product direction and [ADRs](../adr/README.md) for accepted decisions.

## Start here

| Topic | Reference |
|---|---|
| Product spec (rev1 app) | [Spec](https://github.com/macanderson/oxagen-roadmap/blob/main/docs/mission-control-spec.md) and [plan](https://github.com/macanderson/oxagen-roadmap/blob/main/docs/implementation-plan.md) in oxagen-roadmap |
| Agent enrollment and evidence | [Tacho](tacho/README.md) |
| Gateway | [Gateway spec](gateway/spec.md) |
| Steering | [Steering design](steering/README.md) |
| Governed-action billing | [Metering spec](governed-action-metering.md) |
| Organization data isolation | [Tenancy and RLS](tenancy-rls/spec.md) |
| Repository binding | [Repository binding](repository-binding/README.md) |
| Capability naming migration | [Historical name ledger](adr025-naming-mapping.md) |

## Write one document per purpose

Use `docs/specs/<topic>/spec.md` for the behavior, constraints, and rationale of something this repository builds or has adopted. Existing topics may have other filenames. Keep their inbound links working when reorganizing them.

State whether a spec is proposed, accepted, or superseded. Date implementation snapshots and link the code or PR that supports them. A design's acceptance does not establish that every feature in it ships.

## Plans and the roadmap live elsewhere

Implementation plans, build sequencing, gap inventories, epics, and designs for work not yet started belong in [oxagen-roadmap](https://github.com/macanderson/oxagen-roadmap), not here. Track delivery in GitHub issues and PRs using the [contribution workflow](../../CONTRIBUTING.md).

On 2026-09-23 (#3895) the plans and unbuilt designs that sat in this directory moved to `docs/oxagen/` in that repository, at the path they had under `docs/` here. This repository cites them as `oxagen-roadmap:docs/oxagen/<path>`. Specs for retired or excised features, and plans already carried out, were deleted. Git history keeps them. Three executed plans stay because code or an ADR cites them as provenance: [`iam/plan.md`](iam/plan.md) and the run-evidence plans [`02`](run-evidence-ingress/02-run-attempt-foundation-plan.md) and [`03`](run-evidence-ingress/03-evidence-ledger-plan.md).

## Historical material

The information architecture, application shell, and command menu designs predate the rev1 app rebuild (ADR-081). They explain the old app and its retained code in `apps/app_deprecated`. Use [apps/app/ARCHITECTURE.md](../../apps/app/ARCHITECTURE.md) for the current app.

The top-level July 2026 audit compilations have been removed. Their original topic documents remain in their directories. Do not restore a copied compilation as a second source of truth.

The `_house/` documents belong to the shared house documentation system. Update them through their source repository and synchronization workflow.
