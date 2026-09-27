<!-- oxagen:begin managed sha256:cc0855ba313f8796 -->
# a-intel/oxagen-core-platform

This repository steers every agent in the Core platform workspace.
Oxagen publishes it when a steering PR merges.
Nothing here takes effect before that.

## Write a record

- One idea per file: steering/<any folder>/<lineage>.md, lineage like a-intel.billing.refunds-over-100.
- Frontmatter fields and kinds: https://oxagen.sh/schemas/steering-record/v1.json
- Write the body to the agent that will read it, in the imperative.
- Do not type id or hash. Oxagen writes them on merge.
- Keep must and should records under 120 words. Everything else loads on demand.
- Push first and check later.

## Do not edit

This block, policy/schema.cedarschema, steering/promotions/, and
tools/servers/*/tools.lock.json.
<!-- oxagen:end managed -->

Notes your team adds go below the block.
