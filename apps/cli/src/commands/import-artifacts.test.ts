import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureWriter } from "../lib/capture-writer";
import { handleImportArtifacts } from "./import-artifacts";

describe("import artifacts command", () => {
  it("supports dry-run JSON and defaults conflicts to skip", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "import-command-"));
    await mkdir(join(cwd, ".claude", "commands"), { recursive: true });
    await writeFile(
      join(cwd, ".claude", "commands", "audit.md"),
      "---\nname: audit\ndescription: Audit\n---\nAudit $ARGUMENTS",
    );
    const captured = captureWriter();
    await handleImportArtifacts(
      { from: ["claude"], scope: "workspace", dryRun: true, json: true },
      captured.writer,
      { cwd },
    );
    const receipt = JSON.parse(captured.output()) as {
      dryRun: boolean;
      items: unknown[];
    };
    expect(receipt.dryRun).toBe(true);
    expect(receipt.items).toHaveLength(1);
  });
});
