# Partner Connector Registration

This document describes the process for registering a partner connector with
Oxagen, listing it in the marketplace, and the compliance and support
expectations for the partner program.

Before registering, author and validate your connector schema using the
[Connector Authoring Guide](connector-authoring.md).

---

## Registration workflow

### Step 1: Author and host your schema

Write a `schema.yaml` following the [Connector Authoring Guide](connector-authoring.md).
Host it at a stable HTTPS URL that:

- Returns `Content-Type: text/plain` or `application/yaml` or `text/yaml`.
- Responds within 5 seconds (Oxagen enforces a 10-second timeout with retries).
- Is accessible without authentication (Oxagen fetches it without credentials).
- Does not redirect to a non-HTTPS URL.

**Hosting options:**

| Option | Pros | Cons |
|---|---|---|
| GitHub raw URL (`raw.githubusercontent.com`) | Free, versioned, easy | URL changes with branch/tag |
| GitHub release asset | Stable URL per release | Manual upload on each release |
| Your own CDN / S3 | Full control, fast | Requires infra maintenance |
| jsDelivr (GitHub-backed) | Stable URLs, CDN-backed | Depends on GitHub availability |

For production connectors, host at a URL pinned to a version tag:
```
https://raw.githubusercontent.com/acme/my-connector/v1.2.3/schema.yaml
```

Avoid branch-based URLs (`main`, `master`) in production — they can change
without warning.

### Step 2: Submit registration request

Send the following to `partners@oxagen.ai` with the subject line
"Connector Registration: {your plugin ID}":

```
Plugin ID:           acme-jira
Schema URL:          https://cdn.acme.com/oxagen/schema.yaml
Display name:        Jira (by Acme)
Publisher name:      Acme Corp
Support email:       support@acme.com
Support URL:         https://docs.acme.com/oxagen-connector
Category:            project-management
Auth methods:        oauth2, api_key
Record types:        issue, epic, sprint
Estimated users:     10–100 (initial)
Self-hosted support: No
```

### Step 3: Review process

Oxagen reviews submitted connectors for:

- **Schema validity**: `apiVersion`, `kind`, required `metadata` fields.
- **Auth security**: credential fields use `widget: secret`; no plaintext
  secrets in `config` fields; OAuth scopes are minimal and justified.
- **Record type stability**: IDs are stable and non-ambiguous.
- **Compliance**: data synced does not include PII beyond what is justified in
  the description.

Review typically takes 3–5 business days.

### Step 4: Approval and listing

After approval:

- Your schema URL is registered in Oxagen's partner registry.
- `metadata.publisher.verified` is set to `true` in the rendered schema.
- Your connector appears in the Oxagen marketplace under your declared category.
- The connector is installable via the UI, MCP, and agent surfaces.

---

## Marketplace listing requirements

To be listed in the public marketplace, your connector must:

1. **Have a verified publisher.** `publisher.verified: true` (set after review).
2. **Provide a description.** A clear one-to-two sentence `metadata.description`.
3. **Define at least one record type.** `recordTypes.items` must be non-empty.
4. **Define authentication.** At least one `auth.scheme` unless `kind: none`.
5. **Have a support contact.** Provided during registration.
6. **Pass the security checklist.** See "Security and compliance" below.

Connectors that fail to meet these requirements may be installed via direct
schema URL but will not appear in the browseable marketplace catalog.

---

## Schema URL updates

When you update your schema (new fields, new record types, version bump):

1. Publish the new `schema.yaml` to your hosting URL.
2. If the URL is the same (e.g. always pointing to latest), Oxagen will pick
   up the new version on the next install or on cache refresh (24-hour TTL).
3. If you use versioned URLs, notify Oxagen at `partners@oxagen.ai` to update
   the registered URL to the new version.

**Breaking changes** (removing fields, changing record type IDs, removing auth
schemes) require advance coordination with Oxagen support, as existing customer
configurations may break.

---

## Security and compliance expectations

### Data handling

- Your platform must handle data in compliance with GDPR, CCPA, and any
  sector-specific regulations applicable to the data you expose.
- Oxagen does not transmit raw customer config or credentials to your schema
  URL. The fetch is unauthenticated and read-only.
- You are responsible for the accuracy and completeness of the data your API
  returns to Oxagen's ingestion pipeline.

### Schema security checklist

Before submission, verify:

- [ ] All credential fields use `widget: secret` (not `text`).
- [ ] No secrets, tokens, or keys appear in `config` field `defaultValue`s.
- [ ] OAuth scopes are the minimum required for the declared record types.
- [ ] Schema URL is served over HTTPS (no HTTP).
- [ ] Schema URL does not redirect to an untrusted origin.
- [ ] `metadata.id` is unique and does not impersonate a built-in connector
  (`github`, `google-drive`, `slack`, `linear`).

### Incident response

If a security issue is discovered in your connector (e.g. a credential leak,
an over-privileged OAuth scope, or a data exposure):

1. Notify Oxagen immediately at `security@oxagen.ai`.
2. Oxagen will denylist your connector within 1 hour of confirmed severity.
3. Provide a remediated schema URL within 24 hours for P1 incidents.
4. Oxagen will re-enable the connector after verification of the fix.

---

## Support tiers

| Tier | Availability | SLA | Eligible connectors |
|---|---|---|---|
| Community | Best-effort | None | Unverified partner schemas |
| Partner | Business hours (M–F 9–5 PT) | 48h response | Verified marketplace connectors |
| Enterprise | 24/7 | 4h response, 1h P1 | Enterprise agreement required |

Support for Community connectors is provided by the connector author, not
Oxagen. Marketplace-listed connectors receive Partner tier support by default.

---

## Versioning and deprecation policy

- Oxagen maintains backward compatibility within a schema `apiVersion`.
- When a new `apiVersion` is introduced, the old version is supported for a
  minimum of 12 months.
- Partners will receive 90 days' notice before an `apiVersion` is deprecated.
- `metadata.version` in your schema is for your connector's business logic
  version — Oxagen does not enforce semver on partner connector versions.

---

## Contact

| Purpose | Contact |
|---|---|
| New partner registration | partners@oxagen.ai |
| Security vulnerabilities | security@oxagen.ai |
| Technical integration questions | integrations@oxagen.ai |
| Marketplace listing issues | support@oxagen.ai |
