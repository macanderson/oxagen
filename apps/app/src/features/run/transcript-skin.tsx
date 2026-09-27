/**
 * Which terminal the Transcript tab draws a run as, and the lines that open
 * and close it (the v3 mockup's `replay.js`). The rows are the same for every
 * skin; `src/ui/transcript-skins.css` gives each its palette and glyphs.
 */
import { useTranslations } from "next-intl";
import type { RunRow } from "@/data/contracts/runs";

/** Claude Code, Codex, Cursor, or stella. */
type Skin = "cc" | "cx" | "cu" | "st";

type Harness = NonNullable<RunRow["harness"]>;

const SKINS: Record<string, Skin> = {
  "claude-code": "cc",
  claude: "cc",
  codex: "cx",
  "openai-codex": "cx",
  cursor: "cu",
  "cursor-agent": "cu",
  stella: "st",
};

/**
 * Each harness's own name, as its terminal prints it. These are product
 * names copied from the harness, so no catalogue translates them.
 */
const TITLE: Record<Skin, string> = {
  cc: "Claude Code",
  cx: ">_ OpenAI Codex",
  cu: "Cursor",
  st: "stella",
};

/** Claude Code's mascot, as its banner draws it. */
const CLAWD = " ▐▛███▜▌\n▝▜█████▛▘\n  ▘▘ ▝▝";

/** stella's session line, as its banner prints it. */
const SESSION = "SESSION ▸";

function skinNamed(value: string | null | undefined): Skin | undefined {
  if (value === null || value === undefined) return undefined;
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/-cli$/, "");
  return SKINS[slug];
}

/**
 * The skin for a run's harness, by its name and then its runtime. A harness
 * with no skin of its own draws as Claude Code.
 */
export function skinOf(harness: Harness | null | undefined): Skin {
  return skinNamed(harness?.name) ?? skinNamed(harness?.runtime) ?? "cc";
}

/** The line a harness prints when its session opens. Cursor prints none. */
export function SkinBanner({
  skin,
  harness,
  model,
  session,
}: {
  skin: Skin;
  harness: Harness | null | undefined;
  model: string | null;
  session: string;
}) {
  const version =
    harness?.version === null || harness?.version === undefined
      ? null
      : `v${harness.version}`;
  switch (skin) {
    case "cc":
      return (
        <div data-testid="tx-banner" className="tx-banner">
          <pre aria-hidden="true" className="tx-clawd">
            {CLAWD}
          </pre>
          <div>
            <b>{TITLE.cc}</b>
            {version === null ? null : (
              <span className="tx-dim"> {version}</span>
            )}
            {model === null ? null : <div className="tx-dim">{model}</div>}
          </div>
        </div>
      );
    case "cx":
      return (
        <div data-testid="tx-banner" className="tx-banner">
          <span>
            <b>{TITLE.cx}</b>
            {version === null ? null : (
              <span className="tx-dim"> ({version})</span>
            )}
          </span>
          {model === null ? null : <span className="tx-dim">{model}</span>}
        </div>
      );
    case "cu":
      return null;
    case "st":
      return (
        <div data-testid="tx-banner" className="tx-banner">
          <span>
            {SESSION} {session}
          </span>
          <b>
            {TITLE.st}
            <i>*</i>
          </b>
        </div>
      );
  }
}

/** The harness's working line, while a live run's next line is on its way. */
export function SkinFoot() {
  const t = useTranslations("run.transcript");
  return (
    <div data-testid="tx-working" className="tx-working">
      <span aria-hidden="true" className="tx-spin" />
      <span className="tx-word">{t("working")}</span>
    </div>
  );
}
