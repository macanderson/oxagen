import { source } from "@/lib/source";

/**
 * Every release page under `content/docs/releases/`, newest first, for the
 * section's index. Read from the docs source rather than a hand-kept list so
 * a page written by `tools/scripts/release.ts` appears here on its own.
 */
export interface ReleaseEntry {
  version: string;
  url: string;
  date: string | null;
  summary: string | null;
}

export function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function listReleases(
  pages: ReadonlyArray<{
    slugs: string[];
    url: string;
    data: { description?: string; date?: string };
  }>,
): ReleaseEntry[] {
  return pages
    .filter(
      (p) =>
        p.slugs.length === 2 &&
        p.slugs[0] === "releases" &&
        /^v\d+\.\d+\.\d+$/.test(p.slugs[1] ?? ""),
    )
    .map((p) => ({
      version: (p.slugs[1] ?? "").slice(1),
      url: p.url,
      date: p.data.date ?? null,
      summary: p.data.description ?? null,
    }))
    .sort((a, b) => compareVersionsDesc(a.version, b.version));
}

export function ReleaseList() {
  const releases = listReleases(source.getPages());
  if (releases.length === 0) {
    return (
      <p className="text-fd-muted-foreground">No releases are listed yet.</p>
    );
  }
  return (
    <ol className="not-prose m-0 flex list-none flex-col p-0 divide-y divide-fd-border border-y border-fd-border">
      {releases.map((r, i) => (
        <li
          key={r.version}
          className="grid gap-x-6 gap-y-1 py-4 sm:grid-cols-[9rem_1fr]"
        >
          <div className="flex flex-col">
            <a
              className="font-mono text-base font-medium text-fd-foreground underline decoration-fd-border underline-offset-4 hover:decoration-fd-foreground"
              href={r.url}
            >
              v{r.version}
            </a>
            <span className="font-mono text-xs text-fd-muted-foreground">
              {r.date ?? ""}
              {i === 0 ? (r.date ? " · current" : "current") : ""}
            </span>
          </div>
          <p className="m-0 text-sm text-fd-foreground">{r.summary ?? ""}</p>
        </li>
      ))}
    </ol>
  );
}
