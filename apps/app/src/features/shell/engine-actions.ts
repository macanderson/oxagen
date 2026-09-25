"use server";
// Whether stella's engine can take a turn, read on demand (#3227): when the
// assistant flyout opens, when the window takes focus again, and from the
// flyout's Check again control (use-engine-health.ts). It is never read when a
// layout renders, because the probe behind it tries the engine three times with
// a two-second timeout each, and a workspace page must not wait up to seven
// seconds on an engine that is down.
//
// It reads the `shell.assistantEngine` port rather than calling the kernel, so
// the answer is checked against the port's view model at the data boundary,
// and the port is where the engine's host and port are left on the server
// (ADR-167 names this module and why).
import type { AssistantEngine } from "@/data/contracts/shell";
import { dataSource } from "@/data/source";
import type { ActionResult } from "@/server/kernel";
import { readToActionResult } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

/**
 * The engine's state for the workspace the person is standing in. A refusal
 * keeps its reason, and the flyout treats any refusal as "not known" rather
 * than "down": a read that failed says nothing about the engine.
 */
export async function readAssistantEngine(
  org: string,
  ws: string,
): Promise<ActionResult<AssistantEngine>> {
  const ctx = await requireViewer(org, ws);
  return readToActionResult(await dataSource().shell.assistantEngine(ctx));
}
