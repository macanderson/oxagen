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
  // The MCP Registry API rejects limit > 100 with HTTP 422; clamp defensively so
  // a larger caller value can never drop the entire registry fetch.
  if (opts.limit) params.set("limit", String(Math.min(opts.limit, 100)));
  if (opts.search) params.set("search", opts.search);
  if (opts.updatedSince) params.set("updated_since", opts.updatedSince);
  const qs = params.toString();
  const url = joinUrl(baseUrl, `/v0.1/servers${qs ? `?${qs}` : ""}`);

  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`registry list failed: ${res.status} ${await res.text()}`);
  }
  const raw = await res.json();
  const parsed = listServersResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `registry list response failed validation: ${parsed.error.message}`,
    );
  }
  return {
    servers: parsed.data.servers,
    nextCursor: parsed.data.metadata?.nextCursor,
  };
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
  const raw = await res.json();
  const parsed = serverResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `registry get response failed validation: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}
