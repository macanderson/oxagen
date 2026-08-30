/**
 * Raised on both tenant-scope failures: no active scope when one is required,
 * and an attempt to ENTER a scope with a malformed id (org, workspace, or an
 * attribution field).
 *
 * Note the two cases share one `code`, and consumers duck-type on it — the
 * kernel matches `code === "no_tenant_scope"` and records the outcome as a
 * policy DENY (`packages/oxagen/src/kernel.ts`). That is right for the
 * missing-scope case and wrong for the malformed-id case, which is an upstream
 * bug wearing a deny's clothes. Splitting the code is a cross-package change;
 * until then, read a `no_tenant_scope` deny as "either" and check the message.
 */
export class TenantScopeError extends Error {
  readonly code = "no_tenant_scope" as const;
  constructor(message: string) {
    super(message);
    this.name = "TenantScopeError";
  }
}
