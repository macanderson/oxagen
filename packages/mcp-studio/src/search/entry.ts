// entry.ts: the one line a search-mode server's tool is ranked by (lane M15;
// mcp-studio-spec, Large servers; ADR-217).
//
// A search entry is the tool's name after the server's prefix and the first
// sentence of its description. Publish embeds that line, and search ranks
// the same line, so both sides build it here. Its sha256 keys the stored
// vector: an entry whose line did not change is never embedded again.
import { createHash } from "node:crypto";
import type { ManifestServer, ManifestTool, ToolManifest } from "../contract/manifest";

/** The first sentence of a description, on one line. */
export function firstSentence(description: string | undefined): string {
  const text = (description ?? "").trim().replace(/\s+/g, " ");
  const match = /^(.*?[.!?])(?:\s|$)/.exec(text);
  return match?.[1] ?? text;
}

/** The tool's name after the server's prefix: create_refund for billing__create_refund. */
export function shortName(server: Pick<ManifestServer, "name">, tool: Pick<ManifestTool, "name">): string {
  return tool.name.slice(server.name.length + 2);
}

/** The line that is embedded for one tool: its short name, then its summary when it has one. */
export function entryText(short: string, summary: string): string {
  return summary === "" ? short : `${short}: ${summary}`;
}

/** The sha256 of an entry's line, in lowercase hex. */
export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The search entry line of every tool on the manifest's search-mode servers. */
export function searchEntryTexts(manifest: ToolManifest): string[] {
  const texts: string[] = [];
  for (const server of manifest.servers) {
    if (server.exposure.mode !== "search") continue;
    for (const tool of Object.values(server.tools)) {
      texts.push(entryText(shortName(server, tool), firstSentence(tool.definition.description)));
    }
  }
  return texts;
}
