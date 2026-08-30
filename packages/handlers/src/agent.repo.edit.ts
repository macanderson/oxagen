import type { CapabilityHandler } from "@oxagen/oxagen";
import { agentRepoEdit } from "@oxagen/oxagen/contracts/agent.repo.edit";
import { createGitHubClient, GitHubWorkspace } from "@oxagen/github";
import { isSandboxAvailable } from "@oxagen/sandbox";
import { executePipelineTurn } from "@oxagen/agent-runner";
import type { MarketRoutingPolicy, RoutingStatRow } from "@oxagen/agent-engine";
import { readRoutingStats, recordRouterOutcome } from "@oxagen/telemetry";
import { runInTenantScope } from "@oxagen/tenancy";
import {
  createClickHouseTraceStore,
  createFileLeaseLockAdapter,
  createPlatformAgentAi,
  ModalSandboxWorkspace,
} from "@oxagen/agent/adapters";
import { resolveGitHubToken } from "./lib/github-token";
import { loadEffectiveRoutingPolicy } from "./lib/routing-policy";
import {
  diffFileContents,
  splitCombinedDiff,
  type FileDiff,
} from "./lib/unified-diff";
import { logger } from "./logger";

export const agentRepoEditHandler: CapabilityHandler<
  typeof agentRepoEdit
