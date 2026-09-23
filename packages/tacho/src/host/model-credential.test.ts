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
import { writeSensitiveFileAtomic } from "./fs";
import {
  applyModelCredentials,
  hasOrphanedModelCredential,
  helperCommandFor,
  isTachoHelper,
  modelCredentialBackupPath,
  peekModelCredentials,
  readCodexApiKeyMember,
  readModelCredentialState,
  restoreModelCredentials,
  STATIC_TOKEN_RENEW_WINDOW_MS,
  staticTokenRenewWindowMs,
  staticTokenStillGood,
} from "./model-credential";
import { generateRunTokenKey, mintRunToken } from "./run-token";

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

  it("takes neither member when Claude Code sets both a key and a bearer, and says why", async () => {
    // Custody holds one credential per provider, so taking both would keep
    // the second and lose the first at unenroll. Nothing moves until the
    // person picks one.
    const both = JSON.stringify(
      {
        env: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_AUTH_TOKEN: "bearer-FAKE" },
      },
      null,
      2,
    );
    seed(settingsPath(), both);
    expect(
      await peekModelCredentials({
        home,
        harnesses: ["claude-code"],
        helperCommand: HELPER,
      }),
    ).toEqual([]);
    const applied = await applyModelCredentials(
      { home, harnesses: ["claude-code"], helperCommand: HELPER },
      internals(),
    );
    expect(applied.taken).toEqual([]);
    expect(applied.harnesses[0]).toMatchObject({
      brokered: false,
      changed: false,
      reason: "two_credentials",
    });
    expect(readFileSync(settingsPath(), "utf8")).toBe(both);
    expect(existsSync(modelCredentialBackupPath("claude-code", home))).toBe(
      false,
    );
    // A read names the same reason, so status says what enroll said.
    const read = await readModelCredentialState(
      { home, harnesses: ["claude-code"], helperCommand: HELPER },
      internals(),
    );
    expect(read.harnesses[0]).toMatchObject({
      brokered: false,
      reason: "two_credentials",
    });
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

  it("takes a key the person put back after enrolling, and remembers the member once", async () => {
    seed(settingsPath(), SETTINGS);
    const options = { home, harnesses: ["claude-code"] as const };
    await applyModelCredentials(
      { ...options, harnesses: [...options.harnesses], helperCommand: HELPER },
      internals(),
    );
    const settings = JSON.parse(readFileSync(settingsPath(), "utf8"));
    settings.env.ANTHROPIC_API_KEY = "sk-ant-api03-PUT-BACK-BY-HAND";
    seed(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`);
    const again = await applyModelCredentials(
      { ...options, harnesses: [...options.harnesses], helperCommand: HELPER },
      internals(),
    );
    expect(again.taken.map((t) => t.credential.secret)).toEqual([
      "sk-ant-api03-PUT-BACK-BY-HAND",
    ]);
    expect(again.harnesses[0]).toMatchObject({ brokered: true, changed: true });
    expect(readFileSync(settingsPath(), "utf8")).not.toContain("PUT-BACK");
    expect(
      JSON.parse(readFileSync(again.harnesses[0]!.backup, "utf8")),
    ).toMatchObject({
      taken: [{ member: "ANTHROPIC_API_KEY", kind: "api_key" }],
    });
  });

  it("keeps the file's own indent and line endings", async () => {
    seed(
      authPath(),
      `{\r\n\t"OPENAI_API_KEY": "${OPENAI_KEY}",\r\n\t"last_refresh": "x"\r\n}\r\n`,
    );
    await applyModelCredentials(
      {
        home,
        harnesses: ["codex"],
        helperCommand: HELPER,
        staticTokens: { codex: STATIC },
      },
      internals(),
    );
    const written = readFileSync(authPath(), "utf8");
    expect(written).toBe(
      `{\r\n\t"OPENAI_API_KEY": "${STATIC}",\r\n\t"last_refresh": "x"\r\n}\r\n`,
    );
  });
});

describe("restore", () => {
  it("puts the key back by name into a file edited since apply, and keeps the edits", async () => {
    seed(settingsPath(), SETTINGS);
    await applyModelCredentials(
      { home, harnesses: ["claude-code"], helperCommand: HELPER },
      internals(),
    );
    const edited = JSON.parse(readFileSync(settingsPath(), "utf8"));
    edited.env.NEW_SINCE = "1";
    edited.model = "opus";
    edited.hooks.Stop.push({ hooks: [{ type: "command", command: "x" }] });
    seed(settingsPath(), `${JSON.stringify(edited, null, 2)}\n`);
    const restored = await restoreModelCredentials(
      { home, harnesses: ["claude-code"], helperCommand: HELPER },
      { secrets: { anthropic: { kind: "api_key", secret: KEY } } },
      internals(),
    );
    expect(restored.harnesses[0]).toMatchObject({
      changed: true,
      brokered: false,
    });
    expect(JSON.parse(readFileSync(settingsPath(), "utf8"))).toEqual({
      env: {
        ANTHROPIC_API_KEY: KEY,
        ANTHROPIC_BASE_URL: "http://127.0.0.1:4319/anthropic",
        OTHER: "kept",
        NEW_SINCE: "1",
      },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }] },
      unknown: [1, 2, 3],
      model: "opus",
    });
    expect(existsSync(modelCredentialBackupPath("claude-code", home))).toBe(
      false,
    );
  });

  it("puts a released key back even when the receipt is lost or unreadable", async () => {
    // The caller releases the secret from custody once restore returns, so
    // a restore that dropped it for want of a receipt would lose the key.
    for (const damage of [
      (backup: string) => rmSync(backup),
      (backup: string) => writeFileSync(backup, "{ not a receipt"),
      (backup: string) =>
        writeFileSync(backup, JSON.stringify({ schema: "something.else" })),
    ]) {
      seed(settingsPath(), SETTINGS);
      const applied = await applyModelCredentials(
        { home, harnesses: ["claude-code"], helperCommand: HELPER },
        internals(),
      );
      damage(applied.harnesses[0]!.backup);
      const restored = await restoreModelCredentials(
        { home, harnesses: ["claude-code"], helperCommand: HELPER },
        { secrets: { anthropic: { kind: "api_key", secret: KEY } } },
        internals(),
      );
      expect(restored.harnesses[0]).toMatchObject({
        changed: true,
        brokered: false,
      });
      const settings = JSON.parse(readFileSync(settingsPath(), "utf8"));
      expect(settings.apiKeyHelper).toBeUndefined();
      expect(settings.env.ANTHROPIC_API_KEY).toBe(KEY);
      expect(existsSync(applied.harnesses[0]!.backup)).toBe(false);
    }
    // With no receipt the kind decides the member: a bearer is what
    // `ANTHROPIC_AUTH_TOKEN` holds.
    seed(settingsPath(), JSON.stringify({ apiKeyHelper: HELPER }));
    await restoreModelCredentials(
      { home, harnesses: ["claude-code"], helperCommand: HELPER },
      { secrets: { anthropic: { kind: "bearer", secret: "corp-bearer" } } },
      internals(),
    );
    expect(JSON.parse(readFileSync(settingsPath(), "utf8"))).toEqual({
      env: { ANTHROPIC_AUTH_TOKEN: "corp-bearer" },
    });
  });

  it("leaves a Codex key the person already put back alone, and drops the receipt", async () => {
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
    const own = `{\n  "OPENAI_API_KEY": "sk-proj-THEIR-OWN-AGAIN",\n  "last_refresh": "y"\n}\n`;
    seed(authPath(), own);
    const restored = await restoreModelCredentials(
      { home, harnesses: ["codex"], helperCommand: HELPER },
      { secrets: { openai: { kind: "bearer", secret: OPENAI_KEY } } },
      internals(),
    );
    expect(restored.harnesses[0]).toMatchObject({
      changed: false,
      brokered: false,
    });
    expect(readFileSync(authPath(), "utf8")).toBe(own);
    expect(existsSync(applied.harnesses[0]!.backup)).toBe(false);
  });

  it("puts Codex's key back into a file edited since apply, keeping the edits", async () => {
    seed(authPath(), AUTH);
    await applyModelCredentials(
      {
        home,
        harnesses: ["codex"],
        helperCommand: HELPER,
        staticTokens: { codex: STATIC },
      },
      internals(),
    );
    const edited = JSON.parse(readFileSync(authPath(), "utf8"));
    edited.tokens = { id_token: "later-login" };
    seed(authPath(), `${JSON.stringify(edited, null, 2)}\n`);
    const restored = await restoreModelCredentials(
      { home, harnesses: ["codex"], helperCommand: HELPER },
      { secrets: { openai: { kind: "bearer", secret: OPENAI_KEY } } },
      internals(),
    );
    expect(restored.harnesses[0]!.changed).toBe(true);
    expect(JSON.parse(readFileSync(authPath(), "utf8"))).toEqual({
      OPENAI_API_KEY: OPENAI_KEY,
      last_refresh: "2026-09-01T00:00:00Z",
      tokens: { id_token: "later-login" },
    });
  });

  it("removes a static token nothing was released for, and a file that did not exist before", async () => {
    seed(authPath(), AUTH);
    await applyModelCredentials(
      {
        home,
        harnesses: ["codex"],
        helperCommand: HELPER,
        staticTokens: { codex: STATIC },
      },
      internals(),
    );
    // Custody was shredded or never had the key: the token comes out and
    // the rest of the file stays, so Codex asks for a login rather than
    // sending a token the gateway will refuse.
    const restored = await restoreModelCredentials(
      { home, harnesses: ["codex"], helperCommand: HELPER },
      {},
      internals(),
    );
    expect(restored.harnesses[0]!.changed).toBe(true);
    expect(JSON.parse(readFileSync(authPath(), "utf8"))).toEqual({
      last_refresh: "2026-09-01T00:00:00Z",
    });
    // A restore with nothing to do says so and touches nothing.
    const again = await restoreModelCredentials(
      { home, harnesses: ["codex", "claude-code"], helperCommand: HELPER },
      {},
      internals(),
    );
    expect(
      again.harnesses.map((h) => [h.harness, h.changed, h.reason]),
    ).toEqual([
      ["codex", false, undefined],
      ["claude-code", false, "no_file"],
    ]);
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

  it("still recognises an orphan in a file that no longer parses", () => {
    // A half-edited file that still names our helper or holds a token is
    // one the sweep must visit; one that mentions neither is not ours.
    seed(settingsPath(), `{ "apiKeyHelper": "${HELPER}", broken`);
    seed(authPath(), `{ "OPENAI_API_KEY": "${STATIC}", broken`);
    expect(hasOrphanedModelCredential("claude-code", home)).toBe(true);
    expect(hasOrphanedModelCredential("codex", home)).toBe(true);
    seed(settingsPath(), "{ broken");
    seed(authPath(), '{ "OPENAI_API_KEY": "sk-proj-x", broken');
    expect(hasOrphanedModelCredential("claude-code", home)).toBe(false);
    expect(hasOrphanedModelCredential("codex", home)).toBe(false);
  });

  it("reads a file that does not parse as not brokered, without throwing", async () => {
    seed(settingsPath(), "{ broken");
    seed(authPath(), "{ broken");
    const state = await readModelCredentialState(
      { home, harnesses: ["claude-code", "codex"], helperCommand: HELPER },
      internals(),
    );
    expect(
      state.harnesses.map((h) => [h.harness, h.brokered, h.helper]),
    ).toEqual([
      ["claude-code", false, null],
      ["codex", false, undefined],
    ]);
    // A managed settings file that sets our own helper is no shadow.
    seed(
      join(home, "managed-settings.json"),
      JSON.stringify({ apiKeyHelper: HELPER }),
    );
    seed(settingsPath(), JSON.stringify({ apiKeyHelper: HELPER }));
    const managed = await readModelCredentialState(
      { home, harnesses: ["claude-code"], helperCommand: HELPER },
      internals(),
    );
    expect(managed.harnesses[0]).toMatchObject({ brokered: true });
    expect(managed.harnesses[0]!.shadowedBy).toBeUndefined();
  });

  it("reads Codex's key member the way the CLI and the daemon both do", () => {
    expect(readCodexApiKeyMember(home)).toBeUndefined();
    seed(authPath(), AUTH);
    expect(readCodexApiKeyMember(home)).toBe(OPENAI_KEY);
    seed(authPath(), JSON.stringify({ tokens: {} }));
    expect(readCodexApiKeyMember(home)).toBeUndefined();
    seed(authPath(), "{ broken");
    expect(readCodexApiKeyMember(home)).toBeUndefined();
  });
});

describe("the static token renewal window", () => {
  const DAY = 24 * 60 * 60_000;
  const now = Date.parse("2026-09-22T12:00:00.000Z");

  it("is the full week while the enrollment has more than two weeks left", () => {
    const host = { expires_at: new Date(now + 60 * DAY).toISOString() };
    expect(staticTokenRenewWindowMs(host, now)).toBe(
      STATIC_TOKEN_RENEW_WINDOW_MS,
    );
    expect(staticTokenRenewWindowMs({}, now)).toBe(
      STATIC_TOKEN_RENEW_WINDOW_MS,
    );
    expect(staticTokenRenewWindowMs({ expires_at: "never" }, now)).toBe(
      STATIC_TOKEN_RENEW_WINDOW_MS,
    );
  });

  it("halves what is left of the enrollment inside its last two weeks, so a token clamped to that expiry is never re-minted", () => {
    const host = { expires_at: new Date(now + 4 * DAY).toISOString() };
    expect(staticTokenRenewWindowMs(host, now)).toBe(2 * DAY);
    // The token expires with the enrollment: four days left is more than
    // the two-day window, so it stands rather than being re-minted hourly
    // for a token with the same expiry.
    const key = generateRunTokenKey();
    const keyPath = join(home, "run-token.key");
    writeSensitiveFileAtomic(keyPath, `${key.bytes.toString("hex")}\n`);
    const clamped = mintRunToken({
      key,
      host: "tch_0123456789abcdefghjkmn",
      harness: "codex",
      provider: "openai",
      placement: "static",
      now,
      notAfter: now + 4 * DAY,
    });
    const enrollment = {
      host_enrollment_id: "tch_0123456789abcdefghjkmn",
      ...host,
    };
    expect(staticTokenStillGood(clamped.token, enrollment, keyPath, now)).toBe(
      true,
    );
    expect(
      staticTokenStillGood(
        clamped.token,
        enrollment,
        keyPath,
        now + 3 * DAY + 12 * 60 * 60_000,
      ),
    ).toBe(true);
    // Past the expiry the token no longer verifies, so it is due.
    expect(
      staticTokenStillGood(clamped.token, enrollment, keyPath, now + 5 * DAY),
    ).toBe(false);
  });
});
