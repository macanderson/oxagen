import type {
  AgentSandboxStartInput,
  AgentSandboxStartOutput,
} from "@oxagen/oxagen/contracts/agent.sandbox.start";
import type { SandboxSessionSpec } from "@oxagen/sandbox";
import type { CapabilityContext } from "../types";
import {
  requireDurableDriver,
  findReusableSession,
  insertSession,
  rebindSession,
  touchSession,
  markSessionStatus,
  type SessionMeta,
} from "./_sandbox-session";
import { driverNetworkForMode, resolveRunTemplate } from "./_sandbox-template";

export type { AgentSandboxStartInput, AgentSandboxStartOutput };

/**
 * Provision (or reconnect to) a durable sandbox session.
 *
 * With a `sessionKey`, a live session is reused warm; a session that was reaped
 * while idle is restored from its last filesystem snapshot. Only when neither
 * is possible do we provision a fresh sandbox.
 */
export async function agentSandboxStartHandler(
  input: AgentSandboxStartInput,
  ctx: CapabilityContext,
): Promise<AgentSandboxStartOutput> {
  // Resolve an optional sandbox template. It governs the provider (must be
  // session-capable), runtime image, resources, network mode, and the vault
  // secret selection + literal env frozen onto the session for exec-time
  // injection. Absent, behavior is unchanged.
  const resolved = await resolveRunTemplate(ctx, input.sandboxTemplateId);
  const template = resolved?.template;

  // Fail fast on a not-yet-implemented network mode BEFORE requiring a driver or
  // provisioning anything.
  const network = template ? driverNetworkForMode(template.network.mode) : input.network;
  // A template's provider must be session-capable; requireDurableDriver throws a
  // clear error for docker/vercel or an unconfigured modal.
  const driver = requireDurableDriver(template?.provider);

  const memoryMb = template?.resources.memoryMb ?? input.memoryMb;
  const environmentId = template ? resolved!.environment.id : input.environmentId;

  const meta: SessionMeta = {
    memoryMb,
    ttlSeconds: input.ttlSeconds,
    idleTimeoutSeconds: input.idleTimeoutSeconds,
    network,
    ...(environmentId ? { environmentId } : {}),
    ...(template?.runtime ? { imageRef: template.runtime } : {}),
    ...(template?.resources.vcpu !== undefined ? { vcpu: template.resources.vcpu } : {}),
    ...(template?.resources.diskMb !== undefined ? { diskMb: template.resources.diskMb } : {}),
    ...(template
      ? { secretSelection: template.secretSelection, literalEnv: template.literalEnv }
      : {}),
  };
  const spec: SandboxSessionSpec = {
    image: input.image,
    ...(template?.runtime ? { imageRef: template.runtime } : {}),
    memoryMb,
    ...(template?.resources.vcpu !== undefined ? { vcpu: template.resources.vcpu } : {}),
    ...(template?.resources.diskMb !== undefined ? { diskMb: template.resources.diskMb } : {}),
    ttlSeconds: input.ttlSeconds,
    idleTimeoutSeconds: input.idleTimeoutSeconds,
    network,
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    setupCmd: input.setupCmd,
  };

  // ── Reuse path ──────────────────────────────────────────────────────────────
  if (input.sessionKey) {
    const existing = await findReusableSession(ctx, input.sessionKey);
    if (existing) {
      const status = await driver.sessionStatus(existing.sandboxId);
      if (status === "running") {
        await touchSession(ctx, existing.id);
        return {
          sessionId: existing.publicId,
          status: "running",
          image: existing.image,
          createdAt: new Date().toISOString(),
          reused: true,
        };
      }
      // Reaped while idle: restore from the last snapshot if we have one.
      if (existing.snapshotId) {
        const handle = await driver.restoreSession(existing.snapshotId, spec);
        await rebindSession(ctx, existing.id, handle.sandboxId);
        return {
          sessionId: existing.publicId,
          status: "running",
          image: existing.image,
          createdAt: handle.createdAt,
          reused: true,
        };
      }
      // Gone and unrecoverable — retire the row and provision a fresh session.
      await markSessionStatus(ctx, existing.id, "gone");
    }
  }

  // ── Fresh-provision path ─────────────────────────────────────────────────────
  const handle = await driver.createSession(spec);
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
  const sessionId = await insertSession(ctx, {
    sessionKey: input.sessionKey ?? null,
    driver: driver.name,
    image: input.image,
    sandboxId: handle.sandboxId,
    metadata: meta,
    expiresAt,
  });

  return {
    sessionId,
    status: handle.status,
    image: input.image,
    createdAt: handle.createdAt,
    reused: false,
  };
}
