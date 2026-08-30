/**
 * Fetch a server's README from its source repo and render it to sanitized HTML.
 * Server-side (Node, no DOM) via the unified pipeline. Only GitHub repos are
 * supported for now (raw.githubusercontent.com); other sources return null.
 * Relative image sources are rewritten to the repo raw base so they resolve.
 *
 * UNBOUNDED: the three candidate fetches carry no timeout and no size cap, and
 * the whole response is buffered with res.text() before parsing. The host is
 * fixed (raw.githubusercontent.com), but the repo path comes from a registry
 * record, so a large README is read fully into memory on the server. Add an
 * AbortSignal and a byte cap before exposing this on a request-path route.
 */
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import type { Repository } from "./types";

interface GithubRef {
  owner: string;
  repo: string;
  subfolder: string;
}

interface HastNode {
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** Parse https://github.com/<owner>/<repo>[.git] into owner/repo. */
function parseGithub(repository: Repository): GithubRef | null {
  if (repository.source !== "github") return null;
  // url is nullish in the schema (the live registry omits it on some records),
  // so guard before .match — a "github" source with no url yields no ref.
  const m = repository.url?.match(/github\.com\/([^/]+)\/([^/#?]+)/i);
  if (!m || !m[1] || !m[2]) return null;
  const owner = m[1];
  const repo = m[2].replace(/\.git$/, "");
  const subfolder = (repository.subfolder ?? "").replace(/^\/+|\/+$/g, "");
  return { owner, repo, subfolder };
}

function rawBase(ref: GithubRef): string {
  const sub = ref.subfolder ? `${ref.subfolder}/` : "";
  return `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/HEAD/${sub}`;
}

/** Minimal rehype plugin: rewrite relative <img src> to absolute raw URLs. */
function rehypeRewriteImages(base: string) {
  // The transformer param is widened to `unknown` so it is assignable to
  // unified's Transformer<Node, Node>; we cast to the hast shape we walk.
  return (tree: unknown) => {
    const visit = (node: HastNode) => {
      if (
        node.tagName === "img" &&
        node.properties &&
        typeof node.properties.src === "string"
      ) {
        const src = node.properties.src;
        if (!/^https?:\/\//i.test(src) && !src.startsWith("data:")) {
          node.properties.src = base + src.replace(/^\.?\//, "");
        }
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(tree as HastNode);
  };
}

const TTL_MS = 24 * 60 * 60 * 1000;

/** True when a cached README is still fresh and should not be refetched. */
export function isReadmeFresh(fetchedAt: Date | null, now: number): boolean {
  return fetchedAt != null && now - fetchedAt.getTime() < TTL_MS;
}

export async function fetchAndRenderReadme(
  repository: Repository,
): Promise<string | null> {
  const ref = parseGithub(repository);
  if (!ref) return null;

  const base = rawBase(ref);
  const candidates = ["README.md", "readme.md", "README.markdown"];
  let markdown: string | null = null;
  for (const file of candidates) {
    const res = await fetch(`${base}${file}`, {
      headers: { accept: "text/plain" },
    });
    if (res.ok) {
      markdown = await res.text();
      break;
    }
  }
  if (markdown == null) return null;

  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeRewriteImages, base)
    .use(rehypeSanitize)
    .use(rehypeStringify)
    .process(markdown);
  return String(file);
}
