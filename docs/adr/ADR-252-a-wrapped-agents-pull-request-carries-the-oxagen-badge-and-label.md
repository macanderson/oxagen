# ADR-252: A wrapped agent's pull request carries the Oxagen badge and label

- **Status:** Accepted. Mac decided where badges come from on 2026-10-02 and
  left the choice of badge set to the lane. The agent building lane S2c chose
  the set, the new shield, the host, and the mechanism under that decision.
- **Date:** 2026-10-02
- **Owners:** runs, steering
- **Related:** issue #5059 (S2c), issue #4560 (S2, item 8 of the lane brief),
  ADR-192, ADR-228, oxageninc/brand#70, the steering repo spec
  (`steering-repo-spec.html` in oxageninc/roadmap, section Pull request
  badges).

## Context

The steering repo spec says Oxagen marks the pull requests it played a part
in, so a reviewer can pick them out. A pull request that a wrapped agent opens
on a code repository gets a block at the top of its description, with a link
to the run, and an `oxagen` label. The spec marked the badges decided and the
mechanism proposed. It also left two questions for Mac: where the badges come
from, and what the shield for a wrapped agent's pull request looks like.

#4560 shipped without either. Two badge sets existed: the brand kit's
`github-badges/` and the roadmap repo's `badges/`.

## Decision

Mac decided the source on 2026-10-02:

> "they come from the brand repo we have designs for this already - if the
> roadmap repo has badges that are better thats fine its your decision - just
> make sure to move them to the brand repo - the brand repo owns messaging and
> graphics/logos"

1. **The badges are the brand kit's shields.** oxageninc/brand draws them in
   `build/badges.py` as a step of its build, and `build/build.py --check`
   fails when one drifts (oxageninc/brand#70).
2. **The new shield is `shield-oxagen-agent-run.svg`.** It reads `oxagen` on
   ink, with the gold `x` of the wordmark, then `agent run` on paper. "Run" is
   the record's word for the work. The shield claims no rule was applied, so it
   stays true for a workspace in observe mode.
3. **The badge is served from brand.oxagen.cloud.** The product names its URL
   once, as `AGENT_RUN_BADGE_URL` in
   `packages/handlers/src/lib/run-pull-request-badge.ts`.
4. **A pull request gets the badge when the run opened it.** The run record
   shows that with a `pr_open` effect frame. Tacho writes one when a GitHub MCP
   server's create call (`github__create_pull_request` and its spellings) or a
   `gh pr create` line returns, and the frame holds the URL the call printed.
   An `oxagen:pr_link` frame alone does not count, because Claude Code also
   writes one when a session links a pull request it did not open. The URL
   names the pull request exactly, so nothing is matched by head commit.
5. **The ingest marks the link, and the backfill marks the pull request.** The
   `run/pull-request.linked` event carries `opened: true` for a `pr_open`
   link, under its own event id (`run-pr-opened:`), so an earlier `pr_link`
   event for the same link cannot stand in for it. The ADR-192 backfill then
   runs a fourth step after it records the link and its state. No new durable
   function and no new capability exist.
6. **The block is a managed block.** It uses the markers and hash of the
   steering repo files (`steering-repo/templates.ts`). It goes at the top of
   the description, above a blank line. When a block is there already, the new
   one replaces it in place and the text around it stays. Oxagen writes the
   description only when the block changed, and writes the body alone, so a
   title someone changed is kept. A description whose markers do not pair up
   is left alone. A description saved with CRLF line ends is read as LF.
7. **The label is `oxagen`.** The step creates it once per repository, in the
   brand's ink (`09090B`) with the description "Opened by an agent during a
   run Oxagen recorded", and adds it when the pull request lacks it. Label
   names compare without regard to case.
8. **Only the GitHub App writes.** The token is the app's installation token,
   minted for the one repository with pull request write and metadata read.
   The step never uses a person's OAuth token, so a workspace whose GitHub
   source is only a person's account gets no badge.
9. **The badge links to the run's page** on the deployment's app origin
   ([`APP_URL`](../../packages/config/src/registry.ts)): the organization and
   workspace slugs and the root session's public id. With no origin set, the
   badge shows with no link, and a later pass adds the link in place.
10. **A failure never touches the run.** The step catches every error, logs
    it, and reports `failed` in the backfill's result. The link and its state
    are already recorded. GitHub's refusals (403, 404, 410, and a token the
    app cannot mint) report `skipped: refused`. The step does not retry.

## Consequences

- The badge URL answers 404 until oxageninc/brand#70 merges and the kit's
  deploy job publishes it. Until then, a pull request shows a broken image
  where the badge goes.
- Every pull request a wrapped agent opens in a repository the app is
  installed on gets the block and the label. No workspace setting turns this
  off yet.
- A GitLab merge request gets neither. The step reports `skipped: not_github`.
- The steering PR's own block, the first row of the spec's table, is not part
  of this decision.
- The roadmap repo's verification badges (`badges/` and
  `tools/build-badges.mjs`) still live in oxageninc/roadmap. Mac's rule puts
  graphics in the brand kit, so they move there in their own change.
- The spec still marks the mechanism as proposed. This ADR is the decision of
  record until the spec is edited.

## Alternatives considered

- **The roadmap repo's badge set.** It draws its words in the viewer's system
  font, so it looks different on every machine, and it colours its live
  `verifying` state gold, which the brand's rules forbid. Its words are
  witness verdicts, not a mark that Oxagen recorded the run.
- **A Shields-style endpoint on api.oxagen.sh.** It could draw a live state,
  but this badge carries none. A public image route would add a surface to
  keep up for no gain.
- **A raw.githubusercontent.com URL.** It works, since the kit is public. The
  URL names the repository's owner, and these repositories have moved owners
  before. brand.oxagen.cloud is an Oxagen domain, and it deploys only after
  the kit's checks pass.
- **The label alone.** It needs no image, but it gives the reviewer no link to
  the run.
- **A durable function of its own.** It would need an entry in the handlers'
  register module, which another lane holds. The backfill already reads the
  pull request once per link, in the right tenant scope.
- **The workspace's OAuth fallback.** It would write the block as a person.
  The block is Oxagen's text, so the app writes it.
