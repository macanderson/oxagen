/**
 * The tool half of the port mapping: an AI SDK `ToolSet` becomes the
 * `ToolSchema[]` Stella advertises to the model, and a `tool_request` frame
 * becomes a call into that same `ToolSet`.
 *
 * ## Two properties this module exists to hold
 *
 * **The model sees schemas; only the host executes.** {@link toModelToolSet}
 * strips `execute` before the tool set reaches the host's own model adapter.
 * Without that the AI SDK would run the tool itself the moment the model asked
 * for it, and Stella — which asks for it too, over `tool_request` — would run
 * it a second time. One `bash` call becoming two is not a degraded turn, it is
 * a duplicated side effect, and nothing downstream would report it.
 *
 * **`read_only` is the engine's dispatch decision, and it is derived from the
 * host's existing mutating-tool classification.** Stella partitions a step's
 * calls on this bit: read-only calls run concurrently, everything else is
 * serialized. That is the engine-owned replacement for `dispatch-guard.ts`'s
 * barrier, and `MaterializedTools.mutatingToolNames` — the "conservative proxy"
 * the TS engine feeds its own guard — is exactly the input it needs. The list
 * is not deleted at Phase C; it changes consumer, which is what
 * macanderson/oxagen#1234 is waiting on before its own removal step.
 *
 * A tool absent from the mutating list is still only read-only if nothing else
 * says otherwise: {@link toToolSchemas} unions the caller's list with the
 * engine's built-in workspace mutators, and Stella itself defaults an
 * undeclared tool to mutating. Both defaults fail the same safe direction —
 * a read-only tool wrongly serialized costs latency; a mutating tool wrongly
 * run concurrently costs correctness.
 */
import { asSchema, type ToolSet } from "ai";
import type { ToolOutput, ToolSchema } from "@oxagen/stella-engine-client";

/**
 * Workspace tools that mutate, mirroring `loop-driver.ts`'s `isMutatingTool`.
 *
 * Mirrored rather than imported because the engine's copy is scheduled for
 * deletion with the rest of the TS loop (macanderson/oxagen#1241) while this
 * one outlives it. The drift risk is real and is covered by a test that pins
 * the two lists together.
 */
export const BUILTIN_MUTATING_TOOLS = [
  "bash",
  "write_file",
  "edit_file",
  "delete_file",
] as const;

/** Raised when the engine asks for a tool the host does not have. */
export class UnknownToolError extends Error {
  constructor(readonly toolName: string) {
    super(`the engine requested an unregistered tool: ${toolName}`);
    this.name = "UnknownToolError";
  }
}

/**
 * The set of tool names that must be serialized, as Stella's `read_only: false`.
 */
export function mutatingToolSet(
  extra: readonly string[] | undefined,
): ReadonlySet<string> {
  return new Set<string>([...BUILTIN_MUTATING_TOOLS, ...(extra ?? [])]);
}

/**
 * Advertise a `ToolSet` to the engine.
 *
 * `asSchema` is the AI SDK's own normaliser, so a tool declared with a Zod
 * schema and one declared with a raw JSON Schema both arrive as the same JSON
 * Schema the providers would have been given — the model sees an identical
 * contract on either engine. It may return a promise (a lazily-built schema),
 * which is why this is async.
 *
 * A tool with no description is advertised with an empty one rather than
 * skipped: Stella requires the field, and withholding a tool the caller
 * registered would silently shrink the agent's capability.
 */
export async function toToolSchemas(
  tools: ToolSet,
  mutating: ReadonlySet<string>,
): Promise<ToolSchema[]> {
  const schemas: ToolSchema[] = [];
  for (const [name, tool] of Object.entries(tools)) {
    const jsonSchema = await asSchema(tool.inputSchema).jsonSchema;
    schemas.push({
      name,
      // The SDK also allows a description built from the call's context. Stella
      // advertises tools once, before the turn opens, so there is no context to
      // build one from; a context-derived description is advertised as empty
      // rather than as the source of the function.
      description: typeof tool.description === "string" ? tool.description : "",
      input_schema: (jsonSchema ?? {}) as Record<string, unknown>,
      read_only: !mutating.has(name),
    });
  }
  return schemas;
}

/**
 * The same tool set as the host's model adapter must see it: schemas only.
 *
 * See the module doc — this is the double-execution guard, and it is the
 * reason the Stella path can reuse the host's existing `AgentAi` port
 * unchanged instead of needing a second model adapter.
 */
export function toModelToolSet(tools: ToolSet): ToolSet {
  const stripped: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    const { execute: _execute, ...schemaOnly } = tool as typeof tool & {
      execute?: unknown;
    };
    stripped[name] = schemaOnly as ToolSet[string];
  }
  return stripped;
}

/**
 * Answer one `tool_request` by running the host's real tool.
 *
 * Every wrapper the caller layered onto the tool set — the CLI's permission
 * gate and lifecycle hooks, `agent.repo.edit`'s kernel `invoke()`, the file
 * lock inside `write_file`/`edit_file`, the edit-integrity gate — is already
 * baked into these `execute` functions, so it applies here unchanged. That is
 * §4's "the engine is the brain; the kernel remains the law": moving the loop
 * to Rust does not move a single enforcement point.
 *
 * A thrown tool becomes the `error` arm rather than a rejection, because tool
 * failure is ordinary and the engine's job is to hand it to the model as text
 * it can react to. A tool the host does not have is different — that is a
 * contract break between the schemas advertised and the set held — so
 * {@link UnknownToolError} is raised for the caller to classify.
 */
export async function executeToolRequest(
  tools: ToolSet,
  name: string,
  input: Record<string, unknown>,
  context: { toolCallId: string; signal?: AbortSignal },
): Promise<ToolOutput> {
  const tool = tools[name];
  if (!tool) throw new UnknownToolError(name);
  // The SDK's `execute` is generic over a per-tool context type this module
  // cannot name — it holds an arbitrary tool set built by whichever surface
  // called in. Widening to the call shape is the honest cast: the fields below
  // are the ones `ToolExecutionOptions` guarantees for every tool.
  const execute = tool.execute as
    | ((input: unknown, options: unknown) => unknown)
    | undefined;
  if (typeof execute !== "function") {
    throw new UnknownToolError(name);
  }

  try {
    const result = await execute(input, {
      toolCallId: context.toolCallId,
      messages: [],
      abortSignal: context.signal,
      // Tool context is a host-side feature the engine has no channel for;
      // a tool that needs one is wired by its own caller, not from here.
      context: undefined,
    });
    return { ok: { content: renderToolResult(result) } };
  } catch (error) {
    return {
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Render a tool's return value as the text the engine carries.
 *
 * A string passes through untouched — most workspace tools already return the
 * text the model should read, and JSON-quoting it would show the model escape
 * sequences instead of file contents.
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
