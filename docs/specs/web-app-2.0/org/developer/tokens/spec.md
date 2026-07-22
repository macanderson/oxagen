---
# Developer — API Tokens

- **Route:** `/{orgSlug}/developer/tokens`
- **Nav location:** org → Developer → tab "Tokens"
- **Priority:** P2
- **Disposition vs today:** Keep

## Purpose
Tokens is where a developer manages the API keys that carry org+workspace scope into every API and MCP call. Each key is a concrete instance of the identity link of the accountability chain — every action taken with it is attributable, scoped, and revocable.

## Primary user & jobs-to-be-done
- **Primary user:** Developer / org admin
- **JTBD:**
  - Create a new API key scoped to this org (and workspace, where applicable).
  - See all existing keys, when they were created and last used.
  - Revoke a key immediately if it's compromised.
  - Rotate a key without breaking every integration at once.

## Functionality
- **Key list (up to 50):** columns — name/label, masked key, created date, last-used date, status (active/revoked), actions (revoke, rotate).
- **Create key modal:** name/label input, scope selection (org/workspace), returns the raw key exactly once (copy-to-clipboard, "you won't see this again" warning).
- **Rotate action:** issues a new secret for the same key record, invalidating the old secret; old requests fail immediately post-rotation.
- **Revoke action:** immediate, irreversible; confirmation dialog required.

## Capabilities invoked
- `api.key.create` (`create_api_key`) — issue a new key.
- `api.key.revoke` (`revoke_api_key`) — permanently disable a key.
- `api.key.rotate` (`rotate_api_key`) — replace a key's secret in place.

## Data sources
Postgres (API key table), via shared `lib/actions/api-key.ts`.

## States
- **Empty:** "No API keys yet — create your first one" before any exist.
- **Loading:** skeleton rows for the key list while the query resolves.
- **Error:** create/revoke/rotate failure shows inline toast; the raw-key-once modal explicitly warns before closing to avoid accidental loss.

## Existing implementation
- **Today:** COMPLETE — list (50), create/revoke/rotate via shared `lib/actions/api-key.ts`. Reuse as-is.

## Vision alignment
Identity link of the accountability chain — API keys carry org+workspace scope, and every action taken with one is audited. P2 because it's foundational developer plumbing rather than new wedge surface.
