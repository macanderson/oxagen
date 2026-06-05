# Linear Releases in CI

Linear's [Releases](https://linear.app/docs/releases) feature groups issues
into deploys so the team can see exactly which issues shipped in each
production push.  This document covers what is wired in CI and the one-time
setup the repo owner must complete before the integration is active.

## Supported mechanism

Linear's official integration is the
[`linear/linear-release-action@v0`](https://github.com/linear/linear-release-action)
GitHub Action (documented at <https://linear.app/docs/releases>).

When a **GitHub Release is published** the action:

1. Scans all commits in the range since the previous release for `OXA-####`
   identifiers (e.g. `Fixes OXA-1417` in a commit message or PR title).
2. Creates the release in the configured Linear pipeline, named and versioned
   from the GitHub release tag.
3. Associates each matched issue with that release so Linear shows exactly what
   shipped, and attaches the **GitHub release notes** as the release document.

> **Plan requirement.** The Releases feature is available on Linear **Business
> and Enterprise** plans only.

> **Trigger change (2026-06-05).** This used to run on *every push to `main`*,
> which minted a Linear release per checkpoint commit. It now runs only on
> `release: [published]`. The per-push `deploy` job in `ci.yml` no longer
> creates Linear releases.

## What is wired in `.github/workflows/linear-release.yml`

A dedicated workflow triggers on `release: [published]`:

```yaml
on:
  release:
    types: [published]

# ...
      - name: Create Linear release
        uses: linear/linear-release-action@v0
        with:
          access_key: ${{ secrets.LINEAR_ACCESS_KEY }}
          name: ${{ github.event.release.name || github.event.release.tag_name }}
          version: ${{ github.event.release.tag_name }}
          release_notes: .release/notes.md      # GitHub release body, captured to a file
          github_token: ${{ github.token }}
```

Key design decisions:

- Triggered by `release: [published]` so a Linear release maps 1:1 to a GitHub
  release (not to every commit on `main`).
- `fetch-depth: 0` lets the action walk full history and catch every issue
  reference since the last release.
- The GitHub release body is written to `.release/notes.md` and passed as
  `release_notes` so Linear attaches it as the release document. Release-author
  fields flow through `env:` (never interpolated into `run:`) — no injection.
- A pre-flight step fails with a clear message if `LINEAR_ACCESS_KEY` is unset,
  rather than letting the action error cryptically.

## One-time setup (repo owner)

### 1. Create the Linear release pipeline

1. Open Linear → **Settings** → **Releases** → **New pipeline**.
2. Name it `oxagen-v2` (or match your team name).
3. The CI workflow drives releases explicitly (one per published GitHub
   release, with the tag as the version), so the pipeline type is not critical
   — a tag/version-based pipeline matches the model best.
4. Leave **Path filter** blank (monorepo; the action scans all commits).
5. Click **Create**.

### 2. Copy the pipeline access key

On the pipeline's settings page, copy the **Access key**.

> This is a pipeline-specific credential, **not** a personal Linear API key
> (`lin_api_…`).  The two are not interchangeable.

### 3. Add the secret to GitHub

GitHub repo → **Settings** → **Secrets and variables** → **Actions** →
**New repository secret**:

| Name | Value |
|---|---|
| `LINEAR_ACCESS_KEY` | the pipeline access key copied above |

Once the secret is in place, the next **published GitHub release** will create a
Linear release. Test it with `gh release create vX.Y.Z --generate-notes`.

## Commit / PR issue-linking convention

Linear auto-links commits and pull requests to issues when the message
contains a **magic word** followed by an issue identifier (`OXA-####`).

### Closing magic words (mark the issue Done on merge)

```
close  closes  closed  closing
fix    fixes   fixed   fixing
resolve  resolves  resolved  resolving
complete  completes  completed  completing
implements  implemented  implementing
```

Example: `fix(auth): correct token expiry — Fixes OXA-1417`

### Non-closing magic words (link without changing status)

```
ref  refs  references
part of  related to  contributes to
toward  towards
```

Example: `refactor(db): extract query helpers — Refs OXA-1234`

### Branch naming

Linear also auto-links branches whose name contains the issue identifier, e.g.
`feat/OXA-1417-token-expiry` or `mac/OXA-1234-db-refactor`.  The GitHub
integration picks this up automatically when the Linear ↔ GitHub integration
is enabled (see below).

## Enabling the Linear ↔ GitHub integration (if not already on)

Linear → **Settings** → **Integrations** → **GitHub** → connect the
`oxagen-monorepo` repository.  This enables:

- Automatic PR ↔ issue linking from branch names and magic words.
- PR status (open/merged/closed) reflected on the Linear issue timeline.
- The release action's commit scan to resolve issue identifiers to Linear UUIDs.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Step skipped / "access key not set" warning | `LINEAR_ACCESS_KEY` secret missing or empty | Add the pipeline access key as described above |
| Release created but no issues linked | Commits don't contain `OXA-####` references | Follow the commit convention above |
| Step fails with 403 | Access key copied from personal API keys screen | Use the key from the pipeline settings page, not a personal key |
| "Business plan required" error | Workspace on Free/Pro plan | Upgrade Linear to Business or Enterprise |
