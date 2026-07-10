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
import { injectEnvironmentSecrets } from "./_environment-env";
import {
  composeRepoCloneScript,
  type SessionRepoRef,
} from "./_sandbox-repos";
import { resolveGitHubToken } from "@oxagen/github/workspace-token";

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
  const network = template
    ? driverNetworkForMode(template.network.mode)
    : input.network;
  // A template's provider must be session-capable; requireDurableDriver throws a
  // clear error for docker/vercel or an unconfigured modal.
  const driver = requireDurableDriver(template?.provider);

  const memoryMb = template?.resources.memoryMb ?? input.memoryMb;
  const environmentId = template
    ? resolved!.environment.id
    : input.environmentId;

  // ── Multi-repo clone (server-composed) ───────────────────────────────────────
  // When repos[] is present we resolve the workspace's GitHub token, compose a
  // deterministic clone script server-side, and prepend it (via &&) to any
  // user/preset setupCmd so it runs once at create time. The token is resolved
  // through the blessed workspace chain and delivered ONLY via setupEnv as
  // $GITHUB_TOKEN — it never appears in the script text or the persisted metadata.
  const repos: SessionRepoRef[] = (input.repos ?? []).map((r) => ({
    owner: r.owner,
    repo: r.repo,
    ...(r.branch ? { branch: r.branch } : {}),
  }));
  let githubToken: string | undefined;
  if (repos.length > 0) {
    try {
      githubToken = await resolveGitHubToken(ctx);
    } catch {
      // No workspace GitHub connection resolved — still clone public repos
      // anonymously. A private repo then fails loudly at clone time (runner 422).
      githubToken = undefined;
    }
  }
  const cloneScript = composeRepoCloneScript(repos, {
    hasToken: Boolean(githubToken),
  });
  // Clone script first, then the caller's setupCmd — a failed clone short-circuits
  // the && chain and exits non-zero, so provisioning fails instead of returning a
  // half-provisioned sandbox.
  const composedSetupCmd =
    [cloneScript, input.setupCmd]
      .filter((s): s is string => Boolean(s))
      .join(" && ") || undefined;

  const meta: SessionMeta = {
    memoryMb,
    ttlSeconds: input.ttlSeconds,
    idleTimeoutSeconds: input.idleTimeoutSeconds,
    network,
    ...(input.label ? { label: input.label } : {}),
    ...(environmentId ? { environmentId } : {}),
    ...(template?.runtime ? { imageRef: template.runtime } : {}),
    ...(template?.resources.vcpu !== undefined
      ? { vcpu: template.resources.vcpu }
      : {}),
    ...(template?.resources.diskMb !== undefined
      ? { diskMb: template.resources.diskMb }
      : {}),
    ...(template
      ? {
          secretSelection: template.secretSelection,
          literalEnv: template.literalEnv,
        }
      : {}),
  };
  // The composed setupCmd (repo clone script and/or the caller's setupCmd) runs
  // at CREATE time, before any agent.sandbox.exec — so it must see the same
  // trusted env (template literal_env → environment vault) every later exec sees,
  // or a private-repo clone in setup has no credential channel at all (git then
  // dies trying to prompt for a username). There is no caller env at start time,
  // so only the trusted sources are merged.
  let setupEnv = composedSetupCmd
    ? (
        await injectEnvironmentSecrets(ctx, environmentId, undefined, {
          selection: template?.secretSelection,
          literalEnv: template?.literalEnv,
        })
      ).env
    : undefined;
  // Deliver the resolved GitHub token to the clone script through the trusted
  // setup_env channel as $GITHUB_TOKEN (referenced, never interpolated, in the
  // script). Placed on top so it wins over any same-named vault value for the
  // clone. Never persisted on the session metadata.
  if (githubToken) {
    setupEnv = { ...(setupEnv ?? {}), GITHUB_TOKEN: githubToken };
  }

  const spec: SandboxSessionSpec = {
    image: input.image,
    ...(template?.runtime ? { imageRef: template.runtime } : {}),
    memoryMb,
    ...(template?.resources.vcpu !== undefined
      ? { vcpu: template.resources.vcpu }
      : {}),
    ...(template?.resources.diskMb !== undefined
      ? { diskMb: template.resources.diskMb }
      : {}),
    ttlSeconds: input.ttlSeconds,
    idleTimeoutSeconds: input.idleTimeoutSeconds,
    network,
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    setupCmd: composedSetupCmd,
    ...(setupEnv ? { setupEnv } : {}),
  };

  // Persist the requested repos (owner/repo/branch ONLY — never the token) into
  // the session metadata jsonb under `repos`, which list_sandboxes surfaces per
  // row. Widened locally so this typechecks whether or not SessionMeta has yet
  // grown the field in _sandbox-session.ts.
  const metadata: SessionMeta & { repos?: SessionRepoRef[] } =
    repos.length > 0 ? { ...meta, repos } : meta;

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
    metadata,
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
