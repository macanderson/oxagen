import { getSandbox, isSandboxAvailable } from "@oxagen/sandbox";
import { insertEvents } from "@oxagen/telemetry";
import type { CapabilityContext } from "../types";
import type {
  CodeFormatInput,
  CodeFormatOutput,
} from "@oxagen/oxagen/contracts/code.format";

export type { CodeFormatInput, CodeFormatOutput };

// Resource envelope for the formatter run. Formatting is fast and never needs
// the network, so we hardcode a conservative envelope rather than exposing
// these as capability inputs.
const FORMAT_TIMEOUT_MS = 30_000;
const FORMAT_MEMORY_MB = 256;

// Sentinel that prefixes the JSON result line the in-sandbox driver prints.
// `ast.parse`/`ast.unparse` and `json.loads` never EXECUTE the caller's source,
// so the source can never emit this marker itself — the only writer is our
// driver. We still scan for the LAST occurrence defensively.
const RESULT_SENTINEL = "<<<OXAGEN_FMT_RESULT>>>";

interface DriverResult {
  ok: boolean;
  formatted?: string;
  error?: string;
}

/**
 * Build a self-contained Python driver that formats `source` and prints a
 * single sentinel-prefixed JSON result line. The source is embedded as base64
 * so arbitrary bytes survive without any quoting/escaping hazard, and it is
 * never `exec`'d — `json`/`ast` parse it as data. Every language is handled by
 * the stock, network-isolated `python:3.12-slim` image's standard library, so
 * no formatter binary needs installing (which the deny-network policy forbids).
 */
function buildFormatterDriver(input: CodeFormatInput): string {
  const b64 = Buffer.from(input.source, "utf-8").toString("base64");
  const header =
    "import base64, json\n" +
    `src = base64.b64decode("${b64}").decode("utf-8")\n` +
    `SENT = ${JSON.stringify(RESULT_SENTINEL)}\n`;

  if (input.language === "json") {
    // Lossless structural re-indent via the json stdlib module.
    return (
      header +
      "try:\n" +
      `    out = json.dumps(json.loads(src), indent=${input.indent}, ensure_ascii=False)\n` +
      '    print(SENT + json.dumps({"ok": True, "formatted": out}))\n' +
      "except Exception as e:\n" +
      '    print(SENT + json.dumps({"ok": False, "error": str(e)}))\n'
    );
  }

  // python: canonical normalization via ast round-trip (Python 3.9+).
  return (
    "import ast\n" +
    header +
    "try:\n" +
    "    out = ast.unparse(ast.parse(src))\n" +
    '    print(SENT + json.dumps({"ok": True, "formatted": out}))\n' +
    "except SyntaxError as e:\n" +
    '    print(SENT + json.dumps({"ok": False, "error": "SyntaxError: " + str(e)}))\n'
  );
}

function parseDriverResult(stdout: string): DriverResult | null {
  const marker = stdout.lastIndexOf(RESULT_SENTINEL);
  if (marker === -1) return null;
  const rest = stdout.slice(marker + RESULT_SENTINEL.length);
  const line = rest.split("\n", 1)[0] ?? "";
  try {
    return JSON.parse(line) as DriverResult;
  } catch {
    return null;
  }
}

/**
 * Run a language-aware formatter on `source` inside the sandbox and return the
 * formatted text. The formatter is a fixed, stdlib-only driver — it never
 * executes the caller's source — and runs through the same sandbox driver
 * abstraction (resource limits + network deny + filesystem isolation) as
 * agent.code.execute, so this surface adds no second sandbox.
 */
export async function codeFormatHandler(
  input: CodeFormatInput,
  ctx: CapabilityContext,
): Promise<CodeFormatOutput> {
  if (!isSandboxAvailable()) {
    throw new Error(
      "Code formatting is not available. Set SANDBOX_ENABLED=true and configure a sandbox driver.",
    );
  }

  // getSandbox() enforces DEFAULT_POLICY at the dispatch seam. This request's
  // envelope is fixed and provably within it (python is allowed, 30 s ≤ 30 s,
  // 256 MB ≤ 512 MB, network deny), so applyPolicy is a guaranteed no-op here —
  // it can never throw SandboxPolicyError, so no policy-error mapping is needed.
  const sandbox = getSandbox();
  const result = await sandbox.run({
    language: "python",
    code: buildFormatterDriver(input),
    timeoutMs: FORMAT_TIMEOUT_MS,
    memoryMb: FORMAT_MEMORY_MB,
    network: "deny",
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
  });

  await emitFormatTelemetry(ctx, input, result.durationMs);

  if (result.timedOut) {
    throw new Error("code.format: formatter timed out");
  }

  const parsed = parseDriverResult(result.stdout);
  if (!parsed) {
    throw new Error(
      `code.format: formatter produced no result (exit ${result.exitCode}): ` +
        (result.stderr.slice(0, 500) || result.stdout.slice(0, 500)),
    );
  }
  if (!parsed.ok || typeof parsed.formatted !== "string") {
    throw new Error(
      `code.format: ${parsed.error ?? "could not format source"}`,
    );
  }

  return {
    formatted: parsed.formatted,
    changed: parsed.formatted !== input.source,
    language: input.language,
  };
}

async function emitFormatTelemetry(
  ctx: CapabilityContext,
  input: CodeFormatInput,
  durationMs: number,
): Promise<void> {
  // Meter the sandbox runtime cost → ClickHouse. Like agent.code.execute, this
  // does not pass through the @oxagen/ai metering chokepoint, so without this
  // its infra cost would be unpriced. Best-effort: a telemetry write must never
  // fail a format run.
  try {
    await insertEvents([
      {
        event_id: crypto.randomUUID(),
        org_id: ctx.orgId,
        workspace_id: ctx.workspaceId,
        event_type: "code.format.ran",
        source_system: `handler:${ctx.surface}`,
        stream_offset: null,
        payload: JSON.stringify({
          capability: "format_code",
          language: input.language,
          durationMs,
          requestId: ctx.requestId,
        }),
        emitted_at: new Date().toISOString(),
      },
    ]);
  } catch {
    // Telemetry is best-effort; never fail a format run on an analytics write.
  }
}
