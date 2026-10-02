// The collector/v1 document a GitHub collector row mirrors (P1-03, #5103).
import { describe, expect, it } from "vitest";
import { readCollectorFile, registerCollectorModules } from "@oxagen/ingestion/collectors";
import { renderGithubCollectorFile } from "./collectors";

describe("renderGithubCollectorFile", () => {
  it("writes a collector/v1 file that reads back, with every write-back switch off", () => {
    registerCollectorModules();
    const text = renderGithubCollectorFile({ name: "github", connection: "con_01", repos: ["acme/web", "acme/api"] });
    const read = readCollectorFile("work/collectors/github.toml", text);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.file).toMatchObject({
      name: "github",
      type: "github",
      connection: "con_01",
      scope: { repos: ["acme/web", "acme/api"] },
      writeBack: { certify_note: false, send_note: false, status: false, close: false, labels: false },
    });
    expect(read.file.fileHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("fails the module's scope check for a repository that is not owner/name", () => {
    registerCollectorModules();
    const read = readCollectorFile("work/collectors/github.toml", renderGithubCollectorFile({ name: "github", connection: "con_01", repos: ["web"] }));
    expect(read.ok).toBe(false);
  });
});