> = async (input, ctx) => {
  // 1. Resolve the GitHub token for this workspace.
  const token = await resolveGitHubToken(ctx);
  const gh = createGitHubClient({ token });

  // 2. Determine the base branch.
  //    The GitHubClient interface does not expose a getDefaultBranch method;
  //    use the caller-supplied value or fall back to "main".
  const baseBranch = input.baseBranch ?? "main";

  // 3. Build the workspace the coding loop reads and edits.
  //    Preferred: a durable Modal sandbox with the repo cloned, so the agent
  //    can actually run builds/tests/git and inject environment secrets. When no
  //    sandbox driver is configured we fall back to the GitHub-API workspace,
  //    which edits files but CANNOT execute shell commands — surfaced as a
  //    capability warning rather than a silent stream of exec exit-code-1s.
  const useSandbox = isSandboxAvailable();
  const sandboxWs = useSandbox
    ? new ModalSandboxWorkspace({
        ctx,
        // Per-run isolated session: each repo.edit call gets its own clone so
        // concurrent runs on the same repo never share/clobber a checkout.
        sessionKey: `repo-edit:${ctx.workspaceId}:${input.owner}/${input.repo}:${ctx.requestId}`,
        environmentId: input.environmentId,
        repo: { owner: input.owner, repo: input.repo, ref: baseBranch, token },
      })
    : null;
  const githubWs = new GitHubWorkspace(gh, {
    owner: input.owner,
    repo: input.repo,
    ref: baseBranch,
  });
  const ws = sandboxWs ?? githubWs;

  // 4. Create the metered, telemetry-instrumented AI port.
  //    messageId is the ClickHouse execution_step_id correlation key.
  const ai = createPlatformAgentAi(ctx, ctx.messageId ?? ctx.requestId);

  // 4b. Verified-Outcome Market Router (flag-gated). Resolve the governed policy
  //     and, only when the router will actually consult them, a stats snapshot.
  //     Off by default ⇒ mode "off" ⇒ the engine keeps today's deterministic
  //     routing. Any failure here MUST NOT block a turn — fall back to no policy.
  let routingPolicy: MarketRoutingPolicy | undefined;
  let routingStats: RoutingStatRow[] | undefined;
  try {
    const resolved = await loadEffectiveRoutingPolicy(ctx);
    routingPolicy = resolved.policy;
    if (resolved.policy.mode !== "off") {
      routingStats = await readRoutingStats({
        windowDays: resolved.policy.windowDays,
        minSamples: resolved.policy.minSamples,
      });
    }
  } catch (err) {
    logger.warn(
      { err, orgId: ctx.orgId },
      "routing policy/stats fetch failed — falling back to deterministic routing",
    );
  }
  const orgId = ctx.orgId;
  const workspaceId = ctx.workspaceId;
  const executionId = ctx.messageId ?? ctx.requestId;

  // 5. Run the full 6-stage pipeline (evaluate → enhance → route → execute →
  //    judge → revise) via runTurn from @oxagen/agent-engine.
  //    The pipeline matches the quality level of the CLI: prompt evaluation,
  //    model routing, completeness judging, and
  //    auto-revision. The platform deliberately does not inject a centralized
  //    code graph: checkout-specific code context stays local to the active
  //    workspace. The AgentAi port is backed by @oxagen/ai (metered) instead of
  //    a BYOK gateway key.
  // The kernel wraps this handler in runInTenantScope so Neo4j / embed calls
  // inside the adapters inherit the active tenant scope via AsyncLocalStorage.
  const result = await executePipelineTurn("repo-edit", {
    prompt: input.instruction,
    workspace: ws,
    ai,
    model: input.model,
    maxSteps: input.maxSteps,
    readOnly: false,
    trace: createClickHouseTraceStore({
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      surface: "agent",
    }),
    // Agent file locking (ADR-021 §5): this is the real fleet path —
    // agent.repo.edit is dispatched both directly and as a subagent-fanout
    // child (agent.execute-subagent invoking a capability by name), so two
    // agents racing to edit the same file in the same repo now genuinely
    // serialize via the transactional Postgres lease (with fencing tokens)
    // instead of silently clobbering each other's writes.
    fileLock: createFileLeaseLockAdapter({
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      owner: input.owner,
      repo: input.repo,
    }),
    // Surface non-fatal engine failures that reach the injected sink.
    onError: ({ phase, error }) =>
      logger.error(
        { err: error, phase, orgId: ctx.orgId },
        "agent-engine non-fatal error",
      ),
    // Market-router policy + pre-fetched stats (flag-gated; undefined ⇒ off).
    routingPolicy,
    routingStats,
    // Record each round's outcome so the router learns this task class's live
    // cost/accuracy curve. Fire-and-forget: re-enter the tenant scope explicitly
    // (the engine defers the hook, and chInsert needs an active scope), and
    // never let a telemetry failure surface into the turn.
    onRouteOutcome: (outcome) => {
      void runInTenantScope({ orgId, workspaceId }, () =>
        recordRouterOutcome({
          execution_id: executionId,
          task_class: outcome.taskClass,
          signature_hash: outcome.signatureHash,
          model: outcome.model,
          tier: outcome.tier,
          verified: outcome.verified ? 1 : 0,
          verification_source: outcome.verificationSource,
          score: outcome.score,
          cost_usd_micros: outcome.costUsdMicros,
          latency_ms: outcome.latencyMs,
          surface: "agent",
          routing_mode: outcome.routingMode,
        }),
      ).catch(() => {});
    },
  });

  // 6. Collect the changed files. The sandbox reads them back from the real git
  //    working tree; the GitHub-API workspace returns its in-memory staged set.
  //    The finally below tears the sandbox session down for everything from
  //    here on. NOTE: it does NOT cover step 5 — a throw out of
  //    executePipelineTurn leaves the Modal session alive until Modal's own
  //    idle timeout reclaims it.
  try {
    const changed = sandboxWs
      ? await sandboxWs.getChangedFiles()
      : githubWs.changedFiles();

    // 7. Reject runs where the agent produced no file changes.
    if (changed.length === 0) {
      throw new Error("Agent made no changes.");
    }

    // 7b. Compute a per-file unified-diff patch for each changed file, so the
    //     chat's code-diff card can render real hunks instead of a path-only
    //     row. This is a non-critical enrichment — never let it fail the run.
    //     Sandbox backend: read the real `git diff --cached` from the working
    //     tree (git already understands renames/adds/deletes). GitHub-API
    //     backend has no git — reconstruct per file from its content on the
    //     base branch (undefined/null → "" for a newly created file) vs. the
    //     agent's final content.
    let diffs: FileDiff[] | undefined;
    try {
      if (sandboxWs) {
        const rawDiff = await sandboxWs.diff();
        const byPath = new Map(
          splitCombinedDiff(rawDiff).map((d) => [d.path, d]),
        );
        diffs = changed
          .map((f) => byPath.get(f.path))
          .filter((d): d is FileDiff => d !== undefined);
      } else {
        diffs = await Promise.all(
          changed.map(async (f) => {
            const before = await gh.getFileContent({
              owner: input.owner,
              repo: input.repo,
              path: f.path,
              ref: baseBranch,
            });
            return diffFileContents(f.path, before ?? "", f.content);
          }),
        );
      }
    } catch (err) {
      logger.error(
        { err, orgId: ctx.orgId, owner: input.owner, repo: input.repo },
        "agent.repo.edit: failed to compute diff patches (non-fatal, falling back to path-only)",
      );
      diffs = undefined;
    }

    // 8. Derive the branch name (provided or auto-generated from the request id).
    const branch =
      input.branchName ?? `oxagen-agent-${ctx.requestId.slice(0, 8)}`;

    // 9. Create the branch on GitHub.
    await gh.createBranch({
      owner: input.owner,
      repo: input.repo,
      branch,
      fromBranch: baseBranch,
    });

    // 10. Commit every changed file to the branch (via the Contents API — the
    //     sandbox produced the content, GitHub is the durable record).
    for (const file of changed) {
      await gh.putFile({
        owner: input.owner,
        repo: input.repo,
        path: file.path,
        content: file.content,
        message: `agent: ${input.instruction.slice(0, 72)}`,
        branch,
      });
    }

    // 11. Open a pull request.
    const pr = await gh.openPullRequest({
      owner: input.owner,
      repo: input.repo,
      title: input.instruction.slice(0, 72),
      head: branch,
      base: baseBranch,
      body: result.text.slice(0, 2000),
    });

    return {
      prNumber: pr.number,
      prUrl: pr.htmlUrl,
      branch,
      changedFiles: changed.map((f) => f.path),
      summary: result.text,
      execBackend: sandboxWs ? ("sandbox" as const) : ("github-api" as const),
      ...(diffs && diffs.length > 0 ? { diffs } : {}),
      ...(sandboxWs
        ? {}
        : {
            warnings: [
              "Shell execution was unavailable (no sandbox driver configured), so " +
                "the agent could not run builds, tests, or git — it edited files " +
                "through the GitHub API only. Set SANDBOX_ENABLED=true with a Modal " +
                "driver to enable real execution.",
            ],
          }),
    };
  } finally {
    if (sandboxWs) await sandboxWs.dispose();
  }
};
