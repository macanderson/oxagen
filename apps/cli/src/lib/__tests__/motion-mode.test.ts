/**
 * getMotionMode / setMotionMode — the /motion animation-level setting.
 *
 * Precedence under test (env beats persisted config, matching every other
 * getter in lib/config.ts): OXAGEN_CLI_MOTION → the legacy OXAGEN_CLI_FUN=0
 * opt-out (maps to "reduced") → config.motion → "full".
 *
 * `homedir()` is mocked to a scratch directory so reads/writes hit a throwaway
 * config.json, never the developer's real ~/.config/oxagen/config.json.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FAKE_HOME = vi.hoisted(
  () => `${process.env["TMPDIR"] ?? "/tmp"}/oxagen-motion-home-${process.pid}`,
);

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, homedir: (): string => FAKE_HOME };
});

const { getMotionMode, setMotionMode, writeConfig, readConfig } = await import(
  "../config.js"
);

const CONFIG_DIR = join(FAKE_HOME, ".config", "oxagen");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

const originalMotionEnv = process.env["OXAGEN_CLI_MOTION"];
const originalFunEnv = process.env["OXAGEN_CLI_FUN"];

beforeEach(() => {
  rmSync(FAKE_HOME, { recursive: true, force: true });
  delete process.env["OXAGEN_CLI_MOTION"];
  delete process.env["OXAGEN_CLI_FUN"];
});

afterAll(() => {
  rmSync(FAKE_HOME, { recursive: true, force: true });
  if (originalMotionEnv === undefined) delete process.env["OXAGEN_CLI_MOTION"];
  else process.env["OXAGEN_CLI_MOTION"] = originalMotionEnv;
  if (originalFunEnv === undefined) delete process.env["OXAGEN_CLI_FUN"];
  else process.env["OXAGEN_CLI_FUN"] = originalFunEnv;
});

describe("getMotionMode", () => {
  it("defaults to full when nothing is configured", () => {
    expect(getMotionMode()).toBe("full");
  });

  it("reads the persisted /motion choice from config", () => {
    setMotionMode("reduced");
    expect(getMotionMode()).toBe("reduced");
    setMotionMode("off");
    expect(getMotionMode()).toBe("off");
    setMotionMode("full");
    expect(getMotionMode()).toBe("full");
  });

  it("OXAGEN_CLI_MOTION env overrides the persisted config", () => {
    setMotionMode("off");
    process.env["OXAGEN_CLI_MOTION"] = "full";
    expect(getMotionMode()).toBe("full");
  });

  it("ignores an invalid OXAGEN_CLI_MOTION value and falls through", () => {
    setMotionMode("reduced");
    process.env["OXAGEN_CLI_MOTION"] = "sideways";
    expect(getMotionMode()).toBe("reduced");
  });

  it("maps the legacy OXAGEN_CLI_FUN=0 opt-out to reduced", () => {
    process.env["OXAGEN_CLI_FUN"] = "0";
    expect(getMotionMode()).toBe("reduced");
  });

  it("legacy OXAGEN_CLI_FUN=0 (an env var) beats persisted config", () => {
    setMotionMode("full");
    process.env["OXAGEN_CLI_FUN"] = "0";
    expect(getMotionMode()).toBe("reduced");
  });

  it("OXAGEN_CLI_MOTION beats the legacy OXAGEN_CLI_FUN=0 opt-out", () => {
    process.env["OXAGEN_CLI_FUN"] = "0";
    process.env["OXAGEN_CLI_MOTION"] = "full";
    expect(getMotionMode()).toBe("full");
  });

  it('OXAGEN_CLI_FUN set to anything but "0" is not an opt-out', () => {
    process.env["OXAGEN_CLI_FUN"] = "1";
    expect(getMotionMode()).toBe("full");
  });

  it("ignores a corrupt motion value in the config file", () => {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(
      CONFIG_FILE,
      JSON.stringify({ motion: "hyperspeed" }),
      "utf8",
    );
    expect(getMotionMode()).toBe("full");
  });
});

describe("setMotionMode", () => {
  it("persists via writeConfig's shallow merge, preserving unrelated keys", () => {
    writeConfig({ token: "keep-me", model: "test/model" });
    setMotionMode("off");
    const config = readConfig();
    expect(config.motion).toBe("off");
    expect(config.token).toBe("keep-me");
    expect(config.model).toBe("test/model");
    // And it really landed on disk, not just in memory.
    expect(JSON.parse(readFileSync(CONFIG_FILE, "utf8")).motion).toBe("off");
  });
});
