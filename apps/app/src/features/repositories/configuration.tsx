"use client";
// The Configuration tab (mockup `cfgTab()`; MC spec §10.1): the main
// repository's `.oxagen/` as it is on the production branch, read through
// `get_repository_tree`. Four panels: `workspace.toml`, the drift between the
// file and what the control plane holds, `governance.toml` with the three
// modes, and the tree.
//
// Drift is the reconciler's record, and no reconciler exists yet (#3241), so
// the Drift table draws its columns and one not-recorded row rather than a
// comparison nobody made. Nothing on this tab writes: drift is reported and
// never repaired in place, and the governance mode changes by a pull request.
import { useTranslations } from "next-intl";
import type {
  DeclaredGovernanceMode,
  RepositoryTree,
} from "@/data/contracts/repository";
import { Badge, type BadgeTone } from "@/ui/badge";
import { buttonSecondary, mono } from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { cell, headCell } from "@/ui/table";
import { GOVERNANCE_MODES, GOVERNANCE_TOML, WORKSPACE_TOML } from "./draft";
import { useRepositoriesFailure } from "./failure";
import { REPOSITORY_GAPS } from "./gaps";
import { code, type Load, note, Panel, PanelBody } from "./parts";

const MODE_TONE: Record<DeclaredGovernanceMode, BadgeTone> = {
  solo: "allowed",
  team: "allowed",
  regulated: "allowed",
  absent: "quiet",
  invalid: "failed",
};

const DRIFT_COLUMNS = ["declared", "file", "live", "right"] as const;

const fileBlock =
  "max-h-[360px] overflow-auto rounded-[10px] border border-border bg-code-bg px-3.5 py-3 font-mono text-[12px] leading-[1.6] text-foreground whitespace-pre";

export function Configuration({
  mainFullName,
  tree,
}: {
  /** The main repository's `owner/name`; null when none is bound. */
  mainFullName: string | null;
  tree: Load<RepositoryTree> | undefined;
}) {
  const t = useTranslations("repositories.config");
  const failureText = useRepositoriesFailure();
  if (mainFullName === null)
    return (
      <p
        data-testid="configuration-no-main"
        className="text-[13px] text-muted-foreground"
      >
        {t("noMain")}
      </p>
    );
  if (tree === undefined || tree.kind === "loading")
    return (
      <p
        role="status"
        data-testid="configuration-loading"
        className="text-[13px] text-muted-foreground"
      >
        {t("loading", { repository: mainFullName })}
      </p>
    );
  if (tree.kind === "failed")
    return (
      <FormAlert testId="configuration-failure">
        {failureText(tree.failure)}
      </FormAlert>
    );
  const value = tree.value;
  return (
    <div data-testid="configuration" className="grid gap-3.5 md:grid-cols-2">
      <Panel
        id="configuration-workspace"
        testId="configuration-workspace-toml"
        title={WORKSPACE_TOML}
        subtitle={
          value.head === null
            ? t.rich("notIndexed", { repository: value.fullName, code })
            : t.rich("on", {
                repository: value.fullName,
                sha: value.head.slice(0, 7),
                code,
              })
        }
      >
        <PanelBody>
          {value.workspaceToml === null ? (
            <p className="text-[13px] text-muted-foreground">
              {t("workspaceMissing")}
            </p>
          ) : (
            <pre className={fileBlock}>{value.workspaceToml}</pre>
          )}
        </PanelBody>
      </Panel>

      <Panel
        id="configuration-drift"
        testId="configuration-drift"
        title={t("driftTitle")}
        subtitle={t("driftSubtitle")}
        action={
          <button
            type="button"
            disabled
            data-testid="configuration-drift-pr"
            data-gap={REPOSITORY_GAPS.lifecycle}
            aria-describedby="configuration-drift-none"
            className={`${buttonSecondary} min-h-7 px-2.5 py-1 text-xs`}
          >
            {t("driftPr")}
          </button>
        }
      >
        <div className="min-w-0 overflow-x-auto">
          <table
            aria-label={t("driftTitle")}
            data-testid="configuration-drift-table"
            className="w-full border-collapse text-[13px]"
          >
            <thead>
              <tr className="border-b border-border">
                {DRIFT_COLUMNS.map((column) => (
                  <th
                    key={column}
                    scope="col"
                    className={`${headCell} text-left`}
                  >
                    {t(`driftColumns.${column}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td
                  id="configuration-drift-none"
                  colSpan={DRIFT_COLUMNS.length}
                  data-state="not-recorded"
                  data-gap={REPOSITORY_GAPS.lifecycle}
                  className={`${cell} leading-relaxed text-muted-foreground`}
                >
                  {t("driftNotRecorded")}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel
        id="configuration-governance"
        testId="configuration-governance"
        title={GOVERNANCE_TOML}
        action={
          <Badge
            tone={MODE_TONE[value.governanceMode]}
            data-testid="configuration-mode"
            data-mode={value.governanceMode}
          >
            {t(`mode.${value.governanceMode}`)}
          </Badge>
        }
      >
        <PanelBody>
          {value.governanceToml === null ? (
            <p className="text-[13px] text-muted-foreground">
              {t("governanceMissing")}
            </p>
          ) : (
            <pre className={fileBlock}>{value.governanceToml}</pre>
          )}
          <dl
            data-testid="configuration-modes"
            className="mt-3 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px] leading-relaxed"
          >
            {GOVERNANCE_MODES.map((mode) => (
              <div key={mode} className="contents" data-mode={mode}>
                <dt className={`${mono} text-dim`}>{mode}</dt>
                <dd className="text-foreground">{t(`modes.${mode}`)}</dd>
              </div>
            ))}
          </dl>
          <p className={`mt-3 ${note}`}>{t.rich("modeNote", { code })}</p>
        </PanelBody>
      </Panel>

      <Panel
        id="configuration-tree"
        testId="configuration-tree"
        title={t("treeTitle")}
      >
        <PanelBody>
          {value.oxagen.files.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              {t("treeEmpty")}
            </p>
          ) : (
            <pre data-testid="configuration-tree-files" className={fileBlock}>
              {value.oxagen.files.join("\n")}
            </pre>
          )}
          <p className="mt-2 text-xs text-dim">{t("treeJson")}</p>
          <p className={`mt-3 ${note}`}>{t.rich("treeNote", { code })}</p>
        </PanelBody>
      </Panel>
    </div>
  );
}
