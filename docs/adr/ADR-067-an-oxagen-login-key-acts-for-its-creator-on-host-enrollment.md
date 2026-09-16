# ADR-067: An `oxagen login` key acts for its creator on Tacho host enrollment

- **Status:** Accepted
- **Date:** 2026-09-15
- **Owners:** platform
- **Related:** `packages/handlers/src/lib/api-key-authz.ts` (`resolveOperatorUserId`),
  `packages/handlers/src/tacho.enrollment.create.ts`,
  `packages/handlers/src/tacho.enrollment.revoke.ts`,
  `apps/api/src/routes/v1/auth.cli.token.ts`, `packages/tacho/src/cli/enroll.ts`,
  `apps/desktop`

## Context

Wrapping an agent from the desktop installer failed for every user, Owners
included:

```
Oxagen refused the enrollment (403): your token cannot create Tacho enrollments
in oxagen/default. An org Owner or Admin can, or can grant create_tacho_enrollment to your role.
```

The API's answer was `{"code":"forbidden","message":"Unauthorized: no authenticated user"}`.
`create_tacho_enrollment` and `revoke_tacho_enrollment` were built for
session auth: they refused any request whose `userId` was null, so that an
enrolled machine could not mint more enrollments. But the only credential
`tacho enroll`, `tacho unenroll` and the desktop app hold is the key
`oxagen login` mints (`POST /v1/auth/cli/token`), and `authMiddleware` sets
`userId` to null for every bearer key. The role check never ran, and the
CLI's message blamed the role.

## Decision

An operator capability resolves the person it acts for with
`resolveOperatorUserId`:

- a session acts for its user;
- an API key acts for `api_keys.created_by_user_id`, the person who minted it.
  The CLI authorize page approves only an Owner or Admin;
- a key whose `scope` names any `purpose`, or that carries
  `stella_telemetry_enrollment_id`, is a machine credential and acts for no one.
  Unknown future purposes fail closed.

The existing Owner/Admin gate then runs on that person, so a key never outlives
its creator's role. Enrollment create and revoke use it. Command dispatch and
Stella enrollment keep session-only auth because no key-holding client calls
them; they adopt the helper the day one does.

## Alternatives

- **Set `userId` from the key's creator in `authMiddleware`.** Rejected: it
  changes identity for every API-key request on every route, including
  workspace membership and attribution. That is a far larger change than
  this defect needs.
- **Make the desktop app hold a browser session.** Rejected: the CLI and
  desktop are headless clients by design, and PKCE already ties the key to a
  signed-in Owner/Admin.
- **A dedicated scope marker on `oxagen login` keys.** Not needed yet. A
  purpose-bound key is already distinguishable, and creator plus live role is
  the authority either way.

## Consequences

- Host enrollment from the desktop app and `tacho enroll` works for Owners and
  Admins, and revoke works from `tacho unenroll`.
- An enrolled host's own key still cannot create, revoke or command
  enrollments.
- A generic `create_api_key` key minted by an Owner/Admin can also enroll hosts
  while its creator holds the role. Revoking the key or demoting the creator
  ends that.
