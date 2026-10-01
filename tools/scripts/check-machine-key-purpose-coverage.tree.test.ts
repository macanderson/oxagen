/**
 * Scans every source file under `packages/` and reads `machine-key-scope.ts`
 * and the API key resolver. vitest.config.ts leaves `*.tree.test.ts` files out
 * of turbo's cached tasks, so `pnpm check:tree-guards` runs this one uncached
 * in the checks job (#4664 item 2).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  allPurposeDeclarations,
  collectSourceFiles,
  missingCoverage,
} from "./check-machine-key-purpose-coverage.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("collectSourceFiles and allPurposeDeclarations against the real tree", () => {
  it("finds the purpose constants this codebase actually declares", () => {
    const files = collectSourceFiles(join(repoRoot, "packages"));
    const declarations = allPurposeDeclarations(files);
    const values = declarations.map((d) => d.value);
    expect(values).toContain("cli_session_v1");
    expect(values).toContain("agent_credential_v1");
    expect(values).toContain("tacho_host_v1");
    expect(values).toContain("tacho_gateway_v1");
    expect(values).toContain("stella_operational_telemetry_v1");
  });
});

describe("the live repository", () => {
  it("has no missing purpose coverage today", () => {
    const files = collectSourceFiles(join(repoRoot, "packages"));
    const declarations = allPurposeDeclarations(files);
    const machineKeyScopeSource = readFileSync(
      join(repoRoot, "packages/iam/src/machine-key-scope.ts"),
      "utf8",
    );
    const apiKeySource = readFileSync(
      join(repoRoot, "packages/auth/src/resolvers/api-key.ts"),
      "utf8",
    );
    expect(
      missingCoverage({ declarations, machineKeyScopeSource, apiKeySource }),
    ).toEqual([]);
  });

  it("would have failed on #3178's squash merge (30adbbb36): the CLI exemption removed", () => {
    const files = collectSourceFiles(join(repoRoot, "packages"));
    const declarations = allPurposeDeclarations(files);
    const apiKeySource = readFileSync(
      join(repoRoot, "packages/auth/src/resolvers/api-key.ts"),
      "utf8",
    );
    // The real file, with the one branch the incident deleted removed here,
    // reproducing 30adbbb36's content for this function.
    const realSource = readFileSync(
      join(repoRoot, "packages/iam/src/machine-key-scope.ts"),
      "utf8",
    );
    const staleSource = realSource.replace(
      /if \(purpose === CLI_SESSION_SCOPE_PURPOSE\) \{[\s\S]*?\n {2}\}\n\n/,
      "",
    );
    // The replace must actually have removed something, or this test proves
    // nothing. The docblock above the function still names the constant in
    // prose (it describes the exemption #3178 also left untouched, per the
    // issue), so the assertion is on the functional branch's shape, not on
    // every mention of the identifier in the file.
    expect(staleSource).not.toEqual(realSource);
    expect(staleSource).not.toContain(
      "if (purpose === CLI_SESSION_SCOPE_PURPOSE)",
    );

    const missing = missingCoverage({
      declarations,
      machineKeyScopeSource: staleSource,
      apiKeySource,
    });
    expect(missing.map((m) => m.value)).toContain("cli_session_v1");
  });
});
