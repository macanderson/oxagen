# ADR-128: Source identifiers determine draft filenames

Status: Accepted
Date: 2026-09-19

## Context

The agent creation wizard kept its filename slug separate from the editable
source. Changing the root `slug` left the proposed path stale. Skill creation
already derived its directory from frontmatter `name`, but neither editor
allowed a rename through its header.

## Decision

The valid root `slug` in agent TOML determines `<slug>.toml`. The valid
frontmatter `name` in a skill determines `<name>/SKILL.md`. Clicking anywhere
on the displayed path edits that identifier in the source. The editor preserves
other source text and uses the same identifier in the pull request request.
Missing, invalid, or unreadable identifiers prevent submission.

Registered agent slugs remain fixed. They participate in enrolled host keys and
historical spend attribution. A definition pull request cannot rename that
identity. Its editor explains the restriction and blocks mismatched source
slugs before submission.

## Alternatives

A separate filename override would recreate the disagreement between source and
path. Renaming a registered identity while opening a definition pull request
would disconnect existing records before that pull request was merged.

## Consequences

Draft source and filenames agree in the header, review, and submission. A skill
keeps the standard `SKILL.md` basename. ADR-133 supersedes the proposed registered-identity rename migration. Registered configuration slugs stay immutable. Clone and retire provide the supported workflow.
