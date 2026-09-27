/**
 * The sensitive-data screen a call's result passes before it leaves the
 * machine (mcp-studio-spec, Local servers).
 *
 * A local server reads files and systems on the machine, so its result can
 * carry a credential the agent never needs. The screen runs the evidence
 * redactor over every string in the result's content and structuredContent,
 * and replaces each credential it recognises with a redaction marker. The
 * reply reports how many markers the screen added, so the cloud gateway can
 * record that a call's result was cut.
 */
import { redactText } from "../../evidence/redaction";
import type { CallToolResult } from "./wire";

const MARKER = /\[redacted:[a-z_]+\]/g;

function markerCount(text: string): number {
  return text.match(MARKER)?.length ?? 0;
}

export interface ScreenedResult {
  result: CallToolResult;
  /** How many markers the screen added. A marker the server wrote itself is not counted. */
  redactions: number;
}

export function screenResult(result: CallToolResult): ScreenedResult {
  let redactions = 0;

  function screen(value: unknown): unknown {
    if (typeof value === "string") {
      const screened = redactText(value);
      redactions += markerCount(screened) - markerCount(value);
      return screened;
    }
    if (Array.isArray(value)) return (value as unknown[]).map(screen);
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, member]) => [key, screen(member)]));
    }
    return value;
  }

  const screened: CallToolResult = {
    ...result,
    content: result.content.map((item) => screen(item) as CallToolResult["content"][number]),
  };
  if (result.structuredContent !== undefined) {
    screened.structuredContent = screen(result.structuredContent) as Record<string, unknown>;
  }
  return { result: screened, redactions };
}
