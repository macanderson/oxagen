import { Command } from "commander";
import { requireAuth, ApiError } from "../lib/api-client.js";
import { getToken, getApiUrl, readConfig } from "../lib/config.js";

interface StreamEvent {
  type: string;
  text?: string;
  toolCallId?: string;
  capability?: string;
  inputPreview?: unknown;
  status?: string;
  output?: unknown;
  errorReason?: string;
  durationMs?: number;
  riskLevel?: string;
  approvalId?: string;
  expiresAt?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  message?: string;
}

export const chatSendCommand = new Command("send")
  .description("Send a message to the agent and stream the response")
  .argument("<message>", "Message to send")
  .option("-c, --conversation <id>", "Conversation ID (resumes existing thread)")
  .option("--org <slug>", "Organization slug (overrides saved config)")
  .option("--workspace <slug>", "Workspace slug (overrides saved config)")
  .option(
    "--mcp-servers <ids>",
    "Comma-separated public IDs of MCP servers to activate for this turn",
  )
  .option("--model <id>", "AI Gateway model ID (e.g. anthropic/claude-sonnet-4-6)")
  .option(
    "--tier <tier>",
    "Model tier: fast | balanced | precise (default: workspace setting)",
  )
  .option("--json", "Print raw SSE event JSON instead of rendered text")
  .action(
    async (
      message: string,
      options: {
        conversation?: string;
        org?: string;
        workspace?: string;
        mcpServers?: string;
        model?: string;
        tier?: string;
        json?: boolean;
      },
    ) => {
      requireAuth();

      const config = readConfig();
      const org = options.org ?? config.orgSlug;
      const workspace = options.workspace ?? config.workspaceSlug;

      if (!org || !workspace) {
        console.error(
          "Error: --org and --workspace are required (or save defaults with `oxagen auth login`).",
        );
        process.exit(1);
      }

      const activeServerIds = options.mcpServers
        ? options.mcpServers.split(",").map((s) => s.trim()).filter(Boolean)
        : [];

      const body: Record<string, unknown> = {
        content: message,
        conversationId: options.conversation ?? null,
        activeServerIds,
      };
      if (options.model) body["model"] = options.model;
      if (options.tier) body["tier"] = options.tier;

      const token = getToken();
      const base = getApiUrl();
      const url = `${base}/v1/${org}/${workspace}/chat/stream`;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      };
      if (token) headers["Authorization"] = `Bearer ${token}`;

      let res: Response;
      try {
        res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }

      if (!res.ok) {
        let errMsg = `HTTP ${res.status}`;
        try {
          const parsed = (await res.json()) as { error?: string; message?: string };
          errMsg = parsed.error ?? parsed.message ?? errMsg;
        } catch {
          // ignore
        }
        throw new ApiError(res.status, errMsg);
      }

      if (!res.body) {
        console.error("Error: empty response body");
        process.exit(1);
      }

      // Parse the SSE stream line-by-line and render to stdout.
      const reader = res.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
      const decoder = new TextDecoder();
      let buffer = "";
      let hasOutput = false;

      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });

          // Split on double-newline SSE message boundaries.
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";

          for (const part of parts) {
            const lines = part.split("\n");
            for (const line of lines) {
              if (line.startsWith("event:") && line.includes("done")) break;
              if (!line.startsWith("data:")) continue;
              const data = line.slice("data:".length).trim();
              if (data === "[DONE]") break;

              let event: StreamEvent;
              try {
                event = JSON.parse(data) as StreamEvent;
              } catch {
                continue;
              }

              if (options.json) {
                console.log(JSON.stringify(event));
                continue;
              }

              switch (event.type) {
                case "text":
                  process.stdout.write(event.text ?? "");
                  hasOutput = true;
                  break;
                case "tool-call-start":
                  process.stderr.write(
                    `\n[tool: ${event.capability ?? "unknown"}]\n`,
                  );
                  break;
                case "tool-call-end":
                  if (event.status === "failed") {
                    process.stderr.write(
                      `[tool failed: ${event.errorReason ?? "unknown error"}]\n`,
                    );
                  }
                  break;
                case "approval-required":
                  process.stderr.write(
                    `\n[approval required for ${event.capability} — visit the web app to approve]\n`,
                  );
                  break;
                case "usage":
                  if (event.usage) {
                    process.stderr.write(
                      `\n[tokens: ${event.usage.totalTokens} total (${event.usage.promptTokens} in / ${event.usage.completionTokens} out)]\n`,
                    );
                  }
                  break;
                case "error":
                  process.stderr.write(`\n[error: ${event.message ?? "unknown"}]\n`);
                  break;
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      if (hasOutput) process.stdout.write("\n");
    },
  );
