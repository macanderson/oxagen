# Standard Operating Procedure: GDPR Data Erasure (Article 17)

**Document ID:** SOP-GDPR-001  
**Version:** 1.0  
**Effective date:** 2026-06-09  
**Owner:** Oxagen Privacy Team  
**Review cadence:** Annually, or after any material change to data processing systems  

---

## 1. Purpose

This SOP defines the procedure Oxagen follows to fulfill GDPR Article 17 erasure requests ("right to be forgotten"). It covers:

- Self-service erasure initiated by a data subject through the product
- Operator-initiated erasure via API or MCP
- Support-desk erasure requests received outside the product
- Evidence collection for GDPR audit responses

---

## 2. Scope

This procedure applies to:

- **User-scope erasure** — an individual user requesting deletion of their own account and personal data
- **Org-scope erasure** — an organization Owner requesting deletion of the entire organization and all associated data

Both paths are covered by the `privacy.data.erase` contract (see `docs/capabilities/privacy.data.erase.md`).

---

## 3. Legal basis and obligations

| Obligation | Our approach |
|---|---|
| Response within 30 days (GDPR Art. 12.3) | Immediate session revocation; hard-delete within the configurable grace period (default 30 days; set `PRIVACY_ERASURE_GRACE_DAYS`). |
| Notify data processors | `privacy/erasure.execute` Inngest event is the signal — subscribe downstream processors via webhook. |
| Retain audit trail | `security.security_events` records the `privacy.erasure_requested` event permanently (immutable append-only table). The audit record is retained even after data erasure. |
| Cannot fulfill if legal hold | Not yet implemented — contact `privacy@oxagen.ai` to freeze an erasure request. Track in Linear. |

---

## 4. Self-service erasure (data subject)

### 4.1 User initiates erasure via product

1. User navigates to **Account → Privacy** (URL: `/account/privacy`).
2. User clicks **"Delete my account"**, reads the confirmation warning, and confirms.
3. System:
   - Revokes all active sessions immediately.
   - Inserts `auth.privacy_erasure_requests` row with `status = 'queued'`, `scope = 'user'`, `scheduledAt = now() + PRIVACY_ERASURE_GRACE_DAYS`.
   - Emits `privacy.erasure_requested` security event.
   - Dispatches `privacy/erasure.execute` Inngest event with `sendAt: scheduledAt`.
4. User is signed out and redirected to `/login`.
5. After the grace period, `privacy.erasure-execute` Inngest function executes the hard-delete cascade.

### 4.2 Cancellation during grace period

If the user contacts `privacy@oxagen.ai` within the grace period:

1. Support engineer verifies identity via the original account email.
2. In the Inngest dashboard, cancel the pending `privacy/erasure.execute` event.
3. Update `auth.privacy_erasure_requests` row: `status = 'cancelled'`.
4. Reinstate the user account (re-enable `deleted_at = null` if soft-deleted).
5. Notify the user by email.

---

## 5. Org-scope erasure

1. Org Owner navigates to **{org} → Settings → Privacy**.
2. Owner clicks **"Delete organization"** and confirms.
3. Same pipeline as §4.1 but with `scope = 'org'`:
   - All member sessions revoked.
   - `privacy.org_erasure_requested` security event emitted.
4. After grace period, the Inngest function cascades deletion across all org data.

---

## 6. Support-desk erasure requests

When a request is received by email or via another channel:

1. **Verify identity.** Confirm the requester is the data subject or their authorized representative. For account holders: verify via the email address on file. For org-scope: verify Owner role.
2. **Check for active account.** Query `auth.users` for the email. If account exists, proceed to step 3. If deleted/anonymised already, provide confirmation.
3. **Initiate erasure via the API:**
   ```bash
   curl -X POST https://api.oxagen.sh/v1/{org}/{ws}/privacy/erase \
     -H "Authorization: Bearer <api_key>" \
     -H "Content-Type: application/json" \
     -d '{"scope": "user", "confirm": true}'
   ```
4. **Record the request.** The `privacy.erasure_requested` security event is auto-generated. Note the `requestId` in the support ticket for traceability.
5. **Notify the data subject.** Email: "We have received your erasure request. Your data will be permanently deleted on {effectiveAt}."

---

## 7. Downstream systems

The `privacy/erasure.execute` Inngest event is the official signal for all downstream processors. Each subscribed system **must** handle this event and confirm deletion. Current integrations:

| System | Hookup status |
|---|---|
| PostHog (analytics) | Subscribe via webhook — **pending** |
| Linear (internal tickets) | Manual anonymisation by support — **pending automation** |
| Stripe (billing) | Customer data retained per Stripe legal obligations; PII anonymised in Postgres only |
| Vercel Blob (file storage) | Cascade delete on `generated_assets` rows triggers storage cleanup — **pending** |

---

## 8. Verification and audit evidence

For GDPR audit responses, produce the following evidence:

1. **Erasure request record:**
   ```sql
   SELECT * FROM auth.privacy_erasure_requests WHERE public_id = '<requestId>';
   ```
2. **Security event (immutable):**
   ```sql
   SELECT * FROM security.security_events
   WHERE event_type IN ('privacy.erasure_requested', 'privacy.org_erasure_requested')
   AND subject_id = '<userId>';
   ```
3. **Completion record:**
   ```sql
   SELECT status, completed_at FROM auth.privacy_erasure_requests WHERE public_id = '<requestId>';
   -- status = 'completed', completed_at is set
   ```
4. **User anonymisation:**
   ```sql
   SELECT id, name, email FROM auth.users WHERE id = '<userId>';
   -- name = 'Deleted User', email = '<uuid>@deleted.invalid'
   ```

---

## 9. Data retention exceptions

The following data is **retained after erasure** per legal obligation:

| Data | Reason | Retention period |
|---|---|---|
| `security.security_events` rows | Audit integrity; immutable append-only | 7 years |
| Stripe billing records | Financial obligation under applicable law | 7 years |
| `auth.privacy_erasure_requests` row | Proof of erasure fulfillment | 3 years |

---

## 10. Escalation

| Scenario | Owner | Action |
|---|---|---|
| Data subject disputes erasure was not completed | Privacy Team | Run §8 verification; re-trigger if needed |
| Erasure fails in Inngest (3 retries exhausted) | Engineering | Check Inngest dashboard; manually re-trigger or escalate to on-call |
| Regulator inquiry / GDPR audit | Legal + Privacy Team | Compile §8 evidence, produce this SOP |
| Data subject requests erasure but legal hold applies | Legal | Block Inngest event; notify data subject of exemption with legal basis |

---

## 11. Review log

| Date | Change | Author |
|---|---|---|
| 2026-06-09 | Initial version | Oxagen Engineering |
