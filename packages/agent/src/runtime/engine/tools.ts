/**
 * The tool half of the engine port: the materialised `ToolSet` becomes the
 * contracts the engine advertises to the model and gates its dispatch on, and
 * a `tool_request` frame becomes a call into that same `ToolSet`.
 *
 * Two properties this module holds:
 *
 * The model sees schemas; only the host executes. `schemaOnlyTools` strips
 * `execute` before the tool set reaches the host's own model adapter. Without
 * that the AI SDK would run a tool the moment the model asked for it, and the
 * engine, which asks for it too over `tool_request`, would run it a second
 * time. One governed action becoming two is a duplicated side effect nothing
 * downstream would report.
 *
 * Every gate is inside `execute`. IAM, entitlement, tool RBAC, consent, the
 * approval pause, and the audit row all live in the closures
 * `materializeTools` built, so answering the engine through them applies
 * every enforcement point unchanged. The engine is the loop; the kernel
 * remains the law.
 */
import { asSchema, type ToolSet } from "ai";
import type {
  ToolContractWire,
  ToolOutput,
} from "@oxagen/stella-engine-client";
import type { ToolGovernance } from "../materialize-tools";

/**
 * Raised when the engine asks for a tool the host does not hold. That is a
 * contract break between what was advertised and what is held, not an
 * ordinary tool failure, so it is thrown for the loop to classify rather
 * than rendered as text for the model.
 */
export class UnknownToolError extends Error {
  override readonly name = "UnknownToolError";
  constructor(readonly toolName: string) {
    super(
      `the engine requested a tool this turn did not advertise: ${toolName}`,
    );
  }
}

/**
 * Advertise the tool set to the engine as full contracts.
 *
 * `asSchema` is the AI SDK's own normaliser, so a tool declared with a zod
 * schema and one declared with raw JSON Schema both arrive as the JSON Schema
 * the providers would have been given. It may return a promise, which is why
 * this is async.
 *
 * The contract's governance half comes from `materializeTools`: the risk
 * level and approval flag the capability declared, and whether it only
 * reads. A tool with no governance entry is declared the way the engine
 * treats an undeclared one, high risk and mutating, so a gap here fails
 * closed rather than open.
 */
export async function toToolContracts(
  tools: ToolSet,
  governance: Record<string, ToolGovernance>,
): Promise<ToolContractWire[]> {
  const contracts: ToolContractWire[] = [];
  for (const [name, tool] of Object.entries(tools)) {
    const jsonSchema = await inputJsonSchema(tool.inputSchema);
    const facts = governance[name] ?? {
      riskLevel: "high",
      requiresApproval: false,
      readOnly: false,
    };
    contracts.push({
      version: 1,
      schema: {
        name,
        // The SDK also allows a description built from the call's context.
        // The engine advertises tools once, before the turn opens, so there
        // is no context to build one from.
        description:
          typeof tool.description === "string" ? tool.description : "",
        input_schema: jsonSchema ?? { type: "object" },
        read_only: facts.readOnly,
      },
      risk: facts.riskLevel,
      requires_approval: facts.requiresApproval,
      provenance: "declared",
    });
  }
  return contracts;
}

/**
 * A tool's input as JSON Schema. `asSchema` normalises a zod schema or a
 * `jsonSchema()` wrapper; a plain JSON Schema object, which a test or a raw
 * contract may hand in, is already the answer.
 */
async function inputJsonSchema(schema: unknown): Promise<unknown> {
  if (
    typeof schema === "object" &&
    schema !== null &&
    "type" in schema &&
    !("jsonSchema" in schema) &&
    !("_def" in schema) &&
    !("parse" in schema)
  ) {
    return schema;
  }
  return (
    (await asSchema(schema as Parameters<typeof asSchema>[0]).jsonSchema) ?? {
      type: "object",
    }
  );
}

/** The same tool set as the host's model adapter must see it: schemas only. */
export function schemaOnlyTools(tools: ToolSet): ToolSet {
  const stripped: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    const { execute: _execute, ...schemaOnly } = tool as typeof tool & {
      execute?: unknown;
    };
    stripped[name] = schemaOnly as ToolSet[string];
  }
  return stripped;
}

/** What one tool call produced, both as the engine sees it and as the host had it. */
export interface ToolExecution {
  output: ToolOutput;
  /** The value `execute` returned, kept for the surface's own rendering. */
  raw: unknown;
  /** True when `execute` threw. */
  failed: boolean;
  /** The thrown value, when it failed. */
  error?: unknown;
}

/**
 * Answer one `tool_request` by running the host's real tool.
 *
 * A thrown tool becomes the `error` arm rather than a rejection, because tool
 * failure is ordinary and the engine's job is to hand it to the model as text
 * it can react to. A refusal by a gate carries the class the engine reads as
 * a refusal, so a policy "no" is not mistaken for a fault.
 */
export async function executeToolRequest(
  tools: ToolSet,
  name: string,
  input: unknown,
  context: { toolCallId: string; signal?: AbortSignal },
): Promise<ToolExecution> {
  const tool = tools[name];
  if (!tool) throw new UnknownToolError(name);
  // `execute` is generic over a per-tool context this module cannot name; the
  // fields below are the ones `ToolExecutionOptions` guarantees for every tool.
  const execute = tool.execute as
    | ((input: unknown, options: unknown) => unknown)
    | undefined;
  if (typeof execute !== "function") throw new UnknownToolError(name);

  try {
    const raw = await execute(input, {
      toolCallId: context.toolCallId,
      messages: [],
      abortSignal: context.signal,
    });
    return {
      output: { ok: { content: renderToolResult(raw) } },
      raw,
      failed: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const refused =
      /approval (denied|expired)|blocked by|consent (denied|expired)|refused/i.test(
        message,
      );
    return {
      output: {
        error: refused ? { message, class: "refused_by_policy" } : { message },
      },
      raw: undefined,
      failed: true,
      error,
    };
  }
}

/**
 * Render a tool's return value as the text the engine carries. A string
 * passes through untouched; JSON-quoting it would show the model escape
 * sequences instead of the answer.
 */
export function renderToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === undefined) return "";
  try {
    return JSON.stringify(result) ?? String(result);
  } catch {
    return String(result);
  }
}
