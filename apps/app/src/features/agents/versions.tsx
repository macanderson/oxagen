// The agent's versions (ADR-192): what it was bound to from each version on.
// An agent keeps its principal, its roles and its runs for life; its runtime
// and its toolbelt can change, and each change writes a version. The list is
// the record of those changes, newest first, as `get_agent` read it.
//
// A version written before ADR-192 is `legacy`: it recorded no runtime and no
// toolbelt, so those cells say not recorded rather than borrowing the
// agent's current binding.
import { useTranslations } from "next-intl";
import type { AgentDetail } from "@/data/contracts/agents";
import { mono } from "@/ui/control-styles";
import { cell, numericCell, Table } from "@/ui/table";
import { Instant, NotRecordedValue, Panel } from "./parts";

export function AgentVersions({
  versions,
}: {
  versions: AgentDetail["versions"];
}) {
  const t = useTranslations("agents.detail.versions");
  return (
    <Panel
      id="agent-versions"
      title={t("title")}
      lead={t("lead")}
      testId="agent-versions"
    >
      {versions.length === 0 ? (
        <p className="px-4 py-3.5 text-sm text-muted-foreground">{t("none")}</p>
      ) : (
        <Table
          label={t("title")}
          columns={[
            { label: t("columns.version"), numeric: true },
            { label: t("columns.change") },
            { label: t("columns.runtime") },
            { label: t("columns.toolbelt") },
            { label: t("columns.written") },
          ]}
        >
          {versions.map((version) => {
            const legacy = version.changeKind === "legacy";
            return (
              <tr
                key={version.version}
                data-testid="agent-version"
                data-change={version.changeKind}
                className="border-b border-border last:border-b-0"
              >
                <td className={numericCell}>{version.version}</td>
                <td className={cell}>{t(`change.${version.changeKind}`)}</td>
                <td className={cell}>
                  {version.runtime === null ? (
                    legacy ? (
                      <NotRecordedValue />
                    ) : (
                      <span className="text-muted-foreground">
                        {t("noRuntime")}
                      </span>
                    )
                  ) : (
                    <>
                      {version.runtime.name}{" "}
                      <span className={`${mono} text-xs text-muted-foreground`}>
                        {version.runtime.slug}
                      </span>
                    </>
                  )}
                </td>
                <td className={cell}>
                  {version.toolbelt === null ? (
                    <NotRecordedValue />
                  ) : (
                    version.toolbelt.name
                  )}
                </td>
                <td className={cell}>
                  <Instant at={version.createdAt} />
                </td>
              </tr>
            );
          })}
        </Table>
      )}
    </Panel>
  );
}
