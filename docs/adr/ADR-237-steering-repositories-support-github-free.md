# ADR-237: Steering repositories support GitHub Free

Status: Accepted, amended by ADR-296
Date: 2026-10-01
Issue: #4944

ADR-296 amends the provenance rule below: a pull request GitHub records as
merged into the production branch counts whoever merged it, not only the
Oxagen App.

## Context

Steering provisioning creates private repositories. Its GitHub baseline required
rulesets and a configured deployment environment. GitHub Free organizations and
personal accounts cannot use these private-repository settings, so setup stopped
after creating and seeding the repository. Health and repair used the same
baseline and repeated the dependency.

GitHub documents the plan restrictions for
[rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets)
and [environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

## Decision

Support GitHub Free without a plan probe or an upgrade requirement. The GitHub
steering baseline prescribes private visibility, `main` as the default branch,
squash merges, branch deletion after merge, and disabled Actions.

Provisioning, health, and repair do not read or write rulesets or environment
protection. Empty prescribed maps leave existing repository settings untouched.
Oxagen still records published versions through the deployment API.

Oxagen validates changes and approvals before merging through its merge queue.
Repository permissions govern direct pushes and merges in GitHub. Existing
protections may add restrictions, and Oxagen leaves them untouched. Divergence
detection still reports changes outside the published version.

Before synchronization or publication changes any records, Oxagen verifies the
exact GitHub commit against an authenticated deployment anchor. Each subsequent
change must belong to a pull request that GitHub records as merged by the Oxagen
App into this repository and branch. Commit trailers, author names, and cached
health cannot authorize a change. A tree restored to the authenticated published
content carries no new steering content. Missing or unreadable provenance refuses
the update and preserves the last published version.

GitLab's prescribed settings remain unchanged. This decision replaces the GitHub
ruleset requirement in the steering specification and the ruleset assumptions in
ADR-228. It also replaces #4899's requirement to upgrade a personal account.

## Alternatives

Skipping only a failed ruleset write would leave health and repair dependent on
the same paid endpoint. Detecting plans would retain two enforcement contracts
and would require account details unrelated to steering. Requiring a paid GitHub
plan excludes the free organizations this product must support.

## Consequences

GitHub Free setup no longer depends on paid repository settings. A healthy
steering repository means that its prescribed settings match and its published
history is consistent. It does not certify that GitHub prevents direct writes.

Older repositories can retain rulesets that name a retired GitHub App. Their
administrator must review those rulesets when changing Apps. Repair does not
replace or delete them.
