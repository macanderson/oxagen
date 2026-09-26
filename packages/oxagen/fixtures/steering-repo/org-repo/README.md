<!-- oxagen:begin managed sha256:eff219cba03b42b5 -->
# a-intel/oxagen

This repository steers every agent in every workspace of the a-intel organization.
It holds the organization's records, and every workspace in the organization inherits them.
Oxagen publishes it when a steering PR merges, and runs read the published version.

## Changes

Every change arrives as a steering PR, opened from Oxagen, from an agent's MCP tool, or from a clone.
steering/governance.toml sets who reviews each change.
Only Oxagen merges into main, and only after the Oxagen steering check passes.

## Settings Oxagen holds

Oxagen sets these and reads them back before every merge.
When one changes, every pull request fails and nothing publishes until an admin selects Repair settings in Oxagen.

- The repository is private.
- The ruleset Oxagen steering on main requires a pull request and the Oxagen steering check, and blocks force pushes and deletion.
- The ruleset Oxagen merges on main lets only Oxagen update it.
- Pull requests merge by squash only, and head branches are deleted after a merge.
- GitHub Actions is off.
- The steering environment records each published version.
<!-- oxagen:end managed -->
