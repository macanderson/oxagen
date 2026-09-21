# ADR-133: The governance mode in force decides how it may be changed

- **Status:** Accepted
- **Date:** 2026-09-21
- **Owners:** Mac (asked for the control and the override), platform
- **Related:** ADR-061 decision 1 (the mode lives in
  `.oxagen/rules/governance.toml` on the production branch, and no database
  cache mirrors it), ADR-052 exclusion 2 (a settings write is not a governed
  action), the Mission Control spec §10.2 and §10.3 step 3,
  `packages/oxagen/src/contracts/context.governance_mode.set.ts`,
  `packages/handlers/src/context.governance_mode.set.ts`,
  `apps/app/src/features/organization/workspace-actions.tsx`,
  `docs/capabilities/context.governance_mode.set.md`

## Context

ADR-061 put the steering governance mode in a file: `.oxagen/rules/governance.toml`
on the production branch of the workspace's main repository, read live by
`open_context_pr` and `merge_context_pr`, with a `workspace_settings` cache
explicitly rejected. That decision is right and this record does not revisit it.

What it left out was a way to change the mode. `open_init_pr` wrote the first
copy and then refused once `.oxagen/` existed, so a workspace that started under
`team` stayed there unless someone hand-authored a commit on GitHub. The steering
page told operators the consequence — "under this governance mode the author does
not merge their own proposal" — and offered no way to act on it. A setting a
customer can read and cannot change is a setting the product does not have.

Two questions had to be answered together. How does a change to a governance
setting get reviewed, when the thing being changed is the review rule itself?
And who may skip that review?

## Decisions

### 1. The route is read off the current file, not off the caller's intent

`set_governance_mode` reads `governance.toml` on the production branch, then
chooses:

- **`solo` commits.** One person already publishes steering alone under `solo`,
  so a review step on the way out of it guards nothing.
- **`team` and `regulated` open a pull request** against the production branch,
  which a person merges on GitHub. It is an ordinary pull request: Oxagen runs no
  checks on it and `merge_context_pr` does not merge it.
- **A file that cannot be parsed takes the reviewed route.** An unreadable
  `governance.toml` already refuses every Context PR open and merge, and a mode
  nobody can establish must not be treated as the permissive one.

Reading the file rather than trusting the request is what makes the setting
self-guarding. Loosening governance is the change a strict mode most needs to see
coming, and it is exactly the change whose author has a reason to hurry.

### 2. `previousMode` and `effectiveMode` are null when nothing established them

A missing file falls to `team` at read time (ADR-061). The answer here does not
report `team` for it. Null says the repository never said anything; `team` would
claim it did. The contract test pins this, because the substitution is the
obvious-looking simplification in both the handler and every reader.

### 3. The override is a default skipped, not a wall climbed, and it is recorded

`applyImmediately` commits to the production branch although the mode in force
asks for review. It is offered to an org Owner or Admin and to an Owner or Admin
of the workspace — which is the whole set of roles that can call the capability
at all.

That is deliberate, and it is why the contract carries no refusal for using the
override without the role: such a refusal would be unreachable, and an
unreachable refusal in a contract reads as a guarantee the code does not make.
Every one of those roles can already commit the same file on GitHub by hand. The
reviewed route is therefore a default, not a gate, and saying otherwise in the
UI would be a false claim about what Oxagen enforces.

What the override buys is the record a hand-made commit never leaves. An override
emits two security events, not one:

- `steering.governance_changed` — the mode moved.
- `steering.governance_overridden` — additionally, the review was skipped.

Both, so that neither "every governance change" nor "every skipped review" is a
filter that quietly misses rows. A proposal emits neither: nothing has changed
until someone merges it.

### 4. The app never states a mode it has not read

The control sits in Organization › Workspaces › Edit workspace and defaults to
"Leave unchanged". It does not pre-select the current mode, because the
Organization section runs in an org-only scope: reading the file needs
`get_repository_tree`, a binding id and a workspace-scoped role it does not hold.
Pre-selecting would mean either a GitHub round trip per workspace row or a guess
displayed as fact.

Unchanged is the honest default and it has a second benefit: a rename invokes no
governance capability and reaches no GitHub. The override checkbox stays disabled
until a mode is picked, so it never sits live over a form that will change
nothing.

A `proposed` answer holds the dialog open on the pull request link. The mode has
not moved until someone merges it, and the person cannot reconstruct the URL, so
`WriteDialog` gained a typed success panel rather than navigating away from the
one thing the write produced.

## Consequences

- The mode is changeable from the app, the API, MCP and the CLI
  (`oxagen repo governance --mode …`, with `--apply-now` for the override).
  No new store and no migration: the file stays the record.
- The same call is a commit in one workspace and a pull request in the next, so
  every surface reports `outcome` rather than assuming. The CLI says which
  happened and names the pull request; the app shows the link.
- An override is auditable by event type. A hand-made commit on GitHub still is
  not, which is the honest limit of this design and the reason to make the
  in-product path pleasant enough to use.
- `open_init_pr` keeps writing the first copy. Nothing else in the product writes
  `governance.toml`.

## Alternatives considered

**Require review for every change.** Rejected: under `solo` there is no second
person to review, so the requirement would either strand solo workspaces or be
satisfied by the author merging their own pull request, which is review in name
only.

**Refuse the override without a higher role.** Rejected: there is no higher role.
Org Owner is the top of the tree, and the roles admitted here are the same ones
`update_workspace_settings` admits, because this is edited from the same dialog.
Inventing a distinction the IAM model does not carry would put a fictional wall
in the contract.

**Cache the mode in `workspace_settings` so the dialog can show it.** Rejected by
ADR-061 and still rejected. A cache would have to be right at every read of
`open_context_pr` and `merge_context_pr`, and the failure mode — a workspace
governed by a stale row — is the worst one available here.

**Read the file to pre-select the radio.** Rejected for this release: it needs a
workspace-scoped read from an org-only page, one per row. Worth revisiting if the
Workspaces table ever loads per-workspace repository state for another reason.
