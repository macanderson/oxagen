import { describe, expect, it } from "vitest";
import { OpenApiImportError } from "./errors";
import { normalizePath, resolveRefPath } from "./ref-path";

const FILES = new Set(["openapi.yaml", "paths/items.yaml", "schemas/pet.yaml", "b.yaml", "dir/openapi.yaml"]);

/** The OpenApiImportError that `run` throws. */
function thrown(run: () => unknown): OpenApiImportError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(OpenApiImportError);
    return error as OpenApiImportError;
  }
  throw new Error("expected an OpenApiImportError");
}

describe("normalizePath", () => {
  it.each([
    ["openapi.yaml", "openapi.yaml"],
    ["./schemas/./pet.yaml", "schemas/pet.yaml"],
    ["schemas\\pet.yaml", "schemas/pet.yaml"],
    ["schemas//pet.yaml", "schemas/pet.yaml"],
    ["paths/../schemas/pet.yaml", "schemas/pet.yaml"],
  ])("keys %s as %s", (path, key) => {
    expect(normalizePath(path)).toBe(key);
  });

  it.each(["/etc/passwd", "\\\\server\\share\\a.yaml", "C:\\specs\\a.yaml", "file:///a.yaml", "../a.yaml", "a/../../b.yaml", ".", ""])(
    "refuses %j",
    (path) => {
      expect(normalizePath(path)).toBeUndefined();
    },
  );
});

describe("resolveRefPath", () => {
  it("resolves a bare fragment inside the file that holds it", () => {
    expect(resolveRefPath("#/components/schemas/Pet", "openapi.yaml", FILES)).toStrictEqual({
      file: "openapi.yaml",
      tokens: ["components", "schemas", "Pet"],
    });
  });

  it("resolves a relative file against the folder of the file that holds it", () => {
    expect(resolveRefPath("schemas/pet.yaml", "openapi.yaml", FILES)).toStrictEqual({ file: "schemas/pet.yaml", tokens: [] });
    expect(resolveRefPath("../schemas/pet.yaml#/Pet", "paths/items.yaml", FILES)).toStrictEqual({
      file: "schemas/pet.yaml",
      tokens: ["Pet"],
    });
  });

  it("decodes the fragment and unescapes each pointer token", () => {
    expect(resolveRefPath("schemas/pet.yaml#/a~1b/c~0d/%7Bid%7D", "openapi.yaml", FILES).tokens).toStrictEqual([
      "a/b",
      "c~d",
      "{id}",
    ]);
  });

  it("percent-decodes the path before it collapses", () => {
    expect(resolveRefPath("%2e%2e/schemas/pet.yaml", "paths/items.yaml", FILES).file).toBe("schemas/pet.yaml");
    const error = thrown(() => resolveRefPath("%2e%2e/secret.yaml", "openapi.yaml", FILES));
    expect(error.code).toBe("ref_outside");
    expect(error.ref).toBe("%2e%2e/secret.yaml");
  });

  it("turns backslashes into slashes", () => {
    expect(resolveRefPath("schemas\\pet.yaml", "openapi.yaml", FILES).file).toBe("schemas/pet.yaml");
    expect(resolveRefPath("..%5Cschemas%5Cpet.yaml", "paths/items.yaml", FILES).file).toBe("schemas/pet.yaml");
    expect(thrown(() => resolveRefPath("..\\..\\etc\\passwd", "paths/items.yaml", FILES)).code).toBe("ref_outside");
  });

  it("collapses . and .. before it looks the file up", () => {
    expect(resolveRefPath("./a/../../b.yaml", "dir/openapi.yaml", FILES).file).toBe("b.yaml");
    const error = thrown(() => resolveRefPath("./a/../../b.yaml", "openapi.yaml", FILES));
    expect(error.code).toBe("ref_outside");
    expect(error.ref).toBe("./a/../../b.yaml");
  });

  it.each([
    "http://example.com/pet.yaml",
    "https://example.com/pet.yaml#/Pet",
    "file:///etc/passwd",
    "//example.com/pet.yaml",
    "/etc/passwd",
    "%2Fetc%2Fpasswd",
    "http%3A%2F%2Fexample.com%2Fpet.yaml",
    "C:\\specs\\pet.yaml",
    "./",
  ])("refuses %s as outside the folder and names it", (ref) => {
    const error = thrown(() => resolveRefPath(ref, "openapi.yaml", FILES));
    expect(error.code).toBe("ref_outside");
    expect(error.ref).toBe(ref);
    expect(error.message).toContain(`The $ref "${ref}" in openapi.yaml points outside the folder.`);
  });

  it("refuses a file that is not in the folder", () => {
    const error = thrown(() => resolveRefPath("schemas/missing.yaml", "openapi.yaml", FILES));
    expect(error.code).toBe("ref_missing");
    expect(error.ref).toBe("schemas/missing.yaml");
    expect(error.message).toMatch(/names schemas\/missing\.yaml, which is not in the folder/);
  });

  it("refuses a path that does not percent-decode", () => {
    const error = thrown(() => resolveRefPath("pet%E0%A4%A.yaml", "openapi.yaml", FILES));
    expect(error.code).toBe("ref_missing");
    expect(error.message).toMatch(/is not a valid URI reference/);
  });

  it("refuses a fragment that does not percent-decode", () => {
    const error = thrown(() => resolveRefPath("schemas/pet.yaml#/%E0%A4%A", "openapi.yaml", FILES));
    expect(error.code).toBe("ref_missing");
    expect(error.message).toMatch(/has a fragment that is not valid/);
  });

  it("refuses an anchor fragment", () => {
    const error = thrown(() => resolveRefPath("schemas/pet.yaml#Pet", "openapi.yaml", FILES));
    expect(error.code).toBe("ref_missing");
    expect(error.message).toMatch(/uses an anchor/);
  });
});
