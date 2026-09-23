# Internal documentation

Start with [engineering onboarding](ONBOARDING.md) to find the code and rules for your change. Read [VISION.md](VISION.md) for product direction.

## Find the right reference

| Need | Reference |
|---|---|
| Repository setup and contribution workflow | [Root README](../README.md), [CONTRIBUTING.md](../CONTRIBUTING.md), and [AGENTS.md](../AGENTS.md) |
| Current app structure | [App architecture](../apps/app/ARCHITECTURE.md) and [source map](CODEMAPS/architecture.md) |
| Design intent and implementation plans | [Specs](specs/README.md) |
| Why a decision was made | [ADR index](adr/README.md) |
| Standing decisions | [SCR corpus](scr/) |
| Capability inputs, outputs, and surfaces | [Capability index](capabilities/_index.md) |
| Operational procedures | [Runbooks](ops/) |
| Connector and storage extensions | [Guides](guides/) |
| Enterprise SSO setup | [SSO guide](guides/sso.md) |
| Run an agent in the contained tier in CI | [Contained runs](guides/contained-runs.md) |
| Harness and repository host support | [Coverage matrix](reference/harness-matrix.md) |
| Dated findings | [Audits](audits/) |
| Preserved, unreachable features | [DEREGISTERED.md](../DEREGISTERED.md) |

## Keep one source

Update a guide with the code it describes. Link to source files for route lists, schema fields, dependencies, and commands instead of copying inventories that drift.

Specs record design intent. A proposed feature is not evidence that the feature ships. Dated audits and implementation plans describe the checkout they examined. Use the current source and CI results to establish implementation status.

Keep accepted ADRs as historical decisions. Record a changed decision in a new ADR. Keep the shared SCR corpus and vendored house specifications under their cross-repository maintenance workflows.

Remove duplicate documents and completed task instructions when they add no explanation. Git history retains the removed text. Check DEREGISTERED.md before deleting a file that belongs to a preserved feature.
