import { promptPatchSchema, type PromptPatch } from "@oxagen/agent-artifacts";

export interface LifecyclePrompt {
  system: string;
  user: string;
  input: unknown;
  metadata: Record<string, unknown>;
}

export class PromptPatchError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "PromptPatchError";
  }
}

function setPointer(root: unknown, pointer: string, value: unknown): unknown {
  const cloned = structuredClone(root);
  const segments = pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (segments.length === 0 || segments[0] === "") return value;
  let cursor: unknown = cloned;
  for (const segment of segments.slice(0, -1)) {
    if (typeof cursor !== "object" || cursor === null || !(segment in cursor)) {
      throw new PromptPatchError(
        "invalid_prompt_patch_path",
        `missing path ${pointer}`,
      );
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  const last = segments.at(-1) as string;
  if (typeof cursor !== "object" || cursor === null || !(last in cursor)) {
    throw new PromptPatchError(
      "invalid_prompt_patch_path",
      `missing path ${pointer}`,
    );
  }
  (cursor as Record<string, unknown>)[last] = value;
  return cloned;
}

export function applyPromptPatch(
  prompt: LifecyclePrompt,
  rawPatch: unknown,
): LifecyclePrompt {
  const patch: PromptPatch = promptPatchSchema.parse(rawPatch);
  const next: LifecyclePrompt = structuredClone(prompt);
  for (const operation of patch.operations) {
    switch (operation.op) {
      case "prepend_system_context":
        next.system = `${operation.content}\n\n${next.system}`;
        break;
      case "append_system_context":
        next.system = `${next.system}\n\n${operation.content}`;
        break;
      case "prepend_user_context":
        next.user = `${operation.content}\n\n${next.user}`;
        break;
      case "append_user_context":
        next.user = `${next.user}\n\n${operation.content}`;
        break;
      case "redact_input_path":
        next.input = setPointer(next.input, operation.path, "[REDACTED]");
        break;
      case "replace_input_path":
        next.input = setPointer(next.input, operation.path, operation.value);
        break;
      case "add_metadata":
        next.metadata[operation.key] = operation.value;
        break;
      case "reject_turn":
        throw new PromptPatchError(operation.code, operation.message);
    }
  }
  return next;
}
