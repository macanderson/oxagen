// The Skills page's one section in each state (#3098): the inventory of skill
// names the window's sessions reported, the window with nothing reported, the
// skeleton while the read runs, and a refused, pending or failed read. Each
// replaces the page body under the header and never the shell. A row prints
// what the record carries — the name, the sessions that reported it, their
// harnesses and when it was last seen — and nothing the record does not.
import { GraduationCap } from "lucide-react";
import { useTranslations } from "next-intl";
import type { SkillInventory } from "@/data/contracts/skills";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { linkText, mono, panel } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { useFormatter } from "@/ui/formatter";

/** Where the section renders: the workspace and the page of the inventory it read. */
type SkillsAt = { org: string; ws: string; cursor: string | null };

type Failed = Extract<Read<never>, { ok: false }>;

const box = `${panel} flex flex-col gap-2 p-6`;

function WindowLines({ inventory }: { inventory: SkillInventory }) {
  const t = useTranslations("skills.inventory");
  const format = useFormatter();
  const day = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: "medium" });
  return (
    <div
      data-window=""
      className="flex flex-col gap-0.5 text-sm text-muted-foreground"
    >
      <p>
        {t("window", {
          from: day(inventory.window.from),
          to: day(inventory.window.to),
          sessions: inventory.sessions,
        })}
      </p>
      <p>
        {inventory.reportedSessions === null
          ? t("noneReported")
          : t("reported", { reported: inventory.reportedSessions })}
      </p>
      <p>{t("notReported", { count: inventory.notReportedSessions })}</p>
    </div>
  );
}

/**
 * The tab's lead (roadmap pages/skills.md): a skill is steering and a file,
 * and Oxagen resolves one rather than running it.
 */
export function SkillsLede() {
  const t = useTranslations("skills");
  return <p className="text-sm text-muted-foreground">{t("lede")}</p>;
}

export function SkillsInventory({
  inventory,
  at,
}: {
  inventory: SkillInventory;
  at: SkillsAt;
}) {
  const t = useTranslations("skills");
  const format = useFormatter();
  if (inventory.skills.length === 0)
    return (
      <section
        data-state="empty"
        aria-labelledby="skills-empty"
        className={box}
      >
        <h2 id="skills-empty" className="text-base font-semibold">
          {t("empty.title")}
        </h2>
        <WindowLines inventory={inventory} />
        <p className="text-sm text-muted-foreground">
          {t.rich("empty.hint", {
            code: (chunks) => <code className={mono}>{chunks}</code>,
          })}
        </p>
      </section>
    );
  return (
    <section
      data-state="loaded"
      aria-labelledby="skills-inventory"
      className={`${panel} flex flex-col`}
    >
      <div className="flex flex-col gap-2 px-4 pt-4 pb-3">
        <h2 id="skills-inventory" className="text-sm font-semibold">
          {t("inventory.title")}
        </h2>
        <WindowLines inventory={inventory} />
      </div>
      <ul
        aria-label={t("inventory.list")}
        className="divide-y divide-border border-t border-border"
      >
        {inventory.skills.map((skill) => (
          <li
            key={skill.name}
            data-skill={skill.name}
            className="flex gap-3 px-4 py-3"
          >
            <GraduationCap
              aria-hidden="true"
              className="mt-0.5 size-4 flex-none text-muted-foreground"
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <p className={`${mono} break-all font-medium text-foreground`}>
                {skill.name}
              </p>
              <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                <span data-sessions={skill.sessions}>
                  {t("row.sessions", {
                    count: skill.sessions,
                    total: inventory.sessions,
                  })}
                </span>
                <span>
                  {t("row.lastSeen", {
                    date: format.dateTime(new Date(skill.lastSeenAt), {
                      dateStyle: "medium",
                    }),
                  })}
                </span>
              </p>
              <ul
                aria-label={t("row.harnesses")}
                className="flex flex-wrap gap-1.5"
              >
                {skill.harnesses.map((harness) => (
                  <li
                    key={harness}
                    data-harness={harness}
                    className={`${mono} rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground`}
                  >
                    {harness}
                  </li>
                ))}
                {skill.harnessCount > skill.harnesses.length ? (
                  <li
                    data-harness-omitted=""
                    className="px-2 py-0.5 text-xs text-muted-foreground"
                  >
                    {t("row.moreHarnesses", {
                      count: skill.harnessCount - skill.harnesses.length,
                    })}
                  </li>
                ) : null}
              </ul>
            </div>
          </li>
        ))}
      </ul>
      {inventory.nextCursor === null ? null : (
        <div className="border-t border-border px-4 py-3 text-sm">
          <SafeLink
            to={routes.skills(at.org, at.ws, { cursor: inventory.nextCursor })}
            className={linkText}
          >
            {t("inventory.next")}
          </SafeLink>
        </div>
      )}
    </section>
  );
}

export function SkillsFailure({ read, at }: { read: Failed; at: SkillsAt }) {
  const t = useTranslations("skills.failure");
  switch (read.reason) {
    case "denied":
      return (
        <section data-state="denied" className={box}>
          <h2 className="text-base font-semibold">{t("denied.title")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("denied.body", { permission: read.permission })}
          </p>
          <SafeLink to={routes.fleet(at.org, at.ws)} className={linkText}>
            {t("back")}
          </SafeLink>
        </section>
      );
    case "pending_approval":
      return (
        <section data-state="pending_approval" className={box}>
          <h2 className="text-base font-semibold">{t("pending.title")}</h2>
          <p className={`text-sm text-muted-foreground ${mono}`}>
            {t("pending.body", { request: read.accessRequestId })}
          </p>
        </section>
      );
    case "error":
      return (
        <section data-state="error" className={box}>
          <h2 className="text-base font-semibold">{t("error.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("error.body")}</p>
          <p className={`text-xs text-muted-foreground ${mono}`}>
            {t("error.code", { code: read.code, status: String(read.status) })}
          </p>
          <SafeLink
            to={
              at.cursor === null
                ? routes.skills(at.org, at.ws)
                : routes.skills(at.org, at.ws, { cursor: at.cursor })
            }
            className={linkText}
          >
            {t("retry")}
          </SafeLink>
        </section>
      );
  }
}

/** The body while the read runs: the header stays, the section is a skeleton. */
export function SkillsLoading() {
  const t = useTranslations("skills");
  return (
    <section
      data-state="loading"
      aria-busy="true"
      aria-label={t("loading")}
      className={`${panel} flex flex-col gap-3 p-4`}
    >
      <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
      <div className="h-10 animate-pulse rounded-md bg-muted" />
      <div className="h-10 animate-pulse rounded-md bg-muted" />
    </section>
  );
}
