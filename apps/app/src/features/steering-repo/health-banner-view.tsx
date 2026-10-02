"use client";
// The banner a workspace page shows while its steering repo is unhealthy
// (steering-repo-spec, Settings drift). It names the state, says that Oxagen
// merges and publishes nothing until the repository is repaired, and lists
// each prescribed setting that differs. An owner or admin gets the way out:
// Repair settings for drift, Re-authorize for a lost grant, and word of the
// steering PR that reverts an unmerged commit on main.
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import type { SafePath } from "@/shared/safe-path";
import { buttonSecondary, mono } from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { useFormatter } from "@/ui/formatter";
import { useNavigate } from "@/ui/navigation";
import { cell, headCell } from "@/ui/table";
import { repairSteeringRepo } from "./actions";
import { UNANSWERED, useSteeringRepoFailure } from "./failure";
import { ReauthorizeLink } from "./reauthorize";
import type {
  RepoHealth,
  SettingsDifferenceView,
  SteeringRepoView,
} from "./types";

const REPAIR_CAPABILITY = "repair_steering_repo";

const COLUMNS = ["setting", "expected", "actual", "changed"] as const;

type UnhealthyRepo = Exclude<RepoHealth, "healthy">;

function ChangedCell({ difference }: { difference: SettingsDifferenceView }) {
  const t = useTranslations("repositories.steeringRepo.banner");
  const format = useFormatter();
  const at =
    difference.changedAt === null
      ? null
      : format.dateTime(new Date(difference.changedAt), {
          dateStyle: "medium",
          timeStyle: "short",
        });
  if (difference.changedBy !== null && at !== null)
    return <>{t("changedByAt", { name: difference.changedBy, at })}</>;
  if (difference.changedBy !== null) return <>{difference.changedBy}</>;
  if (at !== null) return <>{at}</>;
  return <span className="text-muted-foreground">{t("changedUnknown")}</span>;
}

function Differences({
  differences,
}: {
  differences: readonly SettingsDifferenceView[];
}) {
  const t = useTranslations("repositories.steeringRepo.banner");
  return (
    <div className="min-w-0 overflow-x-auto">
      <table
        aria-label={t("differencesLabel")}
        data-testid="steering-repo-differences"
        className="w-full border-collapse text-sm"
      >
        <thead>
          <tr className="border-b border-border">
            {COLUMNS.map((column) => (
              <th key={column} scope="col" className={`${headCell} text-left`}>
                {t(`columns.${column}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {differences.map((difference) => (
            <tr
              key={difference.setting}
              data-setting={difference.setting}
              className="border-b border-border last:border-b-0"
            >
              <td className={cell}>
                <code className={mono}>{difference.setting}</code>
              </td>
              <td className={cell}>
                <code className={mono}>{difference.expected}</code>
              </td>
              <td className={cell}>
                <code className={mono}>{difference.actual}</code>
              </td>
              <td className={cell}>
                <ChangedCell difference={difference} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SteeringRepoHealthBannerView({
  org,
  ws,
  provider,
  health,
  differences,
  canAct,
  returnTo,
}: {
  org: string;
  ws: string;
  provider: SteeringRepoView["provider"];
  health: UnhealthyRepo;
  differences: readonly SettingsDifferenceView[];
  /** An owner or admin: the repair is theirs. */
  canAct: boolean;
  /** Where GitHub sends the person back to after Re-authorize. */
  returnTo: SafePath;
}) {
  const t = useTranslations("repositories.steeringRepo.banner");
  const failureText = useSteeringRepoFailure();
  const navigate = useNavigate();
  const headingId = useId();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function repair() {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await repairSteeringRepo(org, ws);
      if (result.ok) navigate.refresh();
      else setFailure(failureText(result, REPAIR_CAPABILITY));
    } catch {
      setFailure(failureText(UNANSWERED, REPAIR_CAPABILITY));
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      aria-labelledby={headingId}
      data-testid="steering-repo-health-banner"
      data-health={health}
      data-provider={provider ?? "github"}
      className="mx-auto flex w-full max-w-6xl flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-foreground"
    >
      <h2 id={headingId} className="text-sm font-semibold">
        {t(`heading.${health}`)}
      </h2>
      <p>{t("body")}</p>
      {differences.length > 0 ? (
        <Differences differences={differences} />
      ) : null}
      {canAct && health === "drifted" ? (
        <div className="flex flex-col items-start gap-2">
          <button
            type="button"
            data-testid="steering-repo-repair"
            data-touch-target=""
            disabled={pending}
            className={buttonSecondary}
            onClick={() => {
              void repair();
            }}
          >
            {pending ? t("repairing") : t("repair")}
          </button>
          {failure === null ? null : (
            <FormAlert testId="steering-repo-repair-failure">
              {failure}
            </FormAlert>
          )}
        </div>
      ) : null}
      {canAct && health === "disconnected" ? (
        <div>
          <ReauthorizeLink
            org={org}
            provider={provider}
            returnTo={returnTo}
            testId="steering-repo-banner-reauthorize"
          />
        </div>
      ) : null}
      {canAct && health === "diverged" ? (
        <p data-testid="steering-repo-reverting">{t("reverting")}</p>
      ) : null}
    </section>
  );
}
