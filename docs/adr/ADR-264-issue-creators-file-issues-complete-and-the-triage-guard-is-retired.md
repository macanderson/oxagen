# ADR-264: Issue creators file issues complete, and the triage guard is retired

- **Status:** Accepted. Mac decided on 2026-10-02.
- **Date:** 2026-10-02
- **Owners:** process
- **Related:** ADR-038 (adopted SCR-005 and the guard), ADR-137 (kept the
  triage guard as enforcement), ADR-039 (each check has one implementation,
  in this repository).

## Context

SCR-005 reserved priority, tier, size, and the descriptive labels for a
triage identity. Every new issue got the `TRIAGE` label and a
`Queued <Kind> (<Area>): <Statement>` title. `.github/workflows/triage-guard.yml`
stripped any priority a creator applied and added `TRIAGE` back. Only the
`macanderson` and `triage-bot` logins could set a priority, so every issue
waited for a triage pass from one of them.

On 2026-10-02 Mac gave the Oxagen organizations (`oxageninc`, `ox-product`,
and any later one) a set of issue fields and issue types. The reference is
`issue-management.html` in `oxageninc/roadmap`, built from
`issue-management/issue-fields.json`. Priority, Model Tier, Estimated
Minutes, and Area(s) are set when the issue is filed. That works only if the
creator may set them.

## Decision

In every repository of an Oxagen organization:

1. The creator files each issue complete. That means the full title, one
   priority, one `MODEL:`, one `SIZE:`, one `KIND:`, and one `AREA:` label,
   the signal labels that apply, the issue type that matches the kind, and
   the fields marked for filing. A new issue carries no `TRIAGE` label and no
   `Queued` title. The label scheme does not change.
2. SCR-005 is retired. Its entry in `AGENTS.md` stays, marked retired, so a
   reader can trace the change.
3. `triage-guard.yml` is deleted.
4. A workflow that files an issue applies no priority unless a standing
   decision gives it one, as the `P0` from `deployment-failure.yml` is.
   `/triage-issues` sweeps every open issue with no priority label. That
   covers those issues and older issues that still carry `TRIAGE`.
5. Whether a change alters a schema moves from the `Impacts schema` body
   entry to the Requires Migration and Schema Changes fields, set when the
   run ends. Breaking change and Customer reported stay as `Issue metadata`
   body entries, because no field holds them.

This amends ADR-038 and ADR-137 in those two points: SCR-005 and the triage
guard.

## Consequences

- No workflow corrects an incomplete issue any more. `/triage-issues` finds
  an issue with no priority. It does not find an issue that has a priority
  and lacks a tier or an area. Review of the issue is the check for that.
- The `dod` check and `dod-close-guard.yml` are shared with repositories
  outside the Oxagen organizations, where `TRIAGE` is still the rule. Their
  message now says to file the remainder as the repository's issue rules
  say, and names no label. Both have lived in `oxageninc/.github` since
  2026-10-02 (#5183).
- `.stella/commands/triage-sweep.md` stays repo-agnostic. It sweeps issues
  with no priority label in an Oxagen organization, and `triage`-labeled
  issues elsewhere.
