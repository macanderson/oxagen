import type {
  LifecycleInvocation,
  LifecycleEventEnvelope,
} from "@oxagen/agent-artifacts";

export class LifecycleInputError extends Error {
  constructor(
    readonly code: "lifecycle_invalid_input",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "LifecycleInputError";
  }
}

export function readJsonPointer(
  root: unknown,
  pointer: string,
): { found: boolean; value?: unknown } {
  if (pointer === "") return { found: true, value: root };
  let value = root;
  for (const encoded of pointer.slice(1).split("/")) {
    const segment = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (typeof value !== "object" || value === null || !(segment in value))
      return { found: false };
    value = (value as Record<string, unknown>)[segment];
  }
  return { found: true, value };
}

export function mapLifecycleInput(
  invocation: LifecycleInvocation,
  envelope: LifecycleEventEnvelope,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [field, binding] of Object.entries(invocation.input ?? {})) {
    if (!("from" in binding) || typeof binding.from !== "string") {
      output[field] = (binding as { literal: unknown }).literal;
      continue;
    }
    const resolved = readJsonPointer(envelope, binding.from);
    if (!resolved.found && binding.required) {
      throw new LifecycleInputError(
        "lifecycle_invalid_input",
        `${invocation.id}.${field} requires ${binding.from}`,
      );
    }
    if (!resolved.found) continue;
    output[field] = resolved.value;
  }
  return output;
}
