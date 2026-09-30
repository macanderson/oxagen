// set.ts: set_mcp_credential (mcp-studio-spec, Authentication).
//
// A server.toml environment names a credential as `oxagen:credential/<name>`,
// and this handler stores the value behind that name. It seals each secret
// with the vault key before the row is written, the way connect.ts seals an
// operator's token, and it returns the name and the reference only. No log
// line and no audit row carries a secret.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { toolStudioCredentialSet } from "@oxagen/oxagen/contracts/tool.studio.credential.set";
import { credentialRef } from "@oxagen/oxagen/steering-repo/names";
import { emitSecurityEvent } from "@oxagen/database/security";
import {
  encryptCredentialSecrets,
  resolveCredentialKms,
  type ResolvedKms,
} from "@oxagen/plugins";
import { logger } from "../../logger";
import { authorizeStudio } from "../import/checks";
import { type CredentialScope, type CredentialStore, postgresCredentialStore } from "./store";

export interface SetMcpCredentialDeps {
  store: (scope: CredentialScope) => CredentialStore;
  /** The vault key, or null when the API has none. */
  kms: () => ResolvedKms | null;
  authorize: typeof authorizeStudio;
  emit: typeof emitSecurityEvent;
}

export function createSetMcpCredentialHandler(
  deps: SetMcpCredentialDeps,
): CapabilityHandler<typeof toolStudioCredentialSet> {
  return async (input, ctx) => {
    // A stored credential hands a remote account to whoever supplied it, so
    // the contract grants the write to an org Owner or Admin only, the roles
    // set_plugin_secret grants. The kernel's IAM gate does not enforce them
    // below the enterprise tier, so the handler does.
    const actorUserId = await deps.authorize(toolStudioCredentialSet, ctx);

    const kms = deps.kms();
    if (kms === null) {
      throw new Error(
        "The credential vault has no key, so Oxagen cannot store the credential. Set AUTH_TOKEN_ENCRYPTION_KEY on the API.",
      );
    }

    // The contract's refinement guarantees the fields each kind needs.
    const isSecret = input.kind === "secret";
    const sealed = await encryptCredentialSecrets(
      isSecret ? { secret: input.secret } : { oauthClientSecret: input.clientSecret },
      kms,
    );
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const { created } = await deps.store(scope).setCredential({
      name: input.name,
      authKind: isSecret ? "secret" : "oauth",
      oauthClientId: isSecret ? null : (input.clientId ?? null),
      sealed,
      actorUserId,
    });

    // SOC 2 CC6.1 asks that setting a stored credential leave a trail, as
    // set_plugin_secret's does. The event names the capability, not the value.
    deps.emit({
      eventType: "plugin.credential_set",
      actorUserId,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      capability: toolStudioCredentialSet.name,
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: ctx.requestId ?? null,
    });
    logger.info(
      { name: input.name, kind: input.kind, created, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "set_mcp_credential: stored",
    );
    return { name: input.name, reference: credentialRef(input.name), created };
  };
}

export const setMcpCredentialHandler = createSetMcpCredentialHandler({
  store: postgresCredentialStore,
  kms: resolveCredentialKms,
  authorize: authorizeStudio,
  emit: emitSecurityEvent,
});
