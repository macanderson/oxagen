/**
 * macOS system-clipboard image reader, for Ctrl-V "paste image" in the REPL
 * prompt bar (mirrors Claude Code's paste UX).
 *
 * Terminals only forward TEXT pastes to stdin (as a bracketed-paste chunk) —
 * an image-only clipboard produces no stdin bytes at all, so there is no way
 * to "detect" an image paste from the keystream. Instead, Ctrl-V is a
 * dedicated binding: on that keystroke the REPL asks THIS module to check the
 * clipboard directly and, if it holds an image, save it to a temp PNG.
 *
 * Prefers `pngpaste` (https://github.com/jcsalterego/pngpaste, `brew install
 * pngpaste`) when present — it does exactly this in one step. Falls back to
 * AppleScript (bundled with every Mac) reading the clipboard as PNG or TIFF,
 * then normalizes to PNG via `sips` (also bundled) since vision models expect
 * PNG/JPEG, not TIFF. Every step degrades to `null` on failure — no image on
 * the clipboard, an unsupported platform, or every tool missing — so callers
 * never need a try/catch: a paste that isn't an image is simply not one.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);

/** A pasted image saved to disk, ready to attach to a turn's instruction message. */
export interface PastedImageAttachment {
  /** Absolute path to the saved image file (always PNG — see module docs). */
  path: string;
  /** IANA media type of the saved file. */
  mediaType: string;
}

let tempDirPromise: Promise<string> | null = null;

/** One temp dir per process, lazily created, reused for every pasted image this session. */
function pasteTempDir(): Promise<string> {
  tempDirPromise ??= mkdtemp(join(tmpdir(), "oxagen-paste-"));
  return tempDirPromise;
}

/** True if `cmd` resolves on PATH. */
async function hasCommand(cmd: string): Promise<boolean> {
  try {
    await execFileAsync("which", [cmd]);
    return true;
  } catch {
    return false;
  }
}

/** A file that exists and has at least one byte — the shared "did this actually write an image" check. */
async function isNonEmptyFile(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.size > 0;
  } catch {
    return false;
  }
}

/** `pngpaste <dest>` — writes the clipboard's image straight to PNG; exits non-zero when there is none. */
async function tryPngpaste(destPath: string): Promise<boolean> {
  try {
    await execFileAsync("pngpaste", [destPath]);
  } catch {
    return false;
  }
  return isNonEmptyFile(destPath);
}

/**
 * AppleScript fallback: write the clipboard's image data (PNG, else TIFF) to
 * `destPath` verbatim — format normalization happens separately via `sips`.
 * Returns false (never throws) if the clipboard holds no image.
 */
async function tryOsascriptDump(destPath: string): Promise<boolean> {
  const script = `
set outPath to "${destPath}"
try
  set imgData to (the clipboard as «class PNGf»)
on error
  try
    set imgData to (the clipboard as «class TIFF»)
  on error
    return "none"
  end try
end try
set fileRef to open for access POSIX file outPath with write permission
try
  set eof fileRef to 0
  write imgData to fileRef
end try
close access fileRef
return "ok"
`.trim();
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script]);
    if (stdout.trim() !== "ok") return false;
  } catch {
    return false;
  }
  return isNonEmptyFile(destPath);
}

/** `sips -s format png` — bundled on every Mac; a no-op re-encode if `src` is already PNG. */
async function convertToPng(
  srcPath: string,
  destPath: string,
): Promise<boolean> {
  try {
    await execFileAsync("sips", [
      "-s",
      "format",
      "png",
      srcPath,
      "--out",
      destPath,
    ]);
  } catch {
    return false;
  }
  return isNonEmptyFile(destPath);
}

/**
 * Read the system clipboard's image (if any) and save it as a temp PNG.
 * Returns `null` — never throws — when there's no image on the clipboard,
 * the platform isn't macOS, or every available tool failed.
 */
export async function readClipboardImage(): Promise<PastedImageAttachment | null> {
  if (process.platform !== "darwin") return null; // clipboard-image paste is macOS-only for now

  let dir: string;
  try {
    dir = await pasteTempDir();
  } catch {
    return null;
  }
  const pngPath = join(dir, `image-${randomUUID()}.png`);

  if (await hasCommand("pngpaste")) {
    return (await tryPngpaste(pngPath))
      ? { path: pngPath, mediaType: "image/png" }
      : null;
  }

  // No pngpaste — fall back to AppleScript + sips. Dump to a scratch file first
  // (osascript writes whatever native class it grabbed, PNG or TIFF) then
  // normalize; the scratch file is cleaned up either way.
  const rawPath = join(dir, `image-${randomUUID()}.raw`);
  const dumped = await tryOsascriptDump(rawPath);
  if (!dumped) return null;
  const converted = await convertToPng(rawPath, pngPath);
  await rm(rawPath, { force: true }).catch(() => undefined);
  return converted ? { path: pngPath, mediaType: "image/png" } : null;
}
