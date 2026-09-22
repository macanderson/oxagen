import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CredentialStore,
  credentialPrefix,
  openCredentialStore,
} from "./credential-store";

const SECRET = "sk-ant-api03-FAKE-IN-CUSTODY-0000000000";
const NOW = Date.parse("2026-09-22T12:00:00.000Z");

let dir: string;
let store: CredentialStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "credential-store-"));
  store = openCredentialStore({
    file: join(dir, "credentials.json"),
    key: join(dir, "credentials.key"),
  });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the custody store", () => {
  it("seals a secret so nothing on disk holds it in the clear, and reads it back", () => {
    const custody = store.take(
      "anthropic",
      { kind: "api_key", secret: SECRET },
      "claude-code:settings.env",
      NOW,
    );
    expect(custody).toEqual({
      provider: "anthropic",
      kind: "api_key",
      source: "claude-code:settings.env",
      taken_at: "2026-09-22T12:00:00.000Z",
      prefix: "sk-ant-a…",
    });
    // No digest of the secret leaves the store either: a hash of a key is
    // an oracle, and `status` is what `tacho status` repeats.
    expect(JSON.stringify(store.status())).not.toContain("sha256");
    for (const name of readdirSync(dir)) {
      const text = readFileSync(join(dir, name), "utf8");
      expect(text).not.toContain(SECRET);
      expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    }
    expect(store.read("anthropic")).toEqual({
      kind: "api_key",
      secret: SECRET,
    });
    expect(store.read("openai")).toBeUndefined();
    expect(store.status()).toEqual([custody]);
    expect(JSON.stringify(store.status())).not.toContain(SECRET);
  });

  it("is read fresh on every call, so a second handle sees what the first took", () => {
    const other = openCredentialStore({
      file: join(dir, "credentials.json"),
      key: join(dir, "credentials.key"),
    });
    store.take(
      "openai",
      { kind: "bearer", secret: "sk-proj-FAKE" },
      "codex:auth.json",
      NOW,
    );
    expect(other.read("openai")).toEqual({
      kind: "bearer",
      secret: "sk-proj-FAKE",
    });
    store.take(
      "openai",
      { kind: "bearer", secret: "sk-proj-NEWER" },
      "enroll:env",
      NOW + 1,
    );
    expect(other.read("openai")?.secret).toBe("sk-proj-NEWER");
    expect(other.status()).toHaveLength(1);
  });

  it("releases a secret for the file it goes back into, and removes the file when empty", () => {
    store.take(
      "anthropic",
      { kind: "api_key", secret: SECRET },
      "enroll:env",
      NOW,
    );
    expect(store.release("anthropic")).toEqual({
      kind: "api_key",
      secret: SECRET,
    });
    expect(store.release("anthropic")).toBeUndefined();
    expect(existsSync(join(dir, "credentials.json"))).toBe(false);
    expect(store.status()).toEqual([]);
  });

  it("refuses an empty secret", () => {
    expect(() =>
      store.take(
        "anthropic",
        { kind: "api_key", secret: "  " },
        "enroll:env",
        NOW,
      ),
    ).toThrow(/empty/);
  });

  it("cannot be opened with another key, or without its own", () => {
    store.take(
      "anthropic",
      { kind: "api_key", secret: SECRET },
      "enroll:env",
      NOW,
    );
    writeFileSync(join(dir, "credentials.key"), `${"ab".repeat(32)}\n`);
    expect(() => store.read("anthropic")).toThrow();
  });

  it("refuses a key file that is not a key rather than minting a new one over sealed data", () => {
    store.take(
      "anthropic",
      { kind: "api_key", secret: SECRET },
      "enroll:env",
      NOW,
    );
    writeFileSync(join(dir, "credentials.key"), "not a key\n");
    expect(() => store.read("anthropic")).toThrow(/32-byte key/);
    expect(() =>
      store.take(
        "openai",
        { kind: "bearer", secret: "sk-proj-FAKE" },
        "enroll:env",
        NOW,
      ),
    ).toThrow(/32-byte key/);
    // Nothing was overwritten: the damaged key and the sealed file both
    // stand for a person to look at, and the metadata still reads.
    expect(readFileSync(join(dir, "credentials.key"), "utf8")).toBe(
      "not a key\n",
    );
    expect(store.status().map((c) => c.provider)).toEqual(["anthropic"]);
  });

  it("does not open an entry relabelled for another provider", () => {
    store.take(
      "anthropic",
      { kind: "api_key", secret: SECRET },
      "enroll:env",
      NOW,
    );
    const file = join(dir, "credentials.json");
    const edited = JSON.parse(readFileSync(file, "utf8")) as {
      entries: Array<{ provider: string }>;
    };
    edited.entries[0]!.provider = "openai";
    writeFileSync(file, JSON.stringify(edited));
    // The seal binds the provider: a key taken for Anthropic cannot be made
    // to answer an OpenAI run token by editing one word in the file.
    expect(() => store.read("openai")).toThrow();
    expect(store.read("anthropic")).toBeUndefined();
    expect(store.status().map((c) => c.provider)).toEqual(["openai"]);
  });

  it("releases one provider and keeps the other", () => {
    store.take(
      "anthropic",
      { kind: "api_key", secret: SECRET },
      "claude-code:settings.env",
      NOW,
    );
    store.take(
      "openai",
      { kind: "bearer", secret: "sk-proj-FAKE" },
      "codex:auth.json",
      NOW,
    );
    expect(store.release("anthropic")?.secret).toBe(SECRET);
    expect(existsSync(join(dir, "credentials.json"))).toBe(true);
    expect(store.status().map((c) => c.provider)).toEqual(["openai"]);
    expect(store.read("openai")?.secret).toBe("sk-proj-FAKE");
    expect(store.read("anthropic")).toBeUndefined();
  });

  it("shreds: the key is overwritten and both files are gone, so custody is over", () => {
    store.take(
      "anthropic",
      { kind: "api_key", secret: SECRET },
      "enroll:env",
      NOW,
    );
    store.shred();
    expect(readdirSync(dir)).toEqual([]);
    expect(store.status()).toEqual([]);
    // Shredding twice is fine, and a fresh take starts a new key.
    store.shred();
    store.take(
      "openai",
      { kind: "bearer", secret: "sk-proj-FAKE" },
      "enroll:env",
      NOW,
    );
    expect(store.read("openai")?.secret).toBe("sk-proj-FAKE");
  });

  it("refuses a file it cannot read as a store rather than guessing", () => {
    writeFileSync(join(dir, "credentials.json"), '{"schema":"something.else"}');
    expect(() => store.status()).toThrow(/not a credential store/);
    expect(() => store.read("anthropic")).toThrow(/not a credential store/);
    // A file that is not JSON at all throws too; every reader of the store
    // treats that as a fault, never as an empty store.
    writeFileSync(join(dir, "credentials.json"), "{ not json");
    expect(() => store.status()).toThrow();
  });

  it("shows a key the way a console does", () => {
    expect(credentialPrefix("sk-ant-api03-abcdef")).toBe("sk-ant-a…");
    expect(credentialPrefix("short")).toBe("s…");
    expect(credentialPrefix("abc")).toBe("");
  });
});
