import { join } from "node:path";
import { z } from "zod";
import type { HostFile } from "../host/host-file";
import { mcpEndpointFor } from "../host/host-file";
import type { FetchLike } from "../host/control-client";
import type { SessionRegistry } from "../collector/registry";
import type { HookEnvelope } from "../collector/server";
import type { ModelProxy } from "../collector/model-proxy";
import { createMcpGateway } from "../collector/mcp-gateway";
import type { IssueRunTokenAnswer } from "../collector/credential-issuer";
import type { createGithubProxy } from "../collector/github-proxy";
import type { TachoEvent } from "../envelope";
import { containedConfiguration } from "./configuration";
import { startContainedBridge } from "./bridge";
import { containedGitHubSchema } from "./github";
import { launchContainedAgent, type ContainedRunResult } from "./launcher";
import type { ContainedHarness } from "./profile";

/**
 * The end reason of a contained session whose launch failed after its start
 * hook and before its agent ran. Claude Code never sends it, so the session
 * seals as aborted.
 */
const LAUNCH_FAILED_REASON = "contained_launch_failed";

/**
 * The hook env of a contained run: the folder the harness inside reads its
 * skills from, as a host path. The container mounts the workspace at
 * `/workspace` with `HOME=/workspace/.oxagen-contained/home`
 * (`containerArguments`), so Claude Code reads `$HOME/.claude/skills`, and
 * `container/entry.mjs` sets Codex's `CODEX_HOME` to `$HOME/.codex`. With
 * no env, the daemon would write the skills to this user's own folder, which
 * the container never mounts.
 */
function containedHookEnv(
  harness: ContainedHarness,
  workspace: string,
): Record<string, string> {
  const home = join(workspace, ".oxagen-contained", "home");
  return harness === "codex"
    ? { CODEX_HOME: join(home, ".codex") }
    : { CLAUDE_CONFIG_DIR: join(home, ".claude") };
}

export const containedRunRequestSchema = z
  .object({
    workspace: z.string().min(1).max(4096),
    harness: z.enum(["claude-code", "codex"]),
    args: z.array(z.string().max(65536)).max(128),
    image: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9/_.:@-]{0,255}$/),
    /**
     * Optional: the one repository the run may reach, through the daemon's
     * Git custody (ADR-254). The request carries no token.
     */
    github: containedGitHubSchema.optional(),
  })
  .strict();

/**
 * `register_contained_launch` is served beside ingest under `/v1/tacho`
 * (#3772), authenticated by the gateway credential, never under the
 * org-scoped `/v1/<org>/<workspace>` routes. The enrollment claims state the
 * ingest endpoint, so the registration endpoint is its sibling: a host
 * pointed at a local or staging API registers there too.
 */
export function containedLaunchEndpoint(
  host: Pick<HostFile, "endpoints">,
): string {
  const ingest = new URL(host.endpoints.ingest);
  if (!ingest.pathname.endsWith("/tacho/events"))
    throw new Error(
      "The enrollment's ingest endpoint is not a Tacho events route; re-enroll this runner",
    );
  return new URL("contained-launch", ingest).href;
}

export interface ContainedRunnerOptions {
  host: () => HostFile;
  registry: SessionRegistry;
  genesis: (sessionUuid: string) => string | undefined;
  hook: (envelope: HookEnvelope) => Promise<Record<string, unknown>>;
  record: (events: readonly TachoEvent[]) => void;
  model: ModelProxy;
  modelPort: () => number;
  issueCredential: (harness: string) => IssueRunTokenAnswer;
  /** The daemon's Git custody proxy (ADR-151), shared with wrapped runs. */
  github: Pick<
    ReturnType<typeof createGithubProxy>,
    "issueForSession" | "handle" | "release"
  >;
  fetch: FetchLike;
  log: (line: string) => void;
}

