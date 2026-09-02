// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildPinnedContext,
  pinStorageKey,
  readStoredPins,
  writeStoredPins,
  DRAFT_PREFIX,
} from "./pinned-context";
import type { RepoOption } from "./repo-selector";
import type { EnvironmentOption } from "./environment-selector";

const REPO: RepoOption = {
  key: "acme/web",
  connectionId: "con_1",
  owner: "acme",
  name: "web",
  defaultBranch: "main",
};
const ENV: EnvironmentOption = {
  id: "env_1",
  name: "Production",
  isDefault: false,
};

describe("buildPinnedContext", () => {
  it("returns null when neither repo nor environment is set", () => {
    expect(buildPinnedContext(null, null)).toBeNull();
  });

  it("carries the repo wire fields (dropping the selector key)", () => {
    const payload = buildPinnedContext(REPO, null);
    expect(payload).toEqual({
      repo: {
        connectionId: "con_1",
        owner: "acme",
        name: "web",
        defaultBranch: "main",
      },
      environment: null,
    });
    // `key` is a client-only selector identity — it must not leak to the wire.
    expect(payload?.repo).not.toHaveProperty("key");
  });

  it("carries only the environment when no repo is selected (independent pins)", () => {
    expect(buildPinnedContext(null, ENV)).toEqual({
      repo: null,
      environment: { id: "env_1", name: "Production" },
    });
  });

  it("carries both when both are selected", () => {
    const payload = buildPinnedContext(REPO, ENV);
    expect(payload?.repo?.name).toBe("web");
    expect(payload?.environment?.name).toBe("Production");
  });
});

describe("pinStorageKey", () => {
  it("uses a conversation-scoped key when a conversation id exists", () => {
    expect(pinStorageKey("ws", "conv_abc")).toBe(
      "oxagen:chat-pins:conv:conv_abc",
    );
  });

  it("uses a workspace-scoped draft key for a not-yet-created conversation", () => {
    const key = pinStorageKey("ws", null);
    expect(key.startsWith(DRAFT_PREFIX)).toBe(true);
    expect(key).toBe(`${DRAFT_PREFIX}ws`);
  });

  it("draft and conversation keys never collide", () => {
    expect(pinStorageKey("ws", null)).not.toBe(pinStorageKey("ws", "conv_abc"));
  });
});

describe("readStoredPins / writeStoredPins", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("round-trips a stored pin", () => {
    const key = pinStorageKey("ws", "conv_1");
    writeStoredPins(key, { repoKey: "acme/web", envId: "env_1" });
    expect(readStoredPins(key)).toEqual({
      repoKey: "acme/web",
      envId: "env_1",
    });
  });

  it("returns null for an unset key", () => {
    expect(readStoredPins(pinStorageKey("ws", "conv_missing"))).toBeNull();
  });

  it("removes the entry when writing null or an empty pin", () => {
    const key = pinStorageKey("ws", "conv_1");
    writeStoredPins(key, { repoKey: "acme/web", envId: null });
    expect(readStoredPins(key)).not.toBeNull();
    writeStoredPins(key, null);
    expect(readStoredPins(key)).toBeNull();
    // An all-null pin is treated as "nothing to persist".
    writeStoredPins(key, { repoKey: null, envId: null });
    expect(readStoredPins(key)).toBeNull();
  });

  it("tolerates a corrupt stored value", () => {
    const key = pinStorageKey("ws", "conv_1");
    window.localStorage.setItem(key, "{ not json");
    expect(readStoredPins(key)).toBeNull();
  });

  it("ignores non-string fields in stored json", () => {
    const key = pinStorageKey("ws", "conv_1");
    window.localStorage.setItem(
      key,
      JSON.stringify({ repoKey: 42, envId: "env_1" }),
    );
    expect(readStoredPins(key)).toEqual({ repoKey: null, envId: "env_1" });
  });
});
