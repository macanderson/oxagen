/**
 * Typed client for the MCP Registry OpenAPI (https://registry.modelcontextprotocol.io).
 * Discovery endpoints are unauthenticated; responses are Zod-validated. Cursor
 * pagination: follow metadata.nextCursor until absent.
 */
import {
  listServersResponseSchema,
  serverResponseSchema,
  type ServerResponse,
} from "./types";

export interface ListServersOptions {
  cursor?: string;
  limit?: number;
  search?: string;
  /** RFC3339 timestamp — incremental sync filter. */
  updatedSince?: string;
}

export interface ListServersResult {
  servers: ServerResponse[];
  nextCursor: string | undefined;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

export async function listServers(
  baseUrl: string,
  opts: ListServersOptions,
): Promise<ListServersResult> {
  const params = new URLSearchParams();
  if (opts.cursor) params.set("cursor", opts.cursor);
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.search) params.set("search", opts.search);
  if (opts.updatedSince) params.set("updated_since", opts.updatedSince);
  const qs = params.toString();
  const url = joinUrl(baseUrl, `/v0.1/servers${qs ? `?${qs}` : ""}`);

  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`registry list failed: ${res.status} ${await res.text()}`);
  }
  const parsed = listServersResponseSchema.parse(await res.json());
  return { servers: parsed.servers, nextCursor: parsed.metadata?.nextCursor };
}

export async function getServerVersion(
  baseUrl: string,
  name: string,
  version: string,
): Promise<ServerResponse> {
  const url = joinUrl(
    baseUrl,
    `/v0.1/servers/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`,
  );
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`registry get failed: ${res.status} ${await res.text()}`);
  }
  return serverResponseSchema.parse(await res.json());
}
