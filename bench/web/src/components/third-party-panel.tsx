// Imported only into the client graph (via benchmark-dashboard), so no own
// "use client" directive is needed.
import { Card, SectionTitle } from "@/components/atoms";
import { SOURCES } from "@/lib/sources";

const LEADERBOARD_LINKS: readonly { readonly label: string; readonly url: string }[] = [
  { label: "SWE-bench Verified", url: "https://www.swebench.com/#verified" },
  { label: "SWE-bench Lite", url: "https://www.swebench.com/#lite" },
];

/**
 * We deliberately do not reprint a leaderboard snapshot — rankings there
 * change frequently and we can't keep a hardcoded table honest. Instead this
 * links out to the live, third-party-verified standings and cites the two
 * primary sources that define the dataset.
 */
export function ThirdPartyPanel(): React.ReactElement {
  const primarySources = SOURCES.filter((s) => s.kind === "paper");

  return (
    <Card>
      <SectionTitle title="Third-party verified results" />
      <p className="text-sm text-graphite-300">
        We do not reprint the live leaderboard here because it changes frequently — click through for
        the current verified standings, filterable by Open/Scaffold submissions.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {LEADERBOARD_LINKS.map((link) => (
          <a
            key={link.url}
            href={link.url}
            target="_blank"
            rel="noreferrer noopener"
            className="rounded-lg border border-graphite-600 bg-graphite-850 px-3 py-1.5 text-sm font-medium text-graphite-200 hover:border-ember/60 hover:text-graphite-100"
          >
            {link.label} ↗
          </a>
        ))}
      </div>
      <div className="mt-5 flex flex-col gap-2">
        {primarySources.map((source) => (
          <p key={source.url} className="text-sm text-graphite-400">
            <a
              href={source.url}
              target="_blank"
              rel="noreferrer noopener"
              className="text-ember underline underline-offset-2"
            >
              {source.title}
            </a>{" "}
            — {source.published ? `published ${source.published}. ` : ""}
            {source.description}
          </p>
        ))}
      </div>
    </Card>
  );
}
