/**
 * embed-skills — CLI wrapper that regenerates `src/builtin-skills.generated.ts`
 * from every `skills/<slug>/skill.toml` on disk.
 *
 * WHY THIS EXISTS: builtin skill manifests are data, not imported code.
 * Serverless bundlers (Vercel/esbuild/Next) trace the `import` graph and drop a
 * sibling package's data files, so a runtime `readdir(packages/skills/skills)`
 * returns ENOENT in prod, silently breaking workspace skill seeding and the
 * `create-agent` fallback ("no tenant copy and no builtin on disk"). Embedding
 * the raw file contents as a committed TS module makes builtins travel with
 * every bundle, identically in dev, test, and prod.
 *
 * Regenerate with:  pnpm --filter @oxagen/skills gen:skills
 * A drift-guard test (builtin.generated.test.ts) fails CI if the committed file
 * is stale, so adding a new skill.toml forces a regenerate.
 *
 * The reusable engine lives in src/builtin-codegen.ts so the drift-guard test
 * can import it without crossing the tsconfig rootDir boundary.
 */
import { writeFile } from "node:fs/promises";
import { relative, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildEmbeddedFiles,
  renderGeneratedModule,
  GENERATED_FILE,
} from "../src/builtin-codegen";

async function main(): Promise<void> {
  const files = await buildEmbeddedFiles();
  const module = renderGeneratedModule(files);
  await writeFile(GENERATED_FILE, module, "utf8");
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  console.log(
    `[embed-skills] wrote ${files.length} builtin skills → ${relative(pkgRoot, GENERATED_FILE)}`,
  );
}

main().catch((err: unknown) => {
  console.error("[embed-skills] failed", err);
  process.exit(1);
});
