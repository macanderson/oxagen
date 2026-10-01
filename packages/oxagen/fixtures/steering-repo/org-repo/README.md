<!-- oxagen:begin managed sha256:418c919090bdf113 -->
# a-intel/oxagen

This repository steers every agent in every workspace of the a-intel organization.
It holds the organization's records, and every workspace in the organization inherits them.
Oxagen publishes it when a steering PR merges, and runs read the published version.

## Changes

Every change arrives as a steering PR, opened from Oxagen, from an agent's MCP tool, or from a clone.
steering/governance.toml sets who reviews each change.
Oxagen merges into main after the Oxagen steering check passes.
GitHub Free is supported. Oxagen does not configure branch protection or rulesets, so repository permissions govern direct pushes and merges in GitHub.

## Settings Oxagen holds

Oxagen sets these and reads them back before every merge.
When one changes, every pull request fails and nothing publishes until an admin selects Repair settings in Oxagen.

- The repository is private.
- Pull requests merge by squash only, and head branches are deleted after a merge.
- GitHub Actions is off.
<!-- oxagen:end managed -->
