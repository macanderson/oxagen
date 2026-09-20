"use client";
// The Configuration tab (mockup `cfgTab()`): the main repository's `.oxagen/`
// as it is on the production branch, at the commit it was read from. The two
// files in full, the governance mode `governance.toml` declares, and every
// path under `.oxagen/`. Oxagen reads `.oxagen/` and nothing else, so nothing
// under `.stella/` appears here.
//
// Drift (the file against what the control plane holds) is the reconciler's
// record, and no reconciler exists yet, so the tab says that rather than
// drawing a comparison nobody made.
import { useTranslations } from "next-intl";
import type {
  DeclaredGovernanceMode,
  RepositoryTree,
} from "@/data/contracts/repository";
import { mono } from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { useRepositoriesFailure } from "./failure";
import { GOVERNANCE_MODES, GOVERNANCE_TOML, WORKSPACE_TOML } from "./draft";
import { shortSha } from "./repository-dialog";
import {
  codeBlock,
  Dot,
  Explainer,
  type Load,
  prose,
  type Tone,
} from "./parts";

const MODE_TONE: Record<DeclaredGovernanceMode, Tone> = {
  solo: "ok",
  team: "ok",
  regulated: "ok",
  absent: "idle",
  invalid: "bad",
};

export function Configuration({
  mainFullName,
  tree,
}: {
  /** The main repository's `owner/name`; null when none is bound. */
  mainFullName: string | null;
  tree: Load<RepositoryTree> | undefined;
}) {
  const t = useTranslations("repositories.configuration");
  const failureText = useRepositoriesFailure();
  if (mainFullName === null)
    return (
      <p data-testid="configuration-no-main" className={prose}>
        {t("noMain")}
      </p>
    );
  if (tree === undefined || tree.kind === "loading")
    return (
      <p role="status" data-testid="configuration-loading" className={prose}>
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
  const at =
    value.head === null
      ? t("branchMissing", { branch: value.productionBranch })
      : t("readAt", {
          repository: value.fullName,
          branch: value.productionBranch,
          sha: shortSha(value.head),
        });
  return (
    <div data-testid="configuration" className="flex flex-col gap-4">
      <p className={prose}>{at}</p>

      <Explainer title={WORKSPACE_TOML} testId="configuration-workspace-toml">
        {value.workspaceToml === null ? (
          <p>{t("workspaceTomlMissing")}</p>
        ) : (
          <pre className={codeBlock}>{value.workspaceToml}</pre>
        )}
      </Explainer>

      <Explainer title={t("drift.title")} testId="configuration-drift">
        <p>{t("drift.notRecorded")}</p>
      </Explainer>

      <Explainer title={GOVERNANCE_TOML} testId="configuration-governance">
        <p>
          <Dot
            tone={MODE_TONE[value.governanceMode]}
            testId="configuration-mode"
          >
            {t(`mode.${value.governanceMode}`)}
          </Dot>
        </p>
        {value.governanceToml === null ? null : (
          <pre className={codeBlock}>{value.governanceToml}</pre>
        )}
        <p>{t("modeRead")}</p>
        <ul className="list-disc pl-5">
          {GOVERNANCE_MODES.map((mode) => (
            <li key={mode}>
              <code className={mono}>{mode}</code> {t(`modes.${mode}`)}
            </li>
          ))}
        </ul>
      </Explainer>

      <Explainer title={t("tree.title")} testId="configuration-tree">
        {value.oxagen.files.length === 0 ? (
          <p>{t("tree.empty")}</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {value.oxagen.files.map((file) => (
              <li key={file} className={`${mono} break-all text-foreground`}>
                {file}
              </li>
            ))}
          </ul>
        )}
        <p>{t("tree.stella")}</p>
      </Explainer>
    </div>
  );
}
