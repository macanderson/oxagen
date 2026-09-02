"use client";
import * as React from "react";
import { Globe, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { safeHref } from "@/lib/safe-url";
import { TruncatedText } from "@/components/ui/truncated-text";

/**
 * web-search-card — renders web.search output: a ranked list of results with
 * title, source domain, snippet, and an external link.
 *
 * componentId: "web-search-card"
 */

interface SearchResult {
  title: string;
  url: string;
  content: string;
  score?: number;
  publishedDate?: string;
}

interface WebSearchCardProps {
  capability?: string;
  output?: unknown;
}

const MAX_RESULTS = 12;

function readResults(output: unknown): {
  results: SearchResult[];
  total: number;
} {
  if (typeof output !== "object" || output === null)
    return { results: [], total: 0 };
  const o = output as Record<string, unknown>;
  const raw = Array.isArray(o.results) ? o.results : [];
  const results: SearchResult[] = [];
  for (const r of raw) {
    if (typeof r !== "object" || r === null) continue;
    const rr = r as Record<string, unknown>;
    if (typeof rr.url !== "string" || typeof rr.title !== "string") continue;
    results.push({
      title: rr.title,
      url: rr.url,
      content: typeof rr.content === "string" ? rr.content : "",
      score: typeof rr.score === "number" ? rr.score : undefined,
      publishedDate:
        typeof rr.publishedDate === "string" ? rr.publishedDate : undefined,
    });
  }
  const total =
    typeof o.totalResults === "number" ? o.totalResults : results.length;
  return { results, total };
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export default function WebSearchCard(
  props: WebSearchCardProps,
): React.ReactElement {
  const { results, total } = readResults(props.output);
  const shown = results.slice(0, MAX_RESULTS);

  return (
    <div
      className="my-2 overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm"
      data-component="web-search-card"
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <Globe className="size-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="text-sm font-semibold">
          Web search · {total} result{total === 1 ? "" : "s"}
        </span>
      </div>

      {shown.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">No results.</p>
      ) : (
        <ul className="divide-y divide-border/60">
          {shown.map((r, i) => {
            // r.url is untrusted web-search/model output: validate the scheme
            // before rendering a link. Unsafe → show the title as plain text.
            const safe = safeHref(r.url);
            return (
              <li key={`${r.url}:${i}`} className="px-4 py-3">
                {safe ? (
                  <a
                    href={safe}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(
                      "inline-flex items-start gap-1 text-sm font-medium text-primary",
                      "hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    )}
                  >
                    <span className="min-w-0">{r.title}</span>
                    <ExternalLink
                      className="mt-0.5 size-3 shrink-0 opacity-70"
                      aria-hidden="true"
                    />
                  </a>
                ) : (
                  <span className="text-sm font-medium text-foreground">
                    {r.title}
                  </span>
                )}
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {domainOf(r.url)}
                </p>
                {r.content ? (
                  <p className="mt-1 text-xs text-foreground/80">
                    <TruncatedText text={r.content} lines={3} />
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {results.length > MAX_RESULTS ? (
        <p className="border-t border-border/60 px-4 py-2 text-xs text-muted-foreground">
          Showing {MAX_RESULTS} of {results.length}.
        </p>
      ) : null}
    </div>
  );
}
