import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyModelCredentials,
  hasOrphanedModelCredential,
  helperCommandFor,
  isTachoHelper,
  modelCredentialBackupPath,
  readModelCredentialState,
  restoreModelCredentials,
} from "./model-credential";

const KEY = "sk-ant-api03-FAKE-TAKEN-INTO-CUSTODY-1234";
const OPENAI_KEY = "sk-proj-FAKE-OPENAI-KEY-5678";
const HELPER = helperCommandFor('"/opt/oxagen/bin/tacho"');
const STATIC = "oxrt_eyJ2IjoxfQ.c2ln";

let home: string;
const settingsPath = () => join(home, ".claude", "settings.json");
const authPath = () => join(home, ".codex", "auth.json");

function seed(path: string, text: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, mode);
}

function internals() {
  return { managedSettingsFile: join(home, "managed-settings.json") };
}

const SETTINGS = `{
  "env": {
    "ANTHROPIC_API_KEY": "${KEY}",
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:4319/anthropic",
    "OTHER": "kept"
  },
  "hooks": { "Stop": [] },
  "unknown": [1, 2, 3]
}
`;

const AUTH = `{
  "OPENAI_API_KEY": "${OPENAI_KEY}",
  "last_refresh": "2026-09-01T00:00:00Z"
}
`;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "model-credential-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("the helper command", () => {
  it("is recognised whatever binary it names, and only when it is ours", () => {
    expect(isTachoHelper(HELPER)).toBe(true);
    expect(
      isTachoHelper("node /x/tacho.mjs credential issue --harness claude-code"),
    ).toBe(true);
    expect(isTachoHelper("/usr/bin/vault read anthropic")).toBe(false);
    expect(isTachoHelper(undefined)).toBe(false);
  });
});

