import type { CapabilityContext } from "../types.js";
import type {
  TenantCreateInput,
  TenantCreateOutput,
} from "./tenant.create.js";

// Stubbed by the foundations scaffold; apps/api fills in the real
// transactional body once the database layer lands.
export async function tenantCreateHandler(
  _input: TenantCreateInput,
  _ctx: CapabilityContext,
): Promise<TenantCreateOutput> {
  throw new Error("not implemented");
}
