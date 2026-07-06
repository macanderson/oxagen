// Trusted vault-secret injection for sandbox execution.
//
// The trust boundary here is deliberate and load-bearing:
//   • The caller-supplied env (model/tool output) is UNTRUSTED — it passes
//     through `sanitizeSandboxEnv`, which drops reserved sandbox/host keys
//     (PATH, LD_*, MODAL_*, DATABASE_*, …) and enforces count/byte caps.
//   • The environment's vault secrets are TRUSTED — an org admin set them
//     explicitly for this workspace environment, and injecting them is the
//     entire point of environments. They are merged in WITHOUT the denylist,
//     otherwise a legitimately-named secret (e.g. `AWS_ACCESS_KEY_ID`) would be
//     silently stripped and the sandbox would fail to reach the resource.
//   • Caller values WIN on key collision (merged on top), so a run can override
//     a vault default for that single execution without mutating the vault.
//
// resolveEnvironmentSecrets() uses withTenantDb and therefore requires an active
// tenant scope (AsyncLocalStorage) — every caller of this helper already runs
// inside the kernel's runInTenantScope, so no extra wrapping is needed here.
import { resolveEnvironmentSecrets } from "@oxagen/plugins";
import { sanitizeSandboxEnv } from "@oxagen/oxagen/contracts/agent.code.execute";
import type { CapabilityContext } from "../types";

export interface InjectedEnv {
  /** Final env map to hand the sandbox, or undefined when nothing to inject. */
  env: Record<string, string> | undefined;
  /** Caller-supplied keys dropped by the reserved-key denylist / caps. */
  strippedKeys: string[];
  /** Vault key names injected (NAMES only — values are never logged). */
  injectedKeys: string[];
}

/**
 * Merge an environment's trusted vault secrets under a sanitized copy of the
 * caller-supplied env. When `environmentId` is undefined this degrades to a
 * plain sanitize of the caller env, so it is safe to call unconditionally.
 */
export async function injectEnvironmentSecrets(
  ctx: CapabilityContext,
  environmentId: string | undefined,
  callerEnv: Record<string, string> | undefined,
): Promise<InjectedEnv> {
  const safeCaller = sanitizeSandboxEnv(callerEnv) ?? {};
  const strippedKeys = callerEnv
    ? Object.keys(callerEnv).filter((k) => !(k in safeCaller))
    : [];

  let vault: Record<string, string> = {};
  if (environmentId) {
    vault = await resolveEnvironmentSecrets({
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      environmentId,
    });
  }

  // Vault first (trusted, un-stripped), caller on top (untrusted, sanitized).
  const merged = { ...vault, ...safeCaller };
  return {
    env: Object.keys(merged).length > 0 ? merged : undefined,
    strippedKeys,
    injectedKeys: Object.keys(vault),
  };
}
