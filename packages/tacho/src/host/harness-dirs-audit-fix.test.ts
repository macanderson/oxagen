/**
 * The model base URL and brokered credential contracts under a moved Claude
 * Code or Codex directory, and on a settings file saved with a byte order
 * mark.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyModelBaseUrls,
  hasOrphanedModelBaseUrl,
  modelBaseUrlBackupPath,
  modelBaseUrlFile,
  restoreModelBaseUrls,
} from "./model-base-url";
import {
  applyModelCredentials,
  hasOrphanedModelCredential,
  helperCommandFor,
  modelCredentialBackupPath,
  readCodexApiKeyMember,
  restoreModelCredentials,
} from "./model-credential";
import { harnessConfigDirs, tachoPaths } from "./paths";

const BOM = "﻿";
const KEY = "sk-ant-api03-FAKE-MOVED-DIR-0001";
const OPENAI_KEY = "sk-proj-FAKE-MOVED-DIR-0002";
const HELPER = helperCommandFor("/opt/oxagen/bin/tacho");

function scratch() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "tacho-dirs-")));
  const claudeConfigDir = join(home, "claude-elsewhere");
  const codexHome = join(home, "codex-elsewhere");
  return { home, claudeConfigDir, codexHome };
}

function seed(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

// Managed files that do not exist, so the machine's own never leak in.
const noManaged = (home: string) => ({
  managedSettingsFile: join(home, "no-managed-settings.json"),
  stellaManagedSettingsFile: join(home, "no-managed-stella.toml"),
});

describe("harnessConfigDirs", () => {
  it("resolves the variables for the running user's own home, as tachoPaths does", () => {
    const env = { CLAUDE_CONFIG_DIR: "/c", CODEX_HOME: "/x" };
    const paths = tachoPaths(env, homedir());
    expect(harnessConfigDirs(homedir(), env)).toEqual({
      claudeConfigDir: dirname(paths.claudeSettings),
      codexHome: dirname(paths.codexHooks),
    });
    expect(harnessConfigDirs(homedir(), {})).toEqual({
      claudeConfigDir: join(homedir(), ".claude"),
      codexHome: join(homedir(), ".codex"),
    });
  });

  it("never sends another home to the directory a variable names", () => {
    expect(
      harnessConfigDirs("/scratch/home", {
        CLAUDE_CONFIG_DIR: "/c",
        CODEX_HOME: "/x",
      }),
    ).toEqual({
      claudeConfigDir: join("/scratch/home", ".claude"),
      codexHome: join("/scratch/home", ".codex"),
    });
  });
});

describe("the model base URL under moved directories", () => {
  it("writes, finds and restores the files the directories name", async () => {
    const { home, claudeConfigDir, codexHome } = scratch();
    const options = {
      home,
      claudeConfigDir,
      codexHome,
      port: 47002,
      harnesses: ["claude-code" as const, "codex" as const],
    };
    const state = await applyModelBaseUrls(options, noManaged(home));
    expect(state.harnesses.map((entry) => [entry.file, entry.ours])).toEqual([
      [join(claudeConfigDir, "settings.json"), true],
      [join(codexHome, "config.toml"), true],
    ]);
    expect(existsSync(join(home, ".claude"))).toBe(false);
    expect(existsSync(join(home, ".codex"))).toBe(false);
    const dirs = { claudeConfigDir, codexHome };
    expect(modelBaseUrlFile("claude-code", { home, ...dirs })).toBe(
      join(claudeConfigDir, "settings.json"),
    );
    expect(
      existsSync(modelBaseUrlBackupPath("claude-code", home, undefined, dirs)),
    ).toBe(true);
    expect(hasOrphanedModelBaseUrl("codex", home, undefined, dirs)).toBe(true);
    expect(hasOrphanedModelBaseUrl("codex", home)).toBe(false);
    await restoreModelBaseUrls(options, noManaged(home));
    expect(existsSync(join(claudeConfigDir, "settings.json"))).toBe(false);
    expect(existsSync(join(codexHome, "config.toml"))).toBe(false);
  });

  it("keeps a byte order mark and gives the file back byte for byte", async () => {
    const { home, claudeConfigDir } = scratch();
    const file = join(claudeConfigDir, "settings.json");
    const original = `${BOM}{\r\n  "theme": "dark"\r\n}\r\n`;
    seed(file, original);
    const options = {
      home,
      claudeConfigDir,
      port: 47002,
      harnesses: ["claude-code" as const],
    };
    const [entry] = (await applyModelBaseUrls(options, noManaged(home)))
      .harnesses;
    expect(entry?.ours).toBe(true);
    const written = readFileSync(file, "utf8");
    expect(written.startsWith(BOM)).toBe(true);
    expect(JSON.parse(written.slice(1)).env.ANTHROPIC_BASE_URL).toBe(
      "http://127.0.0.1:47002/anthropic",
    );
    // An edit since apply takes the surgical path, which keeps the mark too.
    writeFileSync(file, written.replace('"dark"', '"light"'));
    await restoreModelBaseUrls(options, noManaged(home));
    const restored = readFileSync(file, "utf8");
    expect(restored.startsWith(BOM)).toBe(true);
    expect(JSON.parse(restored.slice(1))).toEqual({ theme: "light" });
  });
});

describe("brokered credentials under moved directories", () => {
  it("takes and gives back the keys in the files the directories name", async () => {
    const { home, claudeConfigDir, codexHome } = scratch();
    const settings = join(claudeConfigDir, "settings.json");
    const auth = join(codexHome, "auth.json");
    seed(settings, `${JSON.stringify({ env: { ANTHROPIC_API_KEY: KEY } })}\n`);
    seed(auth, `${JSON.stringify({ OPENAI_API_KEY: OPENAI_KEY })}\n`);
    const options = {
      home,
      claudeConfigDir,
      codexHome,
      harnesses: ["claude-code" as const, "codex" as const],
      helperCommand: HELPER,
      staticTokens: { codex: "oxrt_eyJ2IjoxfQ.c2ln" },
    };
    const state = await applyModelCredentials(options, noManaged(home));
    expect(state.taken.map((entry) => entry.credential.secret)).toEqual([
      KEY,
      OPENAI_KEY,
    ]);
    expect(
      state.harnesses.map((entry) => [entry.file, entry.brokered]),
    ).toEqual([
      [settings, true],
      [auth, true],
    ]);
    const dirs = { claudeConfigDir, codexHome };
    expect(
      existsSync(modelCredentialBackupPath("claude-code", home, dirs)),
    ).toBe(true);
    expect(hasOrphanedModelCredential("claude-code", home, dirs)).toBe(true);
    expect(hasOrphanedModelCredential("claude-code", home)).toBe(false);
    expect(readCodexApiKeyMember(home, dirs)).toBe("oxrt_eyJ2IjoxfQ.c2ln");
    expect(readCodexApiKeyMember(home)).toBeUndefined();
    await restoreModelCredentials(
      options,
      {
        secrets: {
          anthropic: { kind: "api_key", secret: KEY },
          openai: { kind: "bearer", secret: OPENAI_KEY },
        },
      },
      noManaged(home),
    );
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({
      env: { ANTHROPIC_API_KEY: KEY },
    });
    expect(JSON.parse(readFileSync(auth, "utf8"))).toEqual({
      OPENAI_API_KEY: OPENAI_KEY,
    });
  });

  it("takes a key out of a settings file with a byte order mark and keeps the mark", async () => {
    const { home, claudeConfigDir } = scratch();
    const settings = join(claudeConfigDir, "settings.json");
    seed(
      settings,
      `${BOM}${JSON.stringify({ env: { ANTHROPIC_API_KEY: KEY } })}\n`,
    );
    const state = await applyModelCredentials(
      {
        home,
        claudeConfigDir,
        harnesses: ["claude-code"],
        helperCommand: HELPER,
      },
      noManaged(home),
    );
    expect(state.taken.map((entry) => entry.credential.secret)).toEqual([KEY]);
    const written = readFileSync(settings, "utf8");
    expect(written.startsWith(BOM)).toBe(true);
    expect(JSON.parse(written.slice(1)).apiKeyHelper).toBe(HELPER);
  });
});
