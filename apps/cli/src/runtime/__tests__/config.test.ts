import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

// Control the underlying config file so these tests never touch the real home.
vi.mock("../../lib/config.js", () => ({
  readConfig: vi.fn(() => ({})),
  writeConfig: vi.fn(),
}));

import { readConfig, writeConfig, type CliConfig } from "../../lib/config.js";
import {
  getAutoDownload,
  getCacheDir,
  getCoordinator,
  getOnDeviceModelId,
  getQuantizationPreference,
  getVerifyChecksum,
  setCoordinator,
  setOnDeviceConfig,
} from "../config.js";

const mockRead = vi.mocked(readConfig);
const mockWrite = vi.mocked(writeConfig);

const ENV_KEYS = [
  "OXAGEN_COORDINATOR",
  "OXAGEN_ONDEVICE_MODEL",
  "OXAGEN_MODELS_CACHE_DIR",
];

function stub(cfg: CliConfig): void {
  mockRead.mockReturnValue(cfg);
}

beforeEach(() => {
  stub({});
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("defaults come from models.json when nothing is set", () => {
  it("uses registry defaults", () => {
    expect(getCoordinator()).toBe("on-device");
    expect(getAutoDownload()).toBe(true);
    expect(getOnDeviceModelId()).toBe("auto");
    expect(getVerifyChecksum()).toBe(true);
    expect(getQuantizationPreference()).toEqual(["q8", "q6", "q5", "q4"]);
    expect(getCacheDir()).toBe(join(homedir(), ".oxagen/models"));
  });
});

describe("user config overrides defaults", () => {
  it("honours runtime config values", () => {
    stub({
      runtime: {
        coordinator: "haiku",
        onDevice: {
          autoDownload: false,
          modelId: "qwen2.5-coder-7b-instruct",
          verifyChecksum: false,
          quantizationPreference: ["q4"],
          cacheDir: "/data/models",
        },
      },
    });
    expect(getCoordinator()).toBe("haiku");
    expect(getAutoDownload()).toBe(false);
    expect(getOnDeviceModelId()).toBe("qwen2.5-coder-7b-instruct");
    expect(getVerifyChecksum()).toBe(false);
    expect(getQuantizationPreference()).toEqual(["q4"]);
    expect(getCacheDir()).toBe("/data/models");
  });
});

describe("env overrides beat config", () => {
  it("prefers env for coordinator, model id, and cache dir", () => {
    stub({
      runtime: {
        coordinator: "haiku",
        onDevice: { modelId: "auto", cacheDir: "/data" },
      },
    });
    process.env["OXAGEN_COORDINATOR"] = "on-device";
    process.env["OXAGEN_ONDEVICE_MODEL"] = "big-32b";
    process.env["OXAGEN_MODELS_CACHE_DIR"] = "/env/models";
    expect(getCoordinator()).toBe("on-device");
    expect(getOnDeviceModelId()).toBe("big-32b");
    expect(getCacheDir()).toBe("/env/models");
  });
});

describe("setters", () => {
  it("setCoordinator merges into runtime config", () => {
    stub({ runtime: { onDevice: { modelId: "auto" } } });
    setCoordinator("haiku");
    expect(mockWrite).toHaveBeenCalledWith({
      runtime: { onDevice: { modelId: "auto" }, coordinator: "haiku" },
    });
  });

  it("setOnDeviceConfig merges into the onDevice block", () => {
    stub({
      runtime: { coordinator: "on-device", onDevice: { modelId: "auto" } },
    });
    setOnDeviceConfig({ autoDownload: false });
    expect(mockWrite).toHaveBeenCalledWith({
      runtime: {
        coordinator: "on-device",
        onDevice: { modelId: "auto", autoDownload: false },
      },
    });
  });
});
