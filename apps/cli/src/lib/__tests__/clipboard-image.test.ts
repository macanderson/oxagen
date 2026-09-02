/**
 * Unit tests for lib/clipboard-image.ts.
 *
 * `readClipboardImage` must NEVER throw — it degrades to `null` at every
 * failure point (wrong platform, no tool on PATH, a tool ran but found no
 * image). `node:child_process` is mocked so no real subprocess is spawned and
 * the tests run identically off macOS.
 *
 * We deliberately only assert the FAILURE/degrade paths here rather than
 * mocking a "success" stdout value: `execFile`'s real multi-value callback is
 * promisified via Node's own `execFile[util.promisify.custom]`, which a plain
 * mock function doesn't carry — faithfully mocking a *successful* `{ stdout,
 * stderr }` resolution would test the mock's shape, not this module's logic.
 * The failure paths below don't depend on that shape (a promisified rejection
 * behaves identically either way), and the success path — token inserted,
 * path stored, attached on submit — is covered end-to-end at the PromptInput
 * layer via its injectable `readClipboardImage` prop (prompt-input-paste.test.tsx).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
import { readClipboardImage } from "../clipboard-image.js";

type ExecFileCallback = (
  error: Error | null,
  stdout?: string,
  stderr?: string,
) => void;
const mockExecFile = vi.mocked(execFile);

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

beforeEach(() => {
  mockExecFile.mockReset();
});

describe("readClipboardImage — platform guard", () => {
  it("resolves null on a non-macOS platform without spawning anything", async () => {
    setPlatform("linux");
    const result = await readClipboardImage();
    expect(result).toBeNull();
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

describe("readClipboardImage — graceful degrade on macOS", () => {
  it("resolves null (never throws) when every tool is unavailable", async () => {
    setPlatform("darwin");
    // Every execFile call (which pngpaste, pngpaste itself, which osascript,
    // osascript itself) fails — simulating a machine with none of these tools.
    (
      mockExecFile as unknown as {
        mockImplementation: (fn: (...args: unknown[]) => void) => void;
      }
    ).mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as ExecFileCallback;
      cb(new Error("ENOENT: command not found"));
    });

    await expect(readClipboardImage()).resolves.toBeNull();
  });

  it("resolves null when pngpaste is present but the clipboard has no image", async () => {
    setPlatform("darwin");
    (
      mockExecFile as unknown as {
        mockImplementation: (fn: (...args: unknown[]) => void) => void;
      }
    ).mockImplementation((...args: unknown[]) => {
      const file = args[0] as string;
      const cb = args[args.length - 1] as ExecFileCallback;
      if (file === "which") {
        // `which pngpaste` succeeds — the tool is on PATH.
        cb(null, "/usr/local/bin/pngpaste", "");
        return;
      }
      // `pngpaste <dest>` itself "succeeds" (no error) but — because this is
      // a mock — never actually writes a file, so the dest path stays
      // missing. The module's own isNonEmptyFile check (a real fs.stat)
      // then correctly reports "no image was written".
      cb(null, "", "");
    });

    await expect(readClipboardImage()).resolves.toBeNull();
  });
});
