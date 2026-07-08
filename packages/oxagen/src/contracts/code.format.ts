import { z } from "zod";
import { registerCapability } from "../registry";

// Upper bound on the source fed to the formatter. The formatter runs inside the
// sandbox, but the source is embedded in the driver script, so cap it.
const MAX_SOURCE_BYTES = 1024 * 1024; // 1 MiB

// Languages the formatter supports today. Each is formatted INSIDE the sandbox
// using only the stock, network-isolated image's standard library, so no
// formatter binary needs installing (which the deny-network policy forbids):
//   - json:   `json.loads` + `json.dumps` round-trip (lossless, re-indents).
//   - python: `ast.parse` + `ast.unparse` canonical normalization (Python 3.9+;
//             note this drops comments — it is a canonicaliser, not a style
//             formatter — documented in docs/capabilities/code.format.md).
// The enum is the single extension point: adding `black`/`prettier` later is a
// one-line change here plus a driver entry once the images carry the tool.
export const codeFormatLanguageSchema = z
  .enum(["json", "python"])
  .describe("Language to format");

export const codeFormat = registerCapability({
  name: "format_code",
  aliases: ["code.format"],
  domain: "code",
  description:
    "Run a language-aware formatter on source inside the sandbox and return " +
    "the formatted text. Supports json (re-indent) and python (canonical " +
    "ast normalization). Requires SANDBOX_ENABLED=true.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "code" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    language: codeFormatLanguageSchema,
    source: z
      .string()
      .min(1)
      .max(MAX_SOURCE_BYTES)
      .describe("Source code to format"),
    indent: z
      .number()
      .int()
      .min(0)
      .max(8)
      .default(2)
      .describe("Indent width in spaces (json only; ignored for python)"),
  }),
  output: z.object({
    formatted: z.string().describe("The formatted source"),
    changed: z
      .boolean()
      .describe("True when the formatted output differs from the input"),
    language: codeFormatLanguageSchema,
  }),
});

export type CodeFormatInput = z.output<typeof codeFormat.input>;
export type CodeFormatOutput = z.output<typeof codeFormat.output>;
