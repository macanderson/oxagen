import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildProvider,
  coordinatorProvider,
  judgeProvider,
  workerProvider,
} from "../providers/factory.js";
import {
  AnthropicProvider,
  GatewayCloudProvider,
  OpenAiProvider,
} from "../providers/cloud.js";
import { OnDeviceProvider } from "../providers/on-device.js";

const CLOUD_DEPS = { cloud: { resolveKey: () => "k" } };

describe("buildProvider", () => {
  it("builds the on-device coordinator", () => {
    expect(buildProvider("on-device").kind()).toBe("on-device");
  });

  it("builds cloud providers by registry id", () => {
    const haiku = buildProvider("haiku", CLOUD_DEPS);
    expect(haiku.kind()).toBe("cloud");
    expect(haiku.id()).toBe("haiku");
    expect(haiku.capabilities().vendor).toBe("anthropic");

    const judge = buildProvider("openai-most-capable-coding-model", CLOUD_DEPS);
    expect(judge.capabilities().vendor).toBe("openai");
  });

  it("throws for an unknown model id", () => {
    expect(() => buildProvider("nope")).toThrow(/Unknown model id/);
  });

  it("selects the right concrete provider class per id (on-device vs cloud vendor)", () => {
    // The role-resolution seam relies on this: on-device ids route to the local
    // runtime, cloud ids to the vendor cloud class (both extend GatewayCloudProvider).
    expect(buildProvider("on-device")).toBeInstanceOf(OnDeviceProvider);

    const haiku = buildProvider("haiku", CLOUD_DEPS);
    expect(haiku).toBeInstanceOf(AnthropicProvider);
    expect(haiku).toBeInstanceOf(GatewayCloudProvider);

    const openai = buildProvider(
      "openai-most-capable-coding-model",
      CLOUD_DEPS,
    );
    expect(openai).toBeInstanceOf(OpenAiProvider);
    expect(openai).toBeInstanceOf(GatewayCloudProvider);
  });
});

describe("role helpers", () => {
  beforeEach(() => {
    delete process.env["OXAGEN_COORDINATOR"];
  });
  afterEach(() => {
    delete process.env["OXAGEN_COORDINATOR"];
  });

  it("coordinator defaults to on-device and honours the env override", () => {
    process.env["OXAGEN_COORDINATOR"] = "on-device";
    expect(coordinatorProvider().kind()).toBe("on-device");
    process.env["OXAGEN_COORDINATOR"] = "haiku";
    expect(coordinatorProvider(CLOUD_DEPS).id()).toBe("haiku");
  });

  it("worker + judge resolve from the registry", () => {
    expect(workerProvider("defaultCode", CLOUD_DEPS).id()).toBe("sonnet-5");
    expect(workerProvider("cheapBasic", CLOUD_DEPS).id()).toBe("haiku");
    expect(judgeProvider(CLOUD_DEPS).capabilities().vendor).toBe("openai");
  });

  it("role helpers route through the same class selection (on-device coordinator, cloud worker/judge)", () => {
    // Pin the coordinator to on-device (env wins over any machine config) → the
    // local runtime class; worker/judge resolve to the cloud vendor classes.
    process.env["OXAGEN_COORDINATOR"] = "on-device";
    expect(coordinatorProvider()).toBeInstanceOf(OnDeviceProvider);
    expect(workerProvider("defaultCode", CLOUD_DEPS)).toBeInstanceOf(
      GatewayCloudProvider,
    );
    expect(judgeProvider(CLOUD_DEPS)).toBeInstanceOf(OpenAiProvider);
  });
});