describe("apply", () => {
  it("takes Claude Code's key out of the env block and puts the helper in, keeping everything else", async () => {
    seed(settingsPath(), SETTINGS, 0o640);
    const state = await applyModelCredentials(
      { home, harnesses: ["claude-code"], helperCommand: HELPER },
      internals(),
    );
    expect(state.taken).toEqual([
      {
        harness: "claude-code",
        provider: "anthropic",
        credential: { kind: "api_key", secret: KEY },
        member: "env.ANTHROPIC_API_KEY",
      },
    ]);
    const claude = state.harnesses[0]!;
    expect(claude).toMatchObject({
      harness: "claude-code",
      brokered: true,
      changed: true,
      helper: HELPER,
    });
    const written = JSON.parse(readFileSync(settingsPath(), "utf8"));
    expect(written.apiKeyHelper).toBe(HELPER);
    expect(written.env).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4319/anthropic",
      OTHER: "kept",
    });
    expect(written.hooks).toEqual({ Stop: [] });
    expect(written.unknown).toEqual([1, 2, 3]);
    expect(statSync(settingsPath()).mode & 0o777).toBe(0o640);
    // The secret is nowhere on disk but where the caller seals it.
    expect(readFileSync(settingsPath(), "utf8")).not.toContain(KEY);
    const sidecar = readFileSync(claude.backup, "utf8");
    expect(sidecar).not.toContain(KEY);
    expect(JSON.parse(sidecar)).toMatchObject({
      schema: "oxagen.model-credential.v1",
      existed: true,
      previous_helper: null,
      taken: [{ member: "ANTHROPIC_API_KEY", kind: "api_key" }],
    });
  });

  it("is idempotent: a second apply changes nothing and takes nothing", async () => {
    seed(settingsPath(), SETTINGS);
    seed(authPath(), AUTH);
    const options = {
      home,
      harnesses: ["claude-code", "codex"] as const,
      helperCommand: HELPER,
      staticTokens: { codex: STATIC },
    };
    await applyModelCredentials(
      { ...options, harnesses: [...options.harnesses] },
      internals(),
    );
    const before = [
      readFileSync(settingsPath(), "utf8"),
      readFileSync(authPath(), "utf8"),
    ];
    const again = await applyModelCredentials(
      { ...options, harnesses: [...options.harnesses] },
      internals(),
    );
    expect(again.taken).toEqual([]);
    expect(again.harnesses.map((h) => h.changed)).toEqual([false, false]);
    expect([
      readFileSync(settingsPath(), "utf8"),
      readFileSync(authPath(), "utf8"),
    ]).toEqual(before);
  });

  it("displaces a helper somebody else set and a bearer token, and restores both", async () => {
    seed(
      settingsPath(),
      JSON.stringify(
        {
          apiKeyHelper: "/usr/local/bin/corp-vault anthropic",
          env: { ANTHROPIC_AUTH_TOKEN: "corp-bearer-FAKE" },
        },
        null,
        2,
      ),
    );
    const applied = await applyModelCredentials(
      { home, harnesses: ["claude-code"], helperCommand: HELPER },
      internals(),
    );
    expect(applied.taken).toEqual([
      {
        harness: "claude-code",
        provider: "anthropic",
        credential: { kind: "bearer", secret: "corp-bearer-FAKE" },
        member: "env.ANTHROPIC_AUTH_TOKEN",
      },
    ]);
    const restored = await restoreModelCredentials(
      { home, harnesses: ["claude-code"], helperCommand: HELPER },
      {
        secrets: { anthropic: { kind: "bearer", secret: "corp-bearer-FAKE" } },
      },
      internals(),
    );
    expect(restored.harnesses[0]).toMatchObject({
      changed: true,
      brokered: false,
    });
    expect(JSON.parse(readFileSync(settingsPath(), "utf8"))).toEqual({
      apiKeyHelper: "/usr/local/bin/corp-vault anthropic",
      env: { ANTHROPIC_AUTH_TOKEN: "corp-bearer-FAKE" },
    });
    expect(existsSync(modelCredentialBackupPath("claude-code", home))).toBe(
      false,
    );
  });

  it("writes the helper into a settings file that does not exist yet, and removes it again", async () => {
    await applyModelCredentials(
      { home, harnesses: ["claude-code"], helperCommand: HELPER },
      internals(),
    );
    expect(JSON.parse(readFileSync(settingsPath(), "utf8"))).toEqual({
      apiKeyHelper: HELPER,
    });
    const restored = await restoreModelCredentials(
      { home, harnesses: ["claude-code"], helperCommand: HELPER },
      {},
      internals(),
    );
    expect(restored.harnesses[0]!.changed).toBe(true);
    expect(JSON.parse(readFileSync(settingsPath(), "utf8"))).toEqual({});
  });

  it("puts a static token into Codex's auth.json in place of the key, and restores the key", async () => {
    seed(authPath(), AUTH);
    const applied = await applyModelCredentials(
      {
        home,
        harnesses: ["codex"],
        helperCommand: HELPER,
        staticTokens: { codex: STATIC },
      },
      internals(),
    );
    expect(applied.taken).toEqual([
      {
        harness: "codex",
        provider: "openai",
        credential: { kind: "bearer", secret: OPENAI_KEY },
        member: "OPENAI_API_KEY",
      },
    ]);
    expect(applied.harnesses[0]).toMatchObject({
      brokered: true,
      changed: true,
    });
    const written = JSON.parse(readFileSync(authPath(), "utf8"));
    expect(written).toEqual({
      OPENAI_API_KEY: STATIC,
      last_refresh: "2026-09-01T00:00:00Z",
    });
    expect(readFileSync(authPath(), "utf8")).not.toContain(OPENAI_KEY);

    const restored = await restoreModelCredentials(
      { home, harnesses: ["codex"], helperCommand: HELPER },
      { secrets: { openai: { kind: "bearer", secret: OPENAI_KEY } } },
      internals(),
    );
    expect(restored.harnesses[0]!.changed).toBe(true);
    expect(readFileSync(authPath(), "utf8")).toBe(AUTH);
  });

  it("creates auth.json for a key that came from the enrolling shell, and deletes it on restore", async () => {
    await applyModelCredentials(
      {
        home,
        harnesses: ["codex"],
        helperCommand: HELPER,
        staticTokens: { codex: STATIC },
      },
      internals(),
    );
    expect(JSON.parse(readFileSync(authPath(), "utf8"))).toEqual({
      OPENAI_API_KEY: STATIC,
    });
    await restoreModelCredentials(
      { home, harnesses: ["codex"], helperCommand: HELPER },
      {},
      internals(),
    );
    expect(existsSync(authPath())).toBe(false);
  });

  it("leaves a ChatGPT login alone and says why", async () => {
    seed(
      authPath(),
      JSON.stringify({ tokens: { access_token: "FAKE", account_id: "acc" } }),
    );
    const state = await applyModelCredentials(
      {
        home,
        harnesses: ["codex"],
        helperCommand: HELPER,
        staticTokens: { codex: STATIC },
      },
      internals(),
    );
    expect(state.taken).toEqual([]);
    expect(state.harnesses[0]).toMatchObject({
      brokered: false,
      changed: false,
      reason: "subscription_login",
    });
    expect(readFileSync(authPath(), "utf8")).toContain("access_token");
  });

  it("takes nothing from Codex when it has no token to write in exchange", async () => {
    seed(authPath(), AUTH);
    const state = await applyModelCredentials(
      { home, harnesses: ["codex"], helperCommand: HELPER },
      internals(),
    );
    expect(state.taken).toEqual([]);
    expect(state.harnesses[0]).toMatchObject({
      brokered: false,
      reason: "no_token",
    });
    expect(readFileSync(authPath(), "utf8")).toBe(AUTH);
  });

  it("refuses to rewrite a symlinked file, and reports a managed helper that shadows ours", async () => {
    const real = join(home, "dotfiles", "settings.json");
    seed(real, SETTINGS);
    mkdirSync(dirname(settingsPath()), { recursive: true });
    symlinkSync(real, settingsPath());
    seed(
      join(home, "managed-settings.json"),
      JSON.stringify({ apiKeyHelper: "/corp/helper" }),
    );
    const state = await applyModelCredentials(
      { home, harnesses: ["claude-code"], helperCommand: HELPER },
      internals(),
    );
    expect(state.taken).toEqual([]);
    expect(state.harnesses[0]).toMatchObject({
      brokered: false,
      reason: "symlink",
      shadowedBy: {
        file: join(home, "managed-settings.json"),
        value: "/corp/helper",
      },
    });
    expect(readFileSync(real, "utf8")).toBe(SETTINGS);
  });

  it("refuses a file that is not JSON rather than guessing", async () => {
    seed(settingsPath(), "{ not json");
    await expect(
      applyModelCredentials(
        { home, harnesses: ["claude-code"], helperCommand: HELPER },
        internals(),
      ),
    ).rejects.toThrow(/not valid JSON/);
  });
});

