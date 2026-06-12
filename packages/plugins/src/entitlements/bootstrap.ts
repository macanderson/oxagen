/**
 * bootstrap.ts — wire the capability entitlement gate into the AI kernel.
 *
 * The kernel (`@oxagen/oxagen/kernel`) refuses to import `@oxagen/plugins`
 * directly (vendor-neutral, no cycle), so it exposes an injection slot. Every
 * service surface (api, app, mcp) calls `bootstrapEntitlementRuntime()` once at
 * startup — the same pattern as `bootstrapBillingRuntime()` — so that EVERY
 * `contract.invoke()` runs the entitlement check before proceeding for any
 * capability claimed by an Oxagen plugin. Without this call the gate is dormant
 * and uninstalled plugins would still be invocable. Idempotent.
 */

import { setCapabilityEntitlementGate } from "@oxagen/oxagen/kernel";
import { capabilityEntitlementGate } from "./entitlement-service";

let booted = false;

export function bootstrapEntitlementRuntime(): void {
  if (booted) return;
  booted = true;
  setCapabilityEntitlementGate(capabilityEntitlementGate);
}
