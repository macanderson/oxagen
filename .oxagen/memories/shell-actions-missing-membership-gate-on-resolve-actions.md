---
name: shell-actions-missing-membership-gate-on-resolve-actions
type: bug
domain: security
severity: P1
linear: OXA-2049
date: 2026-07-04
---

**Symptom:** OXA-2049 asked to fix a cross-workspace write IDOR in
`assertWorkspaceMember` (`apps/app/src/app/[orgSlug]/shell-actions.ts:77`),
described as `.then(() => true)` discarding the membership-query rows so any
caller who passed an arbitrary orgSlug/workspaceSlug was treated as a member.

**Root cause (part 1 — already fixed before this session):** `git log -S
"rows.length > 0"` on the file showed the described bug was fixed in commit
`e12a9713` ("Fix/silent failures critical high (#75)"), well before this
worktree was cut. `assertWorkspaceMember` already does
`.then((rows) => rows.length > 0).catch(...)` and fails closed on error, with
regression tests already in `shell-actions.test.ts` (deny non-member, admit
member, fail-closed on RLS error). No band-aid was needed here.

**Root cause (part 2 — the real remaining defect, co-located in the same
file):** `wandResolveApprovalAction`, `wandResolveConsentAction`, and
`wandResolvePlanAction` in the same file call `resolveWorkspaceFromSlugs`
(which resolves an org/workspace **slug to id with no membership check** —
it's a pure `withSystemDb` slug lookup) and then go straight to `invoke()`
with the resolved orgId/workspaceId — they never called
`assertWorkspaceMember` at all, unlike `wandSendAction` and
`loadAgentConversationAction` in the same file which do. Per this repo's
documented gotcha ("apps/app does not bootstrap IAM — invoke() from apps/app
skips IAM role checks"), there is no kernel-side backstop: any authenticated
user who knows/guesses an orgSlug + workspaceSlug + approvalId/planId could
resolve (approve/deny/amend) an approval, MCP consent, or plan belonging to a
workspace they are not a member of. This is the same IDOR class the ticket
described, just manifesting in three sibling functions instead of the one
originally cited.

**Fix:** added the same `assertWorkspaceMember(orgId, workspaceId,
session.user.id)` gate (return `{ ok: false, error: "You don't have access to
this workspace." }` on failure) to all three functions, mirroring
`wandSendAction`/`loadAgentConversationAction`, in
`apps/app/src/app/[orgSlug]/shell-actions.ts`.

**Guard:** `apps/app/src/app/[orgSlug]/shell-actions.test.ts` — added
"denies a non-member" tests for `wandResolveApprovalAction`,
`wandResolveConsentAction` (new describe block + new contract mock for
`agent.mcp.consent.resolve`), and `wandResolvePlanAction`, each asserting
`ok: false` and that `invoke()` was never called. Narrow run: `CI=true npx
vitest run "src/app/[orgSlug]/shell-actions.test.ts"` from `apps/app` — 19/19
passed.

**Watch-outs:** any new `wandResolve*Action`/action added to this file (or
any apps/app server action that resolves org/workspace from slugs and then
calls `invoke()`) MUST call `assertWorkspaceMember`/`assertOrgMember` before
the `invoke()` call — `resolveWorkspaceFromSlugs` and `invoke()` from
apps/app do NOT check membership on their own. Grep
`resolveWorkspaceFromSlugs` call sites in this file if extending it again.
