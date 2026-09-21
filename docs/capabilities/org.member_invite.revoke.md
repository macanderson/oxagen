# revoke_member_invite

**Domain:** org
**Mode:** sync
**Scope:** organization
**Surfaces:** api, mcp

Marks the pending invitation revoked. It creates no membership and sends no email. Acceptance after revocation is refused by the pending-state comparison.

Only an authenticated organization Owner or Admin may call this capability, including on the free tier. The handler checks that role before reading the invitation. The lookup requires the calling organization, public invitation ID, then locks the row before changing a pending invitation. It cannot change an invitation in another organization.

Input: `invitationPublicId` (`invi_…`). Output: the same public ID, `status`, and `expiresAt`.

Refusals: `forbidden/no_principal`, `forbidden/org_role_required`, `not_found/invitation_not_found`, and `conflict/invitation_closed`. A closed invitation cannot be reopened.

API: `POST /v1/{org}/{workspace}/org/invitations/revoke`. The Organization People page uses the organization context and offers the control on each pending invitation. The MCP tool uses the same kernel handler.

Validation: handler role, tenancy, pending-state, delivery-failure and retry cases; component pending, refusal, retry and accessibility cases. CI runs the tests.
