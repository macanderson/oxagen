/**
 * `oxagen asset upload <url>` — ingest a binary asset from a public URL into
 * object storage over the org-scoped /v1 API. Thin shell over the asset.upload
 * capability so the CLI stays in parity with the API, MCP, and agent surfaces.
 *
 * With `--conversation <id>` the upload is recorded as a private chat/agent
 * attachment (`source: "user_upload"`) linked to that conversation and servable
 * via the access-controlled /api/v1/assets/:publicId route — otherwise it is a
 * pure public-blob ingest with no DB row.
 */
import { apiPost } from "../lib/api.js";

interface AssetUploadResponse {
  url: string;
  key: string;
  contentType: string;
  bytes: number;
  publicId: string | null;
}

type AssetKind = "avatar" | "image" | "document" | "video";

const KINDS: AssetKind[] = ["avatar", "image", "document", "video"];

export async function handleAssetUpload(
  url: string,
  opts: { kind?: string; filename?: string; conversation?: string; json?: boolean },
): Promise<void> {
  const kind = (opts.kind ?? "image") as AssetKind;
  if (!KINDS.includes(kind)) {
    process.stderr.write(
      `Invalid --kind "${opts.kind}". Use one of: ${KINDS.join(", ")}.\n`,
    );
    process.exit(1);
  }

  const body: Record<string, unknown> = { sourceUrl: url, kind };
  if (opts.filename) body.filename = opts.filename;
  if (opts.conversation) {
    // A conversation attachment implies the user_upload source.
    body.source = "user_upload";
    body.conversationId = opts.conversation;
  }

  const res = await apiPost<AssetUploadResponse>("asset/upload", body);

  if (opts.json) {
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return;
  }

  process.stdout.write(`Uploaded ${kind} (${res.bytes} bytes, ${res.contentType})\n`);
  process.stdout.write(`  key: ${res.key}\n`);
  process.stdout.write(`  url: ${res.url}\n`);
  if (res.publicId) process.stdout.write(`  id:  ${res.publicId}\n`);
}