export function createContainedRunner(options: ContainedRunnerOptions) {
  /** Harness session ids this launcher started and has not yet finished. */
  const launched = new Set<string>();
  /** The repository each launched session named, while it runs. */
  const repositories = new Map<string, string>();
  const active = new Map<string, AbortController>();
  return {
    launched: (harnessSessionId: string) => launched.has(harnessSessionId),
    githubRepository: (harnessSessionId: string) =>
      repositories.get(harnessSessionId),
    stop: (uuid: string) => active.get(uuid)?.abort(),
    stopAll: () => {
      for (const controller of active.values()) controller.abort();
    },
    run: async (
      raw: unknown,
      output: (stream: "stdout" | "stderr", text: string) => void,
      signal?: AbortSignal,
    ): Promise<ContainedRunResult> => {
      const input = containedRunRequestSchema.parse(raw);
      const host = options.host();
      if (
        host.host_status !== "active" ||
        host.revoked_at !== null ||
        Date.parse(host.expires_at) <= Date.now()
      )
        throw new Error("This enrollment cannot start a contained run");
      if (!host.gateway_api_key)
        throw new Error(
          "Re-enroll this runner to obtain a daemon gateway credential",
        );
      const credential = options.issueCredential(input.harness);
      if (credential.status !== 200)
        throw new Error(
          "The daemon must hold this harness's model credential before containment can start",
        );
      const repository = input.github?.repository;
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      let sessionUuid: string | undefined;
      let launchedSessionId: string | undefined;
      let env: Record<string, string> | undefined;
      // Whether the start hook recorded the session, and whether an end was
      // sent for it. A launch that fails between the two still ends it.
      let opened = false;
      let ended = false;
      const session = (id: string) => {
        const found = options.registry.get(id);
        if (!found) throw new Error("Contained session was not recorded");
        return found;
      };
      try {
        return await launchContainedAgent({
          image: input.image,
          request: input,
          output,
          signal: controller.signal,
          prepare: async ({ sessionId, directory, workspace }) => {
            // Before the start hook: a mandate that requires containment
            // refuses any session the launcher did not start, this one
            // included, until it is on this list.
            launched.add(sessionId);
            launchedSessionId = sessionId;
            if (repository !== undefined)
              repositories.set(sessionId, repository);
            env = containedHookEnv(input.harness, workspace);
            // The bridge hands this answer to the harness's own first
            // start, so the context this start seals is what the harness
            // reads.
            const opening = await options.hook({
              harness: input.harness,
              env,
              payload: {
                hook_event_name: "SessionStart",
                session_id: sessionId,
                cwd: workspace,
                source: "startup",
              },
            });
            const started = session(sessionId);
            opened = true;
            sessionUuid = started.recorder.sessionUuid;
            active.set(sessionUuid, controller);
            const gateway = createMcpGateway({
              attribution: () => {
                const current = options.host();
                if (
                  current.host_status !== "active" ||
                  !current.gateway_api_key
                )
                  return undefined;
                return {
                  organizationId: current.organization_id,
                  workspaceId: current.workspace_id,
                  orgSlug: current.org_slug,
                  workspaceSlug: current.workspace_slug,
                  apiKey: current.gateway_api_key,
                  hostEnrollmentId: current.host_enrollment_id,
                  chainSessionUuid: started.recorder.sessionUuid,
                  chainGenesisHash: options.genesis(
                    started.recorder.sessionUuid,
                  ),
                };
              },
              endpoint: mcpEndpointFor(options.host()),
              fetch: options.fetch,
              bundle: () => options.host().bundle,
              log: options.log,
              record: (call) =>
                options.record([
                  started.recorder.sealCollectorEvent("tool_call", {
                    tool_name: call.toolName,
                    tool_source: "mcp",
                    tool_status: call.status,
                    tool_duration_ms: call.durationMs,
                  }),
                ]),
            });
            const bridge = await startContainedBridge({
              socketPath: join(directory, "bridge.sock"),
              sessionId,
              workspace,
              harness: input.harness,
              modelPort: options.modelPort(),
              issueCredential: () => {
                const answer = options.issueCredential(input.harness);
                if (answer.status !== 200)
                  throw new Error("Credential custody unavailable");
                return answer.body.token;
              },
              model: (request, response) =>
                options.model.handle(request, response),
              hook: options.hook,
              opening,
              env,
              mcp: (body) =>
                gateway.handle(body, {
                  sessionId,
                  enrollmentId: options.host().host_enrollment_id,
                }),
              // The lease is keyed by this launcher's own session, never by
              // a working directory or a port, neither of which the
              // container shares with the host (ADR-254).
              ...(repository !== undefined
                ? {
                    github: {
                      repository,
                      lease: () =>
                        options.github.issueForSession({
                          session: started.recorder.sessionUuid,
                          repository,
                        }),
                      handle: options.github.handle,
                      release: options.github.release,
                    },
                  }
                : {}),
              githubRefused: (path) =>
                options.record([
                  started.recorder.sealCollectorEvent("policy_decision", {
                    policy_decision: "deny",
                    policy_source: "kernel",
                    policy_reason_code: "contained_github_custody",
                    tool_name: path.split("?")[0]?.slice(0, 256) ?? "unknown",
                  }),
                ]),
              refused: (path) =>
                options.record([
                  started.recorder.sealCollectorEvent("policy_decision", {
                    policy_decision: "deny",
                    policy_source: "bundle",
                    policy_reason_code: "contained_gateway_route",
                    tool_name: path.split("?")[0]?.slice(0, 256) ?? "unknown",
                  }),
                ]),
            });
            return {
              files: containedConfiguration(input.harness, repository),
              close: bridge.close,
            };
          },
          measured: async (sessionId, measurement) => {
            const started = session(sessionId);
            const genesis = options.genesis(started.recorder.sessionUuid);
            if (!genesis)
              throw new Error("Contained session has no recorded genesis");
            const current = options.host();
            const response = await options.fetch(
              containedLaunchEndpoint(current),
              {
                method: "POST",
                headers: {
                  authorization: `Bearer ${current.gateway_api_key}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify({
                  host_enrollment_id: current.host_enrollment_id,
                  session_uuid: started.recorder.sessionUuid,
                  genesis_hash: genesis,
                  measurement,
                }),
                signal: AbortSignal.timeout(30_000),
              },
            );
            if (!response.ok)
              throw new Error(
                `Contained launch registration failed (${response.status}); the agent was not started`,
              );
            options.record([
              started.recorder.sealCollectorEvent(
                "policy_decision",
                {
                  policy_decision: "allow",
                  policy_source: "kernel",
                  policy_reason_code: "contained_launch_registered",
                },
                {
                  attrs: {
                    "oxagen.containment.profile": measurement.profile,
                    "oxagen.containment.image": measurement.imageDigest,
                    "oxagen.containment.configuration":
                      measurement.configurationDigest,
                  },
                },
              ),
            ]);
          },
          sealed: async (sessionId, exitCode) => {
            ended = true;
            await options.hook({
              harness: input.harness,
              env,
              payload: {
                hook_event_name: "SessionEnd",
                session_id: sessionId,
                cwd: input.workspace,
                reason: "other",
                exit_code: exitCode,
              },
            });
          },
        });
      } finally {
        signal?.removeEventListener("abort", abort);
        // Sent before the launched mark is cleared, as `sealed` is. Left
        // open, the session would be swept as crashed. A failure here is
        // logged, so the caller still sees why the launch failed.
        if (opened && !ended && launchedSessionId !== undefined) {
          try {
            await options.hook({
              harness: input.harness,
              env,
              payload: {
                hook_event_name: "SessionEnd",
                session_id: launchedSessionId,
                cwd: input.workspace,
                reason: LAUNCH_FAILED_REASON,
              },
            });
          } catch (error) {
            options.log(
              `contained: session ${launchedSessionId} stays open after its launch failed, because ending it failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        if (sessionUuid) active.delete(sessionUuid);
        if (launchedSessionId) {
          launched.delete(launchedSessionId);
          repositories.delete(launchedSessionId);
        }
      }
    },
  };
}
