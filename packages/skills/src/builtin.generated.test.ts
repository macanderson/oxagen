import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEmbeddedFiles, renderGeneratedModule } from "./builtin-codegen";

const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATED = join(HERE, "builtin-skills.generated.ts");

// Drift guard: the committed generated module must exactly match what the codegen
// produces from the current skill.toml files. This fails CI when someone adds or
// edits a skill without running `pnpm --filter @oxagen/skills gen:skills`, which
// is exactly how a new builtin would otherwise silently fail to embed.
describe("builtin-skills.generated.ts", () => {
  it("is up to date with the skills/ directory (run gen:skills if this fails)", async () => {
    const files = await buildEmbeddedFiles();
    const expected = renderGeneratedModule(files);
    const actual = await readFile(GENERATED, "utf8");
    expect(actual).toBe(expected);
  });
});
