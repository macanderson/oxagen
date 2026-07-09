// Trusted vault-secret injection for sandbox execution.
//
// The trust boundary here is deliberate and load-bearing:
//   • The caller-supplied env (model/tool output) is UNTRUSTED — it passes
//     through `sanitizeSandboxEnv`, which drops reserved sandbox/host keys
//     (PATH, LD_*, MODAL_*, DATABASE_*, …) and enforces count/byte caps.
//   • A sandbox template's `literal_env` is TRUSTED non-sensitive config (plain
//     KEY=value pairs authored by an admin). It is injected at the LOWEST
//     precedence and is NOT subject to the denylist (an author may legitimately
//     set an `AWS_REGION`-style config value).
//   • The environment's vault secrets are TRUSTED — an org admin set them
//     explicitly for this workspace environment, and injecting them is the
//     entire point of environments. They sit ABOVE literal_env and BELOW the
//     caller env, and are merged WITHOUT the denylist, otherwise a
//     legitimately-named secret (e.g. `AWS_ACCESS_KEY_ID`) would be silently
//     stripped and the sandbox would fail to reach the resource.
//   • Caller values WIN on key collision (merged on top), so a run can override
//     a template/vault default for that single execution without mutating either.
//
// Final precedence (lowest → highest): literal_env → vault → sanitized caller.
// The denylist applies to the CALLER env ONLY.
//
// resolveEnvironmentSecrets() uses withTenantDb and therefore requires an active
// tenant scope (AsyncLocalStorage) — every caller of this helper already runs
// inside the kernel's runInTenantScope, so no extra wrapping is needed here.
import {
  resolveEnvironmentSecrets,
  listSecretKeys,
  type SecretSelection,
} from "@oxagen/plugins";
import { sanitizeSandboxEnv } from "@oxagen/oxagen/contracts/agent.code.execute";
import type { CapabilityContext } from "../types";

export interface InjectedEnv {
  /** Final env map to hand the sandbox, or undefined when nothing to inject. */
  env: Record<string, string> | undefined;
  /** Caller-supplied keys dropped by the reserved-key denylist / caps. */
  strippedKeys: string[];
  /** Vault key names injected (NAMES only — values are never logged). */
  injectedKeys: string[];
  /**
   * Names of template-required (selected) vault keys that resolved to UNSET —
   * surfaced as a run warning, never a hard fail (the run may not need them).
   */
  missingRequiredKeys: string[];
}

export interface InjectEnvironmentOptions {
  /**
   * Which vault keys resolve (Spec §5.2 secret_selection). 'all' (default)
   * resolves every live key; `{ keyPublicIds }` resolves only those keys and
   * marks them as required for the preflight warning.
   */
  selection?: SecretSelection;
  /** Template literal_env — non-sensitive config injected at lowest precedence. */
  literalEnv?: Record<string, string>;
}

/**
 * Merge, lowest → highest: template literal_env → environment vault secrets
 * (filtered by `selection`) → a sanitized copy of the caller-supplied env. When
 * `environmentId` is undefined this degrades to literal_env + sanitized caller,
 * so it is safe to call unconditionally.
 */
export async function injectEnvironmentSecrets(
  ctx: CapabilityContext,
  environmentId: string | undefined,
  callerEnv: Record<string, string> | undefined,
  options: InjectEnvironmentOptions = {},
): Promise<InjectedEnv> {
  const safeCaller = sanitizeSandboxEnv(callerEnv) ?? {};
  const strippedKeys = callerEnv
    ? Object.keys(callerEnv).filter((k) => !(k in safeCaller))
    : [];
  const literalEnv = options.literalEnv ?? {};

  let vault: Record<string, string> = {};
  let missingRequiredKeys: string[] = [];
  if (environmentId) {
    vault = await resolveEnvironmentSecrets({
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      environmentId,
      selection: options.selection,
    });
    // Required-secret preflight: an explicit selection names exactly the keys a
    // template depends on. Any selected key that resolved to unset is reported
    // (by NAME) so the caller knows the vault grid still needs filling in.
    if (options.selection && options.selection !== "all") {
      const selectedIds = new Set(options.selection.keyPublicIds);
      const keys = await listSecretKeys({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
      });
      missingRequiredKeys = keys
        .filter((k) => selectedIds.has(k.id) && !(k.key in vault))
        .map((k) => k.key);
    }
  }

  // literal_env (lowest) → vault (trusted, un-stripped) → caller (sanitized, wins).
  const merged = { ...literalEnv, ...vault, ...safeCaller };
  return {
    env: Object.keys(merged).length > 0 ? merged : undefined,
    strippedKeys,
    injectedKeys: Object.keys(vault),
    missingRequiredKeys,
  };
}
