/**
 * Background-monitor config (Group 5). Proves:
 *   - Every accessor defaults per `monitor-tools.json -> config.monitors`.
 *   - `config.json`'s `monitors` patch layers over the defaults.
 *   - Env overrides win over both the config-file patch and the default.
 *   - The trigger helpers (`shouldDispatchForPullRequest`/`shouldDispatchForCiFix`)
 *     mirror their underlying dispatch flags.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../lib/config.js", () => ({ readConfig: vi.fn(() => ({})) }));

import { readConfig, type CliConfig } from "../../lib/config.js";
import {
  ASK_ENV,
  ON_PR_ENV,
  ON_CI_FIX_ENV,
  POLL_SECONDS_ENV,
  DEFAULT_MONITORS_CONFIG,
  getAskBeforeMonitoring,
  getDispatchOnPullRequest,
  getDispatchOnCiFix,
  getPollIntervalSeconds,
  shouldDispatchForPullRequest,
  shouldDispatchForCiFix,
} from "../config.js";

const mockRead = vi.mocked(readConfig);
const ENV_KEYS = [ASK_ENV, ON_PR_ENV, ON_CI_FIX_ENV, POLL_SECONDS_ENV];

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

describe("defaults", () => {
  it("matches monitor-tools.json -> config.monitors", () => {
    expect(getAskBeforeMonitoring()).toBe(true);
    expect(getDispatchOnPullRequest()).toBe(true);
    expect(getDispatchOnCiFix()).toBe(true);
    expect(getPollIntervalSeconds()).toBe(30);
    expect(DEFAULT_MONITORS_CONFIG).toEqual({
      askBeforeMonitoring: true,
      dispatchOnPullRequest: true,
      dispatchOnCiFix: true,
      pollIntervalSeconds: 30,
    });
  });
});

describe("config.json patch", () => {
  it("layers monitors overrides over the defaults", () => {
    stub({
      monitors: {
        askBeforeMonitoring: false,
        dispatchOnPullRequest: false,
        dispatchOnCiFix: false,
        pollIntervalSeconds: 5,
      },
    });
    expect(getAskBeforeMonitoring()).toBe(false);
    expect(getDispatchOnPullRequest()).toBe(false);
    expect(getDispatchOnCiFix()).toBe(false);
    expect(getPollIntervalSeconds()).toBe(5);
  });

  it("falls back to defaults for unset keys in a partial patch", () => {
    stub({ monitors: { pollIntervalSeconds: 10 } });
    expect(getAskBeforeMonitoring()).toBe(true);
    expect(getPollIntervalSeconds()).toBe(10);
  });
});

describe("env overrides", () => {
  it("OXAGEN_MONITORS_ASK wins over the config-file patch and the default", () => {
    stub({ monitors: { askBeforeMonitoring: true } });
    process.env[ASK_ENV] = "0";
    expect(getAskBeforeMonitoring()).toBe(false);
    process.env[ASK_ENV] = "true";
    expect(getAskBeforeMonitoring()).toBe(true);
  });

  it("OXAGEN_MONITORS_ON_PR wins over the config-file patch and the default", () => {
    stub({ monitors: { dispatchOnPullRequest: true } });
    process.env[ON_PR_ENV] = "false";
    expect(getDispatchOnPullRequest()).toBe(false);
  });

  it("OXAGEN_MONITORS_ON_CI_FIX wins over the config-file patch and the default", () => {
    stub({ monitors: { dispatchOnCiFix: true } });
    process.env[ON_CI_FIX_ENV] = "0";
    expect(getDispatchOnCiFix()).toBe(false);
  });

  it("OXAGEN_MONITORS_POLL_SECONDS wins over the config-file patch and the default", () => {
    stub({ monitors: { pollIntervalSeconds: 30 } });
    process.env[POLL_SECONDS_ENV] = "60";
    expect(getPollIntervalSeconds()).toBe(60);
  });

  it("ignores an unparseable boolean env value and falls through", () => {
    process.env[ASK_ENV] = "maybe";
    expect(getAskBeforeMonitoring()).toBe(true);
  });

  it("ignores a negative or non-numeric poll-seconds env value and falls through", () => {
    process.env[POLL_SECONDS_ENV] = "-5";
    expect(getPollIntervalSeconds()).toBe(30);
    process.env[POLL_SECONDS_ENV] = "not-a-number";
    expect(getPollIntervalSeconds()).toBe(30);
  });
});

describe("trigger helpers", () => {
  it("shouldDispatchForPullRequest mirrors getDispatchOnPullRequest", () => {
    expect(shouldDispatchForPullRequest()).toBe(true);
    process.env[ON_PR_ENV] = "false";
    expect(shouldDispatchForPullRequest()).toBe(false);
  });

  it("shouldDispatchForCiFix mirrors getDispatchOnCiFix", () => {
    expect(shouldDispatchForCiFix()).toBe(true);
    process.env[ON_CI_FIX_ENV] = "false";
    expect(shouldDispatchForCiFix()).toBe(false);
  });
});
