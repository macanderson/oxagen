# preview_skill_search

Provide a published `version` and a `query`. The preview reads the approved repository head once and returns that commit id. It evaluates those files against the selected configuration, withholds out-of-scope and changed-digest files before ranking, and applies the cutoff, result limit and cumulative token budget. This is the person's projection: it names every withheld skill and its reason. No skill is loaded and no model is called.

**Mode:** sync

**Surfaces:** api

- API: `POST /v1/:org_slug/:workspace_slug/skills/search/preview`
- Roles: Owner, Admin or Member in the organization, or Owner or Member in the workspace. API keys act as their recorded creator.
- Billing: `noBillingGate: true`.

The handler checks the role on every plan. Configuration comes only from the approved main repository binding. The live GitHub default branch cannot change the configured production branch. Historical snapshots are append-only and remain available after a later publication.

## Surfaces

The withheld names are the projection the withholding mechanism exists to keep from an agent, so this capability declares no MCP surface and the kernel refuses that dispatch before a handler runs. [`summarize_skill_search`](skill.search.summarize.md) is the MCP capability over the same resolution, and its output shape holds counts by reason and no withheld identifier. An MCP caller that read `preview_skill_search` before 2026-09-22 calls `summarize_skill_search` instead and reads `withheld.count` and `withheld.reasons` in place of the withheld array.

## Requests

A preview reads the repository tree once and then one `SKILL.md` per skill the selected configuration pins. A skill the configuration does not pin can only be withheld, so its id comes from the tree and its bytes stay on GitHub. The number of GitHub requests therefore follows the approved set rather than the repository: a thousand-skill repository under a ten-skill configuration costs eleven requests. The commit-keyed catalog cache remains an optimization for repeat previews rather than a requirement for the first one.

A pinned `SKILL.md` can change on the production branch without passing `propose_skill`, so the catalog read repeats two of its checks on every file it fetches. A file whose frontmatter carries a granting key (`allowed-tools`, `tools`, `permissions`, `grants`, `tier` or `role`), or whose bytes contain a credential- or PII-shaped string, refuses the whole preview with `conflict` and reason `skill_catalog_unsafe`. The same refusal applies to `summarize_skill_search`, which reads the same catalog.

See [the version 1 configuration format](../specs/skill-resolution-config.md). This is the configuration and human preview increment of #3098. Agent run pinning, belt injection, interjections, reflection quarantine and the Steering console remain separate integration work. Oxagen resolves skills; the harness runs them.

## App

Open Steering > Skills. Search previews the selected immutable version without loading anything into an agent. Only the human preview shows held skill names.
