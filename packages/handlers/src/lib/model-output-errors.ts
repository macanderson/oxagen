// model-output-errors.ts: telling a model answer that did not parse from an
// outage, for callers of generateObjectFor.
//
// generateObjectFor throws when the model's answer does not fit the schema it
// asked for. A caller that counts a bad answer as one result, such as triage
// or a selection run, reads the error by its name. Handlers do not import
// `ai`, so the AI SDK's error classes are not here to test with instanceof.

/** AI SDK errors that mean the model's answer did not parse as the schema asked. */
const OUTPUT_ERRORS: ReadonlySet<string> = new Set([
  "AI_NoObjectGeneratedError",
  "AI_TypeValidationError",
  "AI_JSONParseError",
]);

/** True when the error says the model's answer did not parse. Any other error is an outage. */
export function isOutputParseError(error: unknown): boolean {
  return error instanceof Error && OUTPUT_ERRORS.has(error.name);
}
