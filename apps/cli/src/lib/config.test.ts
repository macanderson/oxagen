import { describe, it, expect, vi, beforeEach } from "vitest";

// Factory must not reference outer-scope variables (hoisted before const declarations)
vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));
vi.mock("os", () => ({ homedir: () => "/mock-home" }));
vi.mock("path", () => ({
  join: (...parts: string[]) => parts.join("/"),
}));

import * as fs from "fs";
import { readConfig, writeConfig, clearConfig, getToken, getApiUrl } from "./config.js";

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockWriteFileSync = vi.mocked(fs.writeFileSync);
const mockMkdirSync = vi.mocked(fs.mkdirSync);

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env["OXAGEN_API_URL"];
});

describe("readConfig", () => {
  it("returns empty object when config file does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    expect(readConfig()).toEqual({});
  });

  it("parses and returns JSON config", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ token: "tok123", orgSlug: "my-org" }));
    expect(readConfig()).toEqual({ token: "tok123", orgSlug: "my-org" });
  });

  it("returns empty object and warns on JSON parse error", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("INVALID JSON {{{");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = readConfig();
    expect(result).toEqual({});
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("failed to read config file"),
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("oxagen auth login"),
    );
    stderrSpy.mockRestore();
  });

  it("returns empty object and warns when readFileSync throws (e.g. EACCES)", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => {
      const err = new Error("EACCES: permission denied");
      (err as NodeJS.ErrnoException).code = "EACCES";
      throw err;
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = readConfig();
    expect(result).toEqual({});
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("EACCES"),
    );
    stderrSpy.mockRestore();
  });
});

describe("writeConfig", () => {
  it("creates config dir if missing and writes merged config", () => {
    // existsSync: true for file (readConfig), false for dir check (mkdirSync guard)
    mockExistsSync
      .mockReturnValueOnce(true)   // readConfig file check
      .mockReturnValueOnce(false); // dir check in writeConfig
    mockReadFileSync.mockReturnValue(JSON.stringify({ token: "old" }));

    writeConfig({ orgSlug: "new-org" });

    expect(mockMkdirSync).toHaveBeenCalled();
    expect(mockWriteFileSync).toHaveBeenCalled();
    const calls = mockWriteFileSync.mock.calls as unknown[][];
    const written = JSON.parse(calls[0]?.[1] as string) as Record<string, unknown>;
    expect(written).toMatchObject({ token: "old", orgSlug: "new-org" });
  });

  it("skips mkdirSync when config dir already exists", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({}));

    writeConfig({ token: "new-tok" });

    expect(mockMkdirSync).not.toHaveBeenCalled();
    const calls = mockWriteFileSync.mock.calls as unknown[][];
    const written = JSON.parse(calls[0]?.[1] as string) as Record<string, unknown>;
    expect(written.token).toBe("new-tok");
  });
});

describe("clearConfig", () => {
  it("unsets token, orgSlug, workspaceSlug but preserves other fields", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ token: "t", orgSlug: "o", workspaceSlug: "w", apiUrl: "u" })
    );

    clearConfig();

    const calls = mockWriteFileSync.mock.calls as unknown[][];
    const written = JSON.parse(calls[0]?.[1] as string) as Record<string, unknown>;
    expect(written.token).toBeUndefined();
    expect(written.orgSlug).toBeUndefined();
    expect(written.workspaceSlug).toBeUndefined();
    expect(written.apiUrl).toBe("u");
  });
});

describe("getToken", () => {
  it("returns token from config", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ token: "my-token" }));
    expect(getToken()).toBe("my-token");
  });

  it("returns undefined when no token", () => {
    mockExistsSync.mockReturnValue(false);
    expect(getToken()).toBeUndefined();
  });
});

describe("getApiUrl", () => {
  it("returns env var when set", () => {
    process.env["OXAGEN_API_URL"] = "http://localhost:4000";
    mockExistsSync.mockReturnValue(false);
    expect(getApiUrl()).toBe("http://localhost:4000");
  });

  it("returns config apiUrl when no env var", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ apiUrl: "http://custom.api" }));
    expect(getApiUrl()).toBe("http://custom.api");
  });

  it("falls back to prod URL", () => {
    mockExistsSync.mockReturnValue(false);
    expect(getApiUrl()).toBe("https://oxagen-v2-api.vercel.app");
  });
});
