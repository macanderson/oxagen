import type { CapabilityHandler } from "@oxagen/oxagen";
import { agentRepoEdit } from "@oxagen/oxagen/contracts/agent.repo.edit";
import { createGitHubClient, GitHubWorkspace } from "@oxagen/github";
import { runCodingAgent } from "@oxagen/agent-engine";
import {
  createNeo4jCodeGraphProvider,
  createPlatformMemoryProvider,
  createClickHouseTraceStore,
} from "@oxagen/agent/adapters";
import { resolveGitHubToken } from "./lib/github-token";
import { createPlatformAgentAi } from "./lib/platform-agent-ai";

export const agentRepoEditHandler: CapabilityHandler<typeof agentRepoEdit> = async (
  input,
  ctx,
) => {
  // 1. Resolve the GitHub token for this workspace.
  const token = await resolveGitHubToken(ctx);
  const gh = createGitHubClient({ token });

  // 2. Determine the base branch.
  //    The GitHubClient interface does not expose a getDefaultBranch method;
  //    use the caller-supplied value or fall back to "main".
  const baseBranch = input.baseBranch ?? "main";

  // 3. Build a GitHub-API-backed workspace so the agent can read and write
  //    files without a local clone.
  const ws = new GitHubWorkspace(gh, {
    owner: input.owner,
    repo: input.repo,
    ref: baseBranch,
  });

  // 4. Create the metered, telemetry-instrumented AI port.
  //    messageId is the ClickHouse execution_step_id correlation key.
  const ai = createPlatformAgentAi(ctx, ctx.messageId ?? ctx.requestId);

  // 5. Run the coding agent loop.
  // The kernel wraps this handler in runInTenantScope so Neo4j / embed calls
  // inside the adapters inherit the active tenant scope via AsyncLocalStorage.
  const result = await runCodingAgent({
    workspace: ws,
    ai,
    instruction: input.instruction,
    model: input.model,
    maxSteps: input.maxSteps,
    readOnly: false,
    codeGraph: createNeo4jCodeGraphProvider(),
    memory: createPlatformMemoryProvider({
      recallQuery: input.instruction,
      telemetry: {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        surface: "agent",
        messageId: ctx.messageId ?? ctx.requestId,
      },
    }),
    trace: createClickHouseTraceStore({
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      surface: "agent",
    }),
  });

  // 6. Reject runs where the agent produced no file changes.
  const changed = ws.changedFiles();
  if (changed.length === 0) {
    throw new Error("Agent made no changes.");
  }

  // 7. Derive the branch name (provided or auto-generated from the request id).
  const branch = input.branchName ?? `oxagen-agent-${ctx.requestId.slice(0, 8)}`;

  // 8. Create the branch on GitHub.
  await gh.createBranch({
    owner: input.owner,
    repo: input.repo,
    branch,
    fromBranch: baseBranch,
  });

  // 9. Commit every changed file to the branch.
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

  // 10. Open a pull request.
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
  };
};
