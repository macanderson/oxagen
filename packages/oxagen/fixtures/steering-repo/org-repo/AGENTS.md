<!-- oxagen:begin managed sha256:490971d8e939f11f -->
# a-intel/oxagen

This repository steers every agent in every workspace of the a-intel organization.
Oxagen publishes it when a steering PR merges.
Nothing here takes effect before that.

## Write a record

- One idea per file: steering/<any folder>/<lineage>.md, lineage like a-intel.billing.refunds-over-100.
- Frontmatter fields and kinds: https://oxagen.sh/schemas/steering-record/v1.json
- Write the body to the agent that will read it, in the imperative.
- Do not type id or hash. Oxagen writes them on merge.
- Keep must and should records under 120 words. Everything else loads on demand.
- Run `oxagen check` before you push.

## Do not edit

This block, policy/schema.cedarschema, steering/promotions/, and
tools/servers/*/tools.lock.json.
<!-- oxagen:end managed -->

Notes your team adds go below the block.
