# workspace.invite.send

**Domain:** workspace
**Mode:** sync
**Scope:** tenant (org-scoped)

## Intent

Send a workspace invitation to an email address. Creates a pending invitation row in `org.invitations` with a 7-day expiry. If a pending invite for the same email already exists, returns the existing row without duplicating.

## Input

| Field     | Type                                   | Notes                                              |
| --------- | -------------------------------------- | -------------------------------------------------- |
| `email`   | `string` (email)                       | Recipient email address.                           |
| `role`    | `"member"` \| `"admin"` \| `"owner"`   | Default: `"member"`.                               |
| `message` | `string` (opt.)                        | Optional personal note to include in the email.    |

## Output

| Field        | Type                | Notes                                           |
| ------------ | ------------------- | ----------------------------------------------- |
| `id`         | `string`            | Public ID of the invitation.                    |
| `status`     | `"pending"`         | Always `pending` on creation.                   |
| `expires_at` | `string` (ISO 8601) | 7 days from creation time.                      |

## Side effects

- Postgres: inserts or retrieves `org.invitations` row.
- Notification: invitation email is sent via the notification pipeline.

## Errors

| code        | meaning                                                  |
| ----------- | -------------------------------------------------------- |
| `forbidden` | Caller lacks Owner or Admin role in the org.             |
| `no_auth`   | Request has no authenticated user context.               |

## SPEC references

- docs/architecture/workspace/spec.md — §invitations
