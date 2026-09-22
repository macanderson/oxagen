import { describe, expect, it } from "vitest";
import { parseRunExportDownloadUrl } from "./run-export-download-url";

describe("parseRunExportDownloadUrl", () => {
  it("accepts the API's signed download URL", () => {
    const raw = "https://api.oxagen.sh/v1/run-exports/download?token=a.b";
    expect(parseRunExportDownloadUrl(raw)).toBe(raw);
  });

  it.each([
    ["a relative path", "/v1/run-exports/download?token=a.b"],
    ["another path", "https://api.oxagen.sh/v1/other?token=a.b"],
    ["no token", "https://api.oxagen.sh/v1/run-exports/download"],
    [
      "credentials",
      "https://u:p@api.oxagen.sh/v1/run-exports/download?token=a",
    ],
    ["a script URL", "javascript:alert(1)"],
    [
      "a non-canonical spelling",
      "HTTPS://api.oxagen.sh/v1/run-exports/download?token=a",
    ],
  ])("refuses %s (negative)", (_label, raw) => {
    expect(parseRunExportDownloadUrl(raw)).toBeNull();
  });
});
