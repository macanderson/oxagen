// The cells a tool version is drawn with wherever it appears: the Tools table,
// a provider's drill-down, the import dialog. Each prints what the record
// carries and nothing stronger (mockup `tools.md`: "Every badge that describes
// trust shows the recorded value and nothing stronger").
import { useTranslations } from "next-intl";
import { MONEY_TAG, type ToolVersion } from "@/data/contracts/tools";
import { mono } from "@/ui/control-styles";
import { Chip, NotCarried, StateDot, type Tone } from "./parts";
import { type ToolNameStyle, versionLabel } from "./view";

const GATE_TONE = {
  open: "ok",
  killed_version: "deny",
  killed_server: "deny",
  killed_class: "deny",
} as const satisfies Record<ToolVersion["gate"]["kind"], Tone>;

const RISK_TONE = {
  low: "neutral",
  medium: "neutral",
  high: "warn",
  critical: "deny",
} as const satisfies Record<ToolVersion["riskGrade"], Tone>;

/** The version's identity everywhere: `name@version`, label over the API name or the other way round. */
export function ToolName({
  version,
  names,
}: {
  version: ToolVersion;
  names: ToolNameStyle;
}) {
  const api = versionLabel(version);
  const primary = names === "api" ? api : version.name;
  const secondary = names === "api" ? version.name : api;
  return (
    <span className="flex flex-col gap-0.5">
      <span
        className={`font-medium text-foreground ${names === "api" ? mono : ""}`}
      >
        {primary}
      </span>
      <span
        className={`text-xs text-muted-foreground ${names === "api" ? "" : mono}`}
      >
        {secondary}
      </span>
    </span>
  );
}

/** Risk grade over the side effect, as the classification records them. */
export function HazardCell({ version }: { version: ToolVersion }) {
  const t = useTranslations("tools.registry");
  return (
    <span className="flex flex-col gap-1">
      <StateDot
        tone={RISK_TONE[version.riskGrade]}
        name={version.riskGrade}
        label={t(`risk.${version.riskGrade}`)}
      />
      {version.classification === null ? null : (
        <span className="text-xs text-muted-foreground">
          {t(`sideEffect.${version.classification.sideEffect}`)}
        </span>
      )}
    </span>
  );
}

/** The kill switch that stops the version today, or open when none does. */
export function GateDot({ version }: { version: ToolVersion }) {
  const gates = useTranslations("tools.gate");
  return (
    <StateDot
      tone={GATE_TONE[version.gate.kind]}
      name={version.gate.kind}
      label={gates(version.gate.kind)}
    />
  );
}

/** The consequence tags the classification records: the registry's category today. */
export function CategoryCell({ version }: { version: ToolVersion }) {
  const t = useTranslations("tools.registry");
  if (version.classification === null) {
    return (
      <span className="text-xs text-muted-foreground">{t("unclassified")}</span>
    );
  }
  if (version.classification.consequenceTags.length === 0) {
    return <span className="text-xs text-muted-foreground">{t("noTags")}</span>;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {version.classification.consequenceTags.map((tag) => (
        <Chip key={tag}>{tag}</Chip>
      ))}
    </span>
  );
}

/**
 * The money tag when the classification records it. The classified half is
 * all this record carries, and the filter and a class switch also match the
 * tags declared where the version was published, so this can confirm a money
 * tag and never rule one out: a governance table must not print "none" over a
 * question it was not given the data to answer.
 */
export function FinancialCell({ version }: { version: ToolVersion }) {
  const financial =
    version.classification?.consequenceTags.includes(MONEY_TAG) === true;
  return financial ? (
    <StateDot tone="deny" name="financial" label={MONEY_TAG} />
  ) : (
    <NotCarried />
  );
}
