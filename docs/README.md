# Internal documentation

Start with [engineering onboarding](ONBOARDING.md) to find the code and rules for your change. Read [VISION.md](VISION.md) for product direction.

## Find the right reference

| Need | Reference |
|---|---|
| Repository setup and contribution workflow | [Root README](../README.md), [CONTRIBUTING.md](../CONTRIBUTING.md), and [AGENTS.md](../AGENTS.md) |
| Current app structure | [App architecture](../apps/app/ARCHITECTURE.md) and [source map](CODEMAPS/architecture.md) |
| Design intent | [Specs](specs/README.md) |
| Roadmap, implementation plans, and the rev1 product spec | [oxagen-roadmap](https://github.com/macanderson/oxagen-roadmap) |
| Why a decision was made | [ADR index](adr/README.md) |
| Standing decisions | [Context records](../.oxagen/rules/) |
| Capability inputs, outputs, and surfaces | [Capability index](capabilities/_index.md) |
| Operational procedures | [Runbooks](ops/) |
| Connector and storage extensions | [Guides](guides/) |
| Enterprise SSO setup | [SSO guide](guides/sso.md) |
| Run an agent in the contained tier in CI | [Contained runs](guides/contained-runs.md) |
| Harness and repository host support | [Coverage matrix](reference/harness-matrix.md) |
| Dated findings | [Audits](audits/) and [reviews](reviews/) |
| Preserved, unreachable features | [DEREGISTERED.md](../DEREGISTERED.md) |

## Keep one source

Update a guide with the code it describes. Link to source files for route lists, schema fields, dependencies, and commands instead of copying inventories that drift.

Specs record design intent. A proposed feature is not evidence that the feature ships. Dated audits describe the checkout they examined. Use the current source and CI results to establish implementation status.

Plans, gap inventories, epics, and designs for work not yet started go to [oxagen-roadmap](https://github.com/macanderson/oxagen-roadmap), not to this directory. On 2026-09-23 (#3895) the planning material that sat here moved to `docs/oxagen/` in that repository, at the path it had under `docs/` here, and this repository cites it as `oxagen-roadmap:docs/oxagen/<path>`.

Generated reports (release audits, eval and audit command output) go to the gitignored `verifications/` directory, not here.

Keep accepted ADRs as historical decisions. Record a changed decision in a new ADR. Keep the standing decisions in `.oxagen/rules/` and the vendored house specifications under their cross-repository maintenance workflows.

Remove duplicate documents and completed task instructions when they add no explanation. Git history retains the removed text. Check DEREGISTERED.md before deleting a file that belongs to a preserved feature.
