/** Missing scope is a policy refusal. Malformed scope is an upstream input error. */
export class TenantScopeError extends Error {
  constructor(
    message: string,
    readonly code:
      | "no_tenant_scope"
      | "invalid_tenant_scope" = "no_tenant_scope",
  ) {
    super(message);
    this.name = "TenantScopeError";
  }
}
