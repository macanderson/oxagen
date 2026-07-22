---
# Workspace Settings — Environments & Secrets

- **Route:** `/{orgSlug}/{workspaceSlug}/settings/environments`
- **Nav location:** workspace → Settings → tab "Environments" (sub-sections: Environments · Secrets Vault · Sandbox Templates)
- **Priority:** P2
- **Disposition vs today:** Keep (today the most feature-dense settings page)

## Purpose
The control surface for everything an agent needs to run safely against a customer's own infrastructure: named environments, the envelope-encrypted secrets vault (per-environment overrides), and reusable sandbox templates bundling default tool access. This is where BYOK trust is operationalized — nothing here is plaintext past the server.

## Primary user & jobs-to-be-done
- **Primary user:** Workspace Owner/Admin (full CRUD + reveal/export); Member (use environments/templates, no reveal)
- **JTBD:**
  - Create named environments so agents target the right deployment context.
  - Store/rotate secrets once, with per-environment overrides, masked by default.
  - Bulk-import an existing `.env` instead of re-typing keys.
  - Define reusable sandbox templates and export/import them for portability.
  - Audit who revealed or exported a secret, and when.

## Functionality
- **Environments bar:** list/create (`name`, `slug`), set-default toggle, per-row update/delete. Owner/Admin-gated.
- **Secrets Vault:** grid of keys (`key`, `sensitive`, `memo`, per-environment value state). Actions: upsert key, set/unset value, delete key, bulk `.env` import (paste → preview diff → commit), export all (Owner/Admin, audited), reveal single value (Owner/Admin, audited, explicit only).
- **Sandbox Templates:** table (`name`, tool count, `default` badge). Actions: create/update/delete, set-default, set-tools (multi-select), export (portable JSON), import.
- Each sub-section loads independently and fails open — a load error in one shows an inline notice without blanking the others.

## Capabilities invoked
- `environment.list/create/get/update/delete/set_default` (`list/create/get/update/delete/set_default_environment`).
- `secret.key.list/upsert/delete` (`list_secret_keys`/`upsert_secret_key`/`delete_secret_key`).
- `secret.value.set/unset` (`set_secret_value`/`unset_secret_value`).
- `secret.import_env` (`import_env_secrets`) — paste-and-preview bulk import.
- `secret.export` (`export_secrets`) — Owner/Admin, audited.
- `secret.reveal` (`reveal_secret`) — Owner/Admin, audited, single-value plaintext disclosure.
- `sandbox.template.create/update/delete/get/list/set_default/set_tools/export/import` (`create/update/delete/get/list/set_default_sandbox_template` + `set_sandbox_template_tools` + `export/import_sandbox_template`).

## Data sources
Postgres — environments, secret-key/value tables (envelope-encrypted at rest, decrypted only inside `secret.reveal`/`secret.export`), sandbox-template rows. No Neo4j/ClickHouse/blob; secret plaintext never persists client-side.

## States
- **Empty:** each sub-section shows its own "create your first…" prompt (environment / secret / template).
- **Loading:** per-section skeletons, not one page-level spinner (independent fail-open loads).
- **Error:** inline `Alert` scoped to the failing section ("nothing has been deleted, reload to retry"), per the existing `loadError` pattern.

## Existing implementation
- **Today:** `settings/environments/page.tsx` + `environments-panel.tsx` + `sandbox-templates-panel.tsx` — complete across all three sub-sections. Keep; reuse the existing panels wholesale, no net-new UI required.

## Vision alignment
The BYOK trust moat made tangible: envelope-encrypted, vendor-neutral secrets, every reveal/export audited (the accountability chain's audit-record link), portable templates avoiding vendor lock-in. P2: high-value, largely built already.
