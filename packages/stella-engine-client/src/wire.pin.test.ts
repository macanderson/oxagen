/**
 * Holds the hand-written inbound types to Stella's own schema.
 *
 * `serveinbound.schema.json` names every field the server requires on the
 * bodies a host POSTs. A sample of each body is built here from the types in
 * `./wire`; if a required field is missing from the sample, the type has
 * drifted from the schema, and the turn would fail on the server with a 400
 * naming the field. Runs only when a Stella checkout is on disk, because the
 * schema is not vendored; the copied `.d.ts` is what CI holds the types to.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STELLA_SERVE_PINNED_VERSION } from "./version";
import type {
  CompletionResult,
  EngineOverrides,
  ProviderDeltaIn,
  ProviderResultIn,
  RequeryResultIn,
  ToolResultIn,
} from "./wire";

const repo = process.env.STELLA_REPO ?? "/Users/macanderson/Projects/stella";
const schemaPath = join(repo, "docs/wire/serveinbound.schema.json");
const present = existsSync(schemaPath);

interface Schema {
  $defs: Record<
    string,
    {
      required?: string[];
      oneOf?: Array<{ required?: string[] }>;
      properties?: Record<string, unknown>;
    }
  >;
}

const result: CompletionResult = {
  text: "",
  tool_calls: [],
  usage: {
    reported: true,
    input_tokens: 1,
    output_tokens: 1,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
  },
  model: "m",
  cost_usd: 0,
  finish_reason: "stop",
};

const samples: Record<string, object> = {
  ToolResultIn: {
    request_id: "r",
    output: { ok: { content: "" } },
  } satisfies ToolResultIn,
  ProviderResultIn: {
    request_id: "r",
    status: "ok",
    result,
  } satisfies ProviderResultIn,
  ProviderDeltaIn: {
    request_id: "r",
    deltas: [{ kind: "text", text: "t" }],
  } satisfies ProviderDeltaIn,
  RequeryResultIn: { request_id: "r", context: null } satisfies RequeryResultIn,
  CompletionResult: result,
  CompletionUsage: result.usage,
  ToolCall: { call_id: "c", name: "n", input: {} },
  EngineOverrides: { max_output_tokens: 1 } satisfies EngineOverrides,
};

describe.skipIf(!present)(
  `inbound wire pin against Stella at ${schemaPath}`,
  () => {
    const schema = present
      ? (JSON.parse(readFileSync(schemaPath, "utf8")) as Schema)
      : { $defs: {} };

    it.each(Object.keys(samples))("%s carries every required field", (name) => {
      const def = schema.$defs[name];
      expect(def, `no $defs entry named ${name}`).toBeDefined();
      const sample = samples[name]!;
      for (const field of def!.required ?? []) {
        expect(
          sample,
          `${name}.${field} is required by the schema`,
        ).toHaveProperty(field);
      }
      // A tagged union lists its arms under oneOf; the sample must satisfy one.
      if (def!.oneOf) {
        const satisfied = def!.oneOf.some((arm) =>
          (arm.required ?? []).every((f) => f in sample),
        );
        expect(satisfied, `${name} sample satisfies no oneOf arm`).toBe(true);
      }
    });

    it("names every $defs entry this client hand-writes", () => {
      for (const name of [
        "ProviderResultIn",
        "ProviderDeltaIn",
        "ToolResultIn",
        "RequeryResultIn",
        "EngineOverrides",
      ]) {
        expect(schema.$defs).toHaveProperty(name);
      }
    });

    it("pins the version the copied declarations came from", () => {
      const manifest = readFileSync(join(repo, "Cargo.toml"), "utf8");
      // The workspace version line; a newer checkout is fine, an older one is not
      // what the types were copied from.
      const match = manifest.match(/^version\s*=\s*"([^"]+)"/m);
      expect(match, "workspace version in Cargo.toml").not.toBeNull();
      expect(
        compare(match![1]!, STELLA_SERVE_PINNED_VERSION),
      ).toBeGreaterThanOrEqual(0);
    });
  },
);

it("records the pinned server version", () => {
  expect(STELLA_SERVE_PINNED_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});

function compare(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}
