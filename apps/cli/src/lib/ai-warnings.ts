/**
 * AI SDK warning filter for the CLI.
 *
 * The CLI routes every model call through the platform's OpenAI-compatible proxy
 * (`/v1/agent/llm`, see apps/api/src/routes/v1/agent.llm.ts). That proxy does NOT
 * accept a `response_format` field, so the `@ai-sdk/openai-compatible` provider is
 * deliberately left with `supportsStructuredOutputs = false` (its default). As a
 * result, every `generateObject` call (planner, prompt-enhancer, completeness
 * judge) makes the SDK drop the JSON-schema response format and fall back to
 * prompt-injected JSON — which is exactly what we want, because the proxy would
 * strip the schema anyway. Flipping `supportsStructuredOutputs` on would make the
 * SDK stop injecting the schema into the prompt and rely on a native structured
 * output the proxy silently discards, breaking object generation. So the fallback
 * is correct by design; the SDK just narrates it once per call:
 *
 *   AI SDK Warning (oxagen-platform / <model>): The feature "responseFormat" is
 *   not supported. JSON response format schema is only supported with
 *   structuredOutputs
 *
 * That line is pure noise here (and corrupts the Ink TUI). We install a custom
 * `AI_SDK_LOG_WARNINGS` logger that swallows ONLY this known-benign warning and
 * still surfaces every other AI SDK warning through the default console format, so
 * genuine provider warnings are never hidden.
 */
import type { LogWarningsFunction, Warning } from "ai";

/** The single warning we intentionally suppress (see module doc). */
function isResponseFormatUnsupported(warning: Warning): boolean {
  return warning.type === "unsupported" && warning.feature === "responseFormat";
}

/** Replicates the AI SDK's default single-warning console format. */
function formatWarning(
  warning: Warning,
  provider: string,
  model: string,
): string {
  const prefix = `AI SDK Warning (${provider} / ${model}):`;
  switch (warning.type) {
    case "unsupported": {
      const base = `${prefix} The feature "${warning.feature}" is not supported.`;
      return warning.details ? `${base} ${warning.details}` : base;
    }
    case "compatibility": {
      const base = `${prefix} The feature "${warning.feature}" is used in a compatibility mode.`;
      return warning.details ? `${base} ${warning.details}` : base;
    }
    case "other":
      return `${prefix} ${warning.message}`;
    default:
      return `${prefix} ${JSON.stringify(warning, null, 2)}`;
  }
}

/**
 * Install the warning filter on `globalThis.AI_SDK_LOG_WARNINGS`. Idempotent —
 * safe to call from every command entry. Must run before any `@oxagen/ai` /
 * `ai` model call so the first warning is filtered too.
 */
export function installAiSdkWarningFilter(): void {
  const logWarnings: LogWarningsFunction = ({ warnings, provider, model }) => {
    const remaining = warnings.filter((w) => !isResponseFormatUnsupported(w));
    for (const warning of remaining) {
      console.warn(formatWarning(warning, provider, model));
    }
  };
  globalThis.AI_SDK_LOG_WARNINGS = logWarnings;
}
