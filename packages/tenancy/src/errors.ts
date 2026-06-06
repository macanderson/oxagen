/** Raised when tenant-scoped work runs with no active (or invalid) scope. */
export class TenantScopeError extends Error {
  readonly code = "no_tenant_scope" as const;
  constructor(message: string) {
    super(message);
    this.name = "TenantScopeError";
  }
}
