/**
 * What a `beforeForward` hook does to a request body to add steering text,
 * per vendor. Pure, and they return a new object, which is how the proxy
 * knows the body changed and must be re-serialized.
 *
 * These are the two edits the injection seam exists for (story sheet item 6,
 * injection point 5). They decide nothing about WHAT is injected: that is the
 * Phase 1 assembler's job, and until it exists nothing calls them outside a
 * test.
 */

type Json = Record<string, unknown>;

/**
 * Append a system block to an Anthropic Messages request. `system` may be
 * absent, a string or a list of blocks; the result is always a list, with the
 * caller's own system text first so its prompt cache prefix is unchanged.
 */
export function withAnthropicSystemBlock(body: Json, text: string): Json {
  const block = { type: "text", text };
  const system = body["system"];
  if (typeof system === "string")
    return { ...body, system: [{ type: "text", text: system }, block] };
  if (Array.isArray(system))
    return { ...body, system: [...(system as unknown[]), block] };
  return { ...body, system: [block] };
}

/**
 * Add instructions to an OpenAI request. A Responses request carries them in
 * `instructions`; a Chat Completions request has no such member, so the text
 * goes in as a system message after the caller's own leading system messages.
 */
export function withOpenAiInstructions(body: Json, text: string): Json {
  const given = body["messages"];
  if (Array.isArray(given)) {
    const messages = given as unknown[];
    let after = 0;
    while (
      after < messages.length &&
      ["system", "developer"].includes(
        String((messages[after] as Json | undefined)?.["role"]),
      )
    )
      after += 1;
    return {
      ...body,
      messages: [
        ...messages.slice(0, after),
        { role: "system", content: text },
        ...messages.slice(after),
      ],
    };
  }
  const existing = body["instructions"];
  return {
    ...body,
    instructions:
      typeof existing === "string" && existing.length > 0
        ? `${existing}\n\n${text}`
        : text,
  };
}
