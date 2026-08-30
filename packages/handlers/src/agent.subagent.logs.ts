import type { CapabilityHandler } from "@oxagen/oxagen";
import { agentSubagentLogs } from "@oxagen/oxagen/contracts/agent.subagent.logs";
import type { AgentSubagentAggregateOutput } from "@oxagen/oxagen/contracts/agent.subagent.aggregate";
import { invoke } from "@oxagen/oxagen/kernel";
import { persistGeneratedAsset } from "./generated-asset.persist";
import { slugify } from "./lib/asset-filename";
import { logger } from "./logger";

type Child = AgentSubagentAggregateOutput["children"][number];
type TimelineEntry = AgentSubagentAggregateOutput["timeline"][number];

function durationMs(entry: TimelineEntry | undefined): number | null {
  if (!entry?.startedAt || !entry?.completedAt) return null;
  const start = Date.parse(entry.startedAt);
  const end = Date.parse(entry.completedAt);
  return Number.isNaN(start) || Number.isNaN(end) ? null : end - start;
}

function fence(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(value, null, 2);
  } catch {
    json = String(value);
  }
  return "```json\n" + json + "\n```";
}

/**
 * Render a fan-out's children into a markdown log — traceable down to each
 * subagent's full input (e.g. the search query) and output (e.g. every result).
 * Pure + exported so it's unit-testable without storage.
 */
export function buildLogMarkdown(args: {
  title: string;
  fanoutId: string;
  status: string;
  children: readonly Child[];
  timeline: readonly TimelineEntry[];
}): string {
  const { title, fanoutId, status, children, timeline } = args;
  const byRun = new Map(timeline.map((t) => [t.runId, t]));
  const lines: string[] = [
    `# ${title}`,
    ``,
    `- **Fan-out:** \`${fanoutId}\``,
    `- **Status:** ${status}`,
    `- **Subagents:** ${children.length}`,
    ``,
    `---`,
    ``,
  ];

  children.forEach((child, i) => {
    const tl = byRun.get(child.runId);
    const dur = durationMs(tl);
    lines.push(`## ${i + 1}. ${child.capabilityName} — ${child.status}`);
    lines.push(``);
    lines.push(`- **Run:** \`${child.runId}\``);
    if (dur !== null) lines.push(`- **Duration:** ${dur}ms`);
    if (child.errorReason) lines.push(`- **Error:** ${child.errorReason}`);
    lines.push(``);

    // Input — surface the query inline when this was a web.search.
    const input = child.input;
    const query =
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>).query
        : undefined;
    if (typeof query === "string") {
      lines.push(`**Query:** ${query}`);
      lines.push(``);
    } else {
      lines.push(`**Input:**`);
      lines.push(fence(input));
      lines.push(``);
    }

    // Output — list web-search hits explicitly; otherwise fence the JSON.
    const output = child.output;
    const results =
      output && typeof output === "object" && !Array.isArray(output)
        ? (output as Record<string, unknown>).results
        : undefined;
    if (Array.isArray(results)) {
      lines.push(`**Results (${results.length}):**`);
      lines.push(``);
      for (const r of results) {
        if (typeof r !== "object" || r === null) continue;
        const rr = r as Record<string, unknown>;
        const t = typeof rr.title === "string" ? rr.title : "(untitled)";
        const u = typeof rr.url === "string" ? rr.url : "";
        const c = typeof rr.content === "string" ? rr.content : "";
        lines.push(`- [${t}](${u})`);
        if (c) lines.push(`  > ${c.slice(0, 400)}`);
      }
      lines.push(``);
    } else if (output !== undefined && output !== null) {
      lines.push(`**Output:**`);
      lines.push(fence(output));
      lines.push(``);
    }
    lines.push(`---`);
    lines.push(``);
  });

  return lines.join("\n");
}

export const agentSubagentLogsHandler: CapabilityHandler<
  typeof agentSubagentLogs
> = async (input, ctx) => {
  if (!ctx.userId) {
    throw new Error(
      "agent.subagent.logs: userId is required — no user identity in context",
    );
  }
  const userId = ctx.userId;

  const aggregate = (await invoke(
    "aggregate_subagents",
    // Full payloads on purpose: the logfile is a downloadable artifact built
    // server-side, not an LLM tool result (docs/specs/graph-mediated-fanout).
    { fanoutId: input.fanoutId, includeOutputs: true },
    ctx,
  )) as AgentSubagentAggregateOutput;

  const title = input.title ?? `Subagent log — ${input.fanoutId}`;
  const markdown = buildLogMarkdown({
    title,
    fanoutId: input.fanoutId,
    status: aggregate.status,
    children: aggregate.children,
    timeline: aggregate.timeline,
  });

  const bytes = new TextEncoder().encode(markdown);
  const asset = await persistGeneratedAsset({
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    userId,
    kind: "document",
    mimeType: "text/markdown",
    bytes,
    prompt: `Subagent logs for fan-out ${input.fanoutId}`,
    model: "local",
    messageId: ctx.messageId ?? undefined,
    accessPolicy: "org",
  });

  const filename = `${slugify(title).slice(0, 60) || "subagent-log"}.md`;

  logger.info(
    {
      fanoutId: input.fanoutId,
      childCount: aggregate.children.length,
      publicId: asset.publicId,
    },
    "agent.subagent.logs: complete",
  );

  return {
    assetId: asset.id,
    publicId: asset.publicId,
    childCount: aggregate.children.length,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    url: asset.url,
    serveUrl: asset.serveUrl,
    render: {
      componentId: "file-attachment" as const,
      props: {
        url: asset.serveUrl,
        name: filename,
        kind: "document" as const,
        mimeType: asset.mimeType,
        sizeBytes: asset.sizeBytes,
      },
    },
  };
};
