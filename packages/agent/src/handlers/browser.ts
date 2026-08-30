// Handlers for the `browser.*` capabilities.
//
// Every browser action is a one-line command sent to `browserctl` (baked into
// the durable `agent` sandbox image) via agent.sandbox.exec's `stdin` channel —
// no shell-escaping, no new runner endpoints. A long-running Playwright daemon
// inside the sandbox holds ONE live page, so state is shared across calls: a
// fill in one call persists to a submit in the next. The browser runs in the
// SAME sandbox as the app under test, so it can hit the app on localhost.
import { storage, deriveAssetKey } from "@oxagen/storage";
import type {
  BrowserNavigateInput,
  BrowserNavigateOutput,
} from "@oxagen/oxagen/contracts/browser.navigate";
import type {
  BrowserScreenshotInput,
  BrowserScreenshotOutput,
} from "@oxagen/oxagen/contracts/browser.screenshot";
import type {
  BrowserFillInput,
  BrowserFillOutput,
} from "@oxagen/oxagen/contracts/browser.fill";
import type {
  BrowserSubmitInput,
  BrowserSubmitOutput,
} from "@oxagen/oxagen/contracts/browser.submit";
import type {
  BrowserClickInput,
  BrowserClickOutput,
} from "@oxagen/oxagen/contracts/browser.click";
import type {
  BrowserRefreshInput,
  BrowserRefreshOutput,
} from "@oxagen/oxagen/contracts/browser.refresh";
import type {
  BrowserReadInput,
  BrowserReadOutput,
} from "@oxagen/oxagen/contracts/browser.read";
import type { CapabilityContext } from "../types";
import {
  requireDurableDriverForRow,
  getSessionByPublicId,
  touchSession,
  SandboxSessionNotFoundError,
} from "./_sandbox-session";

export class BrowserDriveError extends Error {
  readonly code = "browser_drive_failed";
  constructor(message: string) {
    super(message);
    this.name = "BrowserDriveError";
  }
}

interface BrowserCommand {
  op:
    | "navigate"
    | "screenshot"
    | "fill"
    | "submit"
    | "click"
    | "refresh"
    | "read";
  [key: string]: unknown;
}

/**
 * Drive the durable session's browser with one `browserctl` command and return
 * its parsed JSON result. Throws BrowserDriveError on a reaped sandbox, a
 * non-JSON response, or a daemon-reported failure.
 */
async function driveBrowser(
  ctx: CapabilityContext,
  sessionId: string,
  command: BrowserCommand,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const row = await getSessionByPublicId(ctx, sessionId);
  if (!row || row.status === "stopped" || row.status === "gone") {
    throw new SandboxSessionNotFoundError(sessionId);
  }
  // Resolve the driver from the SESSION's own provider (the row's `driver`
  // column), not the deployment default — the sandboxId below is only valid on
  // the provider that created it. Mirrors agent.sandbox.exec / sandbox_file.*.
  const driver = requireDurableDriverForRow(row.driver);

  const result = await driver.execInSession({
    sandboxId: row.sandboxId,
    command: "browserctl",
    stdin: JSON.stringify(command),
    timeoutMs,
  });

  if (result.gone) {
    throw new BrowserDriveError(
      `Sandbox session "${sessionId}" was reaped — re-run agent.sandbox.start, then browser.navigate to start a fresh browser.`,
    );
  }

  const parsed = parseBrowserStdout(
    result.stdout,
    result.stderr,
    result.exitCode,
  );
  await touchSession(ctx, row.id);
  return parsed;
}

/** browserctl prints exactly one JSON line to stdout; tolerate trailing logs. */
function parseBrowserStdout(
  stdout: string,
  stderr: string,
  exitCode: number,
): Record<string, unknown> {
  const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new BrowserDriveError(
      `browserctl returned a non-JSON response (exit ${exitCode}): ${(stderr || stdout).slice(0, 500)}`,
    );
  }
  if (parsed.ok === false || parsed.error) {
    throw new BrowserDriveError(
      String(parsed.error ?? "browser command failed"),
    );
  }
  return parsed;
}

export async function browserNavigateHandler(
  input: BrowserNavigateInput,
  ctx: CapabilityContext,
): Promise<BrowserNavigateOutput> {
  const out = await driveBrowser(
    ctx,
    input.sessionId,
    { op: "navigate", url: input.url },
    input.timeoutMs,
  );
  return { url: String(out.url ?? input.url), title: String(out.title ?? "") };
}

export async function browserScreenshotHandler(
  input: BrowserScreenshotInput,
  ctx: CapabilityContext,
): Promise<BrowserScreenshotOutput> {
  const out = await driveBrowser(
    ctx,
    input.sessionId,
    { op: "screenshot", selector: input.selector, full: input.fullPage },
    input.timeoutMs,
  );
  const base64 = String(out.base64 ?? "");
  if (!base64)
    throw new BrowserDriveError("browser.screenshot returned no image data");
  const bytes = Buffer.from(base64, "base64");

  // Store as a PRIVATE workspace asset — screenshots can show sensitive UI, so
  // bytes are served through the authenticated adapter, never a public CDN URL.
  const key = deriveAssetKey("image", ctx.workspaceId, "png");
  const put = await storage().put({
    key,
    body: new Uint8Array(bytes),
    contentType: "image/png",
    access: "private",
  });

  return {
    key: put.key,
    url: put.url,
    width: Number(out.width ?? 0),
    height: Number(out.height ?? 0),
    bytes: put.bytes,
  };
}

export async function browserFillHandler(
  input: BrowserFillInput,
  ctx: CapabilityContext,
): Promise<BrowserFillOutput> {
  await driveBrowser(
    ctx,
    input.sessionId,
    { op: "fill", selector: input.selector, value: input.value },
    input.timeoutMs,
  );
  return { ok: true };
}

export async function browserSubmitHandler(
  input: BrowserSubmitInput,
  ctx: CapabilityContext,
): Promise<BrowserSubmitOutput> {
  const out = await driveBrowser(
    ctx,
    input.sessionId,
    { op: "submit", selector: input.selector },
    input.timeoutMs,
  );
  return { ok: true, url: String(out.url ?? "") };
}

export async function browserClickHandler(
  input: BrowserClickInput,
  ctx: CapabilityContext,
): Promise<BrowserClickOutput> {
  const out = await driveBrowser(
    ctx,
    input.sessionId,
    { op: "click", selector: input.selector },
    input.timeoutMs,
  );
  return { ok: true, url: String(out.url ?? "") };
}

export async function browserRefreshHandler(
  input: BrowserRefreshInput,
  ctx: CapabilityContext,
): Promise<BrowserRefreshOutput> {
  const out = await driveBrowser(
    ctx,
    input.sessionId,
    { op: "refresh" },
    input.timeoutMs,
  );
  return { ok: true, url: String(out.url ?? "") };
}

export async function browserReadHandler(
  input: BrowserReadInput,
  ctx: CapabilityContext,
): Promise<BrowserReadOutput> {
  const out = await driveBrowser(
    ctx,
    input.sessionId,
    { op: "read", selector: input.selector },
    input.timeoutMs,
  );
  return { text: String(out.text ?? "") };
}