describe("read and orphans", () => {
  it("reports a brokered harness only when nothing in the env block would win over the helper", async () => {
    seed(
      settingsPath(),
      JSON.stringify({ apiKeyHelper: HELPER, env: { ANTHROPIC_API_KEY: KEY } }),
    );
    const state = await readModelCredentialState(
      { home, harnesses: ["claude-code", "codex"], helperCommand: HELPER },
      internals(),
    );
    expect(state.harnesses[0]).toMatchObject({
      brokered: false,
      helper: HELPER,
    });
    expect(state.harnesses[1]).toMatchObject({
      brokered: false,
      reason: "no_file",
    });
    expect(state.taken).toEqual([]);
  });

  it("recognises our helper or a run token left behind with no receipt", () => {
    seed(settingsPath(), JSON.stringify({ apiKeyHelper: HELPER }));
    seed(authPath(), JSON.stringify({ OPENAI_API_KEY: STATIC }));
    expect(hasOrphanedModelCredential("claude-code", home)).toBe(true);
    expect(hasOrphanedModelCredential("codex", home)).toBe(true);
    seed(authPath(), AUTH);
    expect(hasOrphanedModelCredential("codex", home)).toBe(false);
    rmSync(settingsPath());
    expect(hasOrphanedModelCredential("claude-code", home)).toBe(false);
  });
});
