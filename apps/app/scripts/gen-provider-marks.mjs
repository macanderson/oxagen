// Writes src/ui/provider-marks.ts from the Lobe Icons static SVG set. Download
// the monochrome SVGs the table below names into a directory first, then pass
// that directory:
//
//   curl -sSL --create-dirs -o "/tmp/lobe/#1.svg" \
//     "https://unpkg.com/@lobehub/icons-static-svg@1.95.1/icons/{anthropic,openai,google}.svg"
//   node apps/app/scripts/gen-provider-marks.mjs /tmp/lobe
//
// (List every source file in the table, not only the three shown.) The script
// refuses a source that is not a `currentColor` drawing of plain paths, so a
// coloured or gradient mark never reaches the app.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) throw new Error("usage: gen-provider-marks.mjs <svg-dir>");
const out = join(import.meta.dirname, "..", "src", "ui", "provider-marks.ts");

/** Registry id → [source file, company name]. Order is the file's order. */
const ENTRIES = [
  ["anthropic", "anthropic", "Anthropic"],
  ["openai", "openai", "OpenAI"],
  ["google", "google", "Google"],
  ["xai", "xai", "xAI"],
  ["meta", "meta", "Meta"],
  ["mistral", "mistral", "Mistral AI"],
  ["deepseek", "deepseek", "DeepSeek"],
  ["zai", "zai", "Z.ai"],
  ["moonshot", "moonshot", "Moonshot AI"],
  ["qwen", "qwen", "Qwen"],
  ["cohere", "cohere", "Cohere"],
  ["voyage", "voyage", "Voyage AI"],
  ["bfl", "bfl", "Black Forest Labs"],
  ["perplexity", "perplexity", "Perplexity"],
  ["minimax", "minimax", "MiniMax"],
  ["openrouter", "openrouter", "OpenRouter"],
  ["vercel", "vercel", "Vercel"],
  ["bedrock", "bedrock", "Amazon Bedrock"],
  ["vertex", "vertexai", "Google Vertex AI"],
  ["azure", "azure", "Microsoft Azure"],
  ["groq", "groq", "Groq"],
  ["fireworks", "fireworks", "Fireworks AI"],
  ["together", "together", "Together AI"],
  ["nvidia", "nvidia", "NVIDIA"],
  ["ollama", "ollama", "Ollama"],
];

function pathsOf(file) {
  const svg = readFileSync(join(dir, `${file}.svg`), "utf8");
  if (!/fill="currentColor"/.test(svg.slice(0, 200)))
    throw new Error(`${file}: not a currentColor mark`);
  const body = svg
    .replace(/^<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "")
    .replace(/<title>[^<]*<\/title>/, "");
  const tags = [...body.matchAll(/<(\w+)/g)].map((m) => m[1]);
  if (tags.some((t) => t !== "path")) throw new Error(`${file}: non-path element`);
  return [...body.matchAll(/<path([^>]*?)\/?>/g)].map((m) => {
    const attrs = Object.fromEntries(
      [...m[1].matchAll(/([\w:-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]),
    );
    const known = new Set(["d", "clip-rule", "fill-rule", "fill-opacity"]);
    for (const k of Object.keys(attrs))
      if (!known.has(k)) throw new Error(`${file}: unexpected attribute ${k}`);
    const path = { d: attrs.d };
    if (attrs["fill-opacity"] !== undefined)
      path.opacity = Number(attrs["fill-opacity"]);
    return path;
  });
}

const lines = [];
lines.push(
  "// Generated from the Lobe Icons static SVG set (@lobehub/icons-static-svg@1.95.1,",
  "// MIT, the license in public/harnesses/LICENSE-lobe-icons.txt). Each mark is the",
  "// set's monochrome `currentColor` drawing on a 24-unit square, kept as path data",
  "// so it inherits the text colour beside it. The marks remain their owners'",
  "// trademarks and identify the company that makes a model. Do not hand-edit",
  "// this file. Run scripts/gen-provider-marks.mjs, which says how.",
  "",
  "interface MarkPath {",
  "  d: string;",
  "  /** The source's `fill-opacity`, for the one mark that layers its paths. */",
  "  opacity?: number;",
  "}",
  "",
  "interface ProviderMarkEntry {",
  "  /** The company's name as it writes it. */",
  "  label: string;",
  "  paths: readonly MarkPath[];",
  "}",
  "",
  "export const PROVIDER_MARKS = {",
);
for (const [id, file, label] of ENTRIES) {
  const paths = pathsOf(file);
  lines.push(`  ${id}: {`, `    label: ${JSON.stringify(label)},`, "    paths: [");
  for (const p of paths) {
    const extra = p.opacity === undefined ? "" : `, opacity: ${p.opacity}`;
    lines.push(`      { d: ${JSON.stringify(p.d)}${extra} },`);
  }
  lines.push("    ],", "  },");
}
lines.push(
  "} as const satisfies Record<string, ProviderMarkEntry>;",
  "",
  "export type ProviderId = keyof typeof PROVIDER_MARKS;",
  "",
);
writeFileSync(out, lines.join("\n"));
console.log(`wrote ${ENTRIES.length} marks to ${out}`);
