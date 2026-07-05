import type { CapabilityContext } from "../types";
import { getExecutionLineage } from "../memory/neo4j";
import type {
  AgentExecutionLineageInput,
  AgentExecutionLineageOutput,
} from "@oxagen/oxagen/contracts/agent.execution.lineage";

export type { AgentExecutionLineageInput, AgentExecutionLineageOutput };

type ExecutionNodeRef = NonNullable<AgentExecutionLineageOutput["execution"]>;

// Safe-parse the node's JSON-string properties bag. Malformed/empty JSON must
// never throw — it degrades to an empty bag so a corrupt or pre-migration node
// still resolves to a citable (if sparse) KnowledgeNodeRef.
function safeParseProperties(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function dropNullish(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined));
}

/**
 * agent.execution.lineage — resolve one `:Execution` node plus every
 * `:SourceFile` it touched via `[:TOUCHED_FILE]` to the shared KnowledgeNodeRef
 * shape, so the UI can cite both by human label with an inspectable property
 * bag (CLAUDE.md "Citing nodes & edges") instead of a bare UUID.
 */
export async function agentExecutionLineageHandler(
  input: AgentExecutionLineageInput,
  _ctx: CapabilityContext,
): Promise<AgentExecutionLineageOutput> {
  const { execution: execRow, files: fileRows } = await getExecutionLineage(input.executionId);

  if (!execRow) {
    return { found: false, execution: null, files: [] };
  }

  const properties = dropNullish({
    ...safeParseProperties(execRow.properties),
    status: execRow.status,
    originType: execRow.originType,
    summary: execRow.summary,
  });

  const execution: ExecutionNodeRef = {
    id: execRow.publicId ?? execRow.id,
    label: execRow.label ?? "Execution",
    displayName:
      execRow.displayName ?? (execRow.originType ? `${execRow.originType} execution` : execRow.id),
    properties,
  };

  const files = fileRows.map((f) => ({
    node: {
      id: f.publicId ?? f.naturalKey,
      label: "SourceFile",
      displayName: f.displayName ?? f.path ?? f.naturalKey,
      properties: dropNullish({ path: f.path, naturalKey: f.naturalKey }),
    },
    edgeType: f.edgeType,
  }));

  return { found: true, execution, files };
}
