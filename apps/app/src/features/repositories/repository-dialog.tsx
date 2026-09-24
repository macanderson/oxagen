"use client";
// The repository dialog (mockup `DLG_EXT.repo`): one repository's production
// branch and its head, its visibility, what it holds under `.oxagen/`, its
// events, and the facts no store records yet, each said as such; then what
// records published there steer, or that there is nowhere to publish one.
//
// The footer carries the role's one move. A linked repository offers Unlink
// (red; opens the confirm), one that is not linked offers Link to this
// workspace (gold), and the main repo offers neither, because moving main is
// an owner action and this dialog never offers it. A governed repository
// offers See its changes, an ungoverned one Add Oxagen.
//
// The production branch never moves on its own (§11.4): when GitHub's
// default branch moves, the dialog shows both and a person decides, through
// `set_production_branch`. A main repository whose GitHub connection was
// retired carries the repair, which binds the same repository again.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useId, useState } from "react";
import { parseGitHubUrl } from "@/shared/github-url";
import {
  buttonPrimary,
  buttonSecondary,
  eyebrow,
  inputBase,
} from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { GitHubLink } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { linkWorkspaceRepository, setProductionBranch } from "./actions";
import { UNANSWERED, useRepositoriesFailure } from "./failure";
import { REPOSITORY_GAPS } from "./gaps";
import { RepositorySetup } from "./main-repository";
import { buttonDanger, code, kv, note, prose } from "./parts";
import { TreeBadge } from "./repositories-tab";
import { type RepositoryRow, treeState } from "./view";

export function RepositoryDialog({
  org,
  ws,
  workspace,
  mainFullName,
  row,
  onClose,
  onChanged,
  onUnlink,
  onAddOxagen,
  onSeeChanges,
}: {
  org: string;
  ws: string;
  /** The workspace's name, which the notes name. */
  workspace: string;
  /** The main repository's `owner/name`; null when none is bound. */
  mainFullName: string | null;
  /** The row the dialog is about; null keeps it closed. */
  row: RepositoryRow | null;
  onClose: () => void;
  /**
   * A write settled: a link, a production-branch change or a repair. A
   * production-branch change writes a new binding version, so the page
   * follows the repository by name and re-reads.
   */
  onChanged: () => void;
  onUnlink: (row: RepositoryRow) => void;
  onAddOxagen: (fullName: string) => void;
  onSeeChanges: () => void;
}) {
  const t = useTranslations("repositories.dialog");
  const failureText = useRepositoriesFailure();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [linked, setLinked] = useState<string | null>(null);
  const open = row !== null;
  const governed = row !== null && treeState(row.tree) === "governed";

  async function link() {
    if (row === null || pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await linkWorkspaceRepository(org, ws, {
        owner: row.owner,
        name: row.name,
      });
      if (result.ok) {
        setLinked(t("linked", { repository: row.fullName, workspace }));
        onChanged();
      } else setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  const footer =
    row === null ? null : (
      <>
        {row.role === "linked" ? (
          <button
            type="button"
            data-testid="repository-dialog-unlink"
            aria-haspopup="dialog"
            className={`${buttonDanger} max-md:w-full`}
            onClick={() => {
              onUnlink(row);
            }}
          >
            {t("unlink")}
          </button>
        ) : row.role === "available" && linked === null ? (
          <button
            type="button"
            data-testid="repository-dialog-link"
            disabled={pending}
            className={`${buttonPrimary} max-md:w-full`}
            onClick={() => {
              void link();
            }}
          >
            {pending ? t("linking") : t("link")}
          </button>
        ) : null}
        {governed ? (
          <button
            type="button"
            data-testid="repository-dialog-changes"
            className={`${buttonSecondary} max-md:w-full`}
            onClick={onSeeChanges}
          >
            {t("seeChanges")}
          </button>
        ) : treeState(row.tree) === "absent" ||
          treeState(row.tree) === "unknown" ? (
          <button
            type="button"
            data-testid="repository-dialog-add-oxagen"
            className={`${row.role === "available" ? buttonSecondary : buttonPrimary} max-md:w-full`}
            onClick={() => {
              onAddOxagen(row.fullName);
            }}
          >
            {t("addOxagen")}
          </button>
        ) : null}
      </>
    );

  return (
    <SheetDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setFailure(null);
          setLinked(null);
          onClose();
        }
      }}
      title={row?.fullName ?? ""}
      subtitle={row === null ? undefined : t(`subtitle.${row.role}`)}
      testId="repository-dialog"
      footer={footer}
    >
      {row === null ? null : (
        <Body
          org={org}
          ws={ws}
          workspace={workspace}
          mainFullName={mainFullName}
          row={row}
          failure={failure}
          linked={linked}
          onChanged={onChanged}
        />
      )}
    </SheetDialog>
  );
}

function Body({
  org,
  ws,
  workspace,
  mainFullName,
  row,
  failure,
  linked,
  onChanged,
}: {
  org: string;
  ws: string;
  workspace: string;
  mainFullName: string | null;
  row: RepositoryRow;
  failure: string | null;
  linked: string | null;
  onChanged: () => void;
}) {
  const t = useTranslations("repositories.dialog");
  const repos = useTranslations("repositories.repos");
  const failureText = useRepositoriesFailure();
  const state = treeState(row.tree);
  const ready = row.tree?.kind === "ready" ? row.tree.value : null;
  const initPr = ready?.initPullRequest ?? null;
  const initHref = initPr === null ? null : parseGitHubUrl(initPr.htmlUrl);
  const notRecorded = (
    <span
      data-state="not-recorded"
      data-gap={REPOSITORY_GAPS.lifecycle}
      className="text-dim"
    >
      {t("notRecorded")}
    </span>
  );
  return (
    <div className="flex flex-col gap-3.5">
      {failure === null ? null : (
        <FormAlert testId="repository-dialog-failure">{failure}</FormAlert>
      )}
      {linked === null ? null : (
        <p role="status" data-testid="repository-dialog-linked" className="text-[13px]">
          {linked}
        </p>
      )}
      {row.tree?.kind === "failed" ? (
        <FormAlert testId="repository-dialog-tree-failure">
          {failureText(row.tree.failure)}
        </FormAlert>
      ) : null}
      <dl className={kv}>
        <dt>{t("facts.productionBranch")}</dt>
        <dd data-testid="repository-dialog-branch">
          {ready === null
            ? code(row.productionBranch)
            : ready.head === null
              ? t.rich("facts.branchMissing", {
                  branch: row.productionBranch,
                  code,
                })
              : t.rich("facts.at", {
                  branch: row.productionBranch,
                  sha: ready.head.slice(0, 7),
                  code,
                })}
        </dd>
        <dt>{t("facts.visibility")}</dt>
        <dd>
          {row.visibility === null
            ? notRecorded
            : repos(`visibility.${row.visibility}`)}
        </dd>
        <dt>{t("facts.oxagen")}</dt>
        <dd>
          <TreeBadge state={state} testId="repository-dialog-tree" />
          {ready !== null && ready.head !== null && ready.oxagen.present ? (
            <span className="ms-1.5 text-dim">
              {t.rich("facts.filesAt", {
                count: ready.oxagen.files.length,
                sha: ready.head.slice(0, 7),
                code,
              })}
            </span>
          ) : null}
        </dd>
        <dt>{t("facts.issues")}</dt>
        <dd>{notRecorded}</dd>
        <dt>{t("facts.events")}</dt>
        <dd>
          {row.events === null ? repos("none") : repos(`events.${row.events}`)}
        </dd>
        <dt>{t("facts.codeGraph")}</dt>
        <dd>
          {row.role === "available" ? (
            <span className="text-dim">{t("notIndexed")}</span>
          ) : (
            notRecorded
          )}
        </dd>
        <dt>{t("facts.dataLayer")}</dt>
        <dd>{notRecorded}</dd>
        <dt>{t("facts.workingCopies")}</dt>
        <dd>{notRecorded}</dd>
      </dl>

      {state === "governed" ? (
        <section aria-labelledby="repository-dialog-records">
          <h3
            id="repository-dialog-records"
            className="mb-1.5 text-[12.5px] font-semibold text-muted-foreground"
          >
            {t("recordsHere")}
          </h3>
          <p className={note}>
            {row.role === "main"
              ? t.rich("recordsMain", { workspace, code })
              : t.rich("recordsLinked", { code })}
          </p>
        </section>
      ) : state === "absent" || state === "unknown" ? (
        <p
          data-testid="repository-dialog-ungoverned"
          className={`${note} border-info`}
        >
          <b className="text-foreground">{t.rich("noTreeLead", { code })}</b>{" "}
          {row.role === "available"
            ? t("noTreeAvailable", { workspace })
            : t("noTreeLinked", {
                main: mainFullName ?? row.fullName,
              })}
        </p>
      ) : null}

      {initHref === null || initPr === null ? null : (
        <p data-testid="repository-dialog-init-pr" className={prose}>
          {t("initOpen", { number: initPr.number })}{" "}
          <GitHubLink to={initHref} className="underline">
            {t("initOpenLink")}
          </GitHubLink>
        </p>
      )}

      {row.role === "main" && !row.connectionLive ? (
        <section aria-label={t("retiredLead")}>
          <RepositorySetup org={org} ws={ws} onChanged={onChanged} />
        </section>
      ) : null}

      {row.bindingId === null ? null : (
        <ProductionBranchForm
          org={org}
          ws={ws}
          bindingId={row.bindingId}
          current={row.productionBranch}
          suggestion={
            ready !== null && ready.githubDefaultBranch !== row.productionBranch
              ? ready.githubDefaultBranch
              : null
          }
          onChanged={onChanged}
        />
      )}
    </div>
  );
}

/**
 * Confirm or change the production branch. GitHub's default, when it differs,
 * is offered as one click; any other branch is typed. Either one goes through
 * `set_production_branch`, which checks the branch exists on GitHub before it
 * writes a new binding version.
 */
function ProductionBranchForm({
  org,
  ws,
  bindingId,
  current,
  suggestion,
  onChanged,
}: {
  org: string;
  ws: string;
  bindingId: string;
  current: string;
  /** GitHub's default branch when it differs from the production branch. */
  suggestion: string | null;
  onChanged: () => void;
}) {
  const t = useTranslations("repositories.dialog.branch");
  const failureText = useRepositoriesFailure();
  const fieldId = useId();
  const [branch, setBranch] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function save(next: string) {
    if (pending) return;
    const name = next.trim();
    if (name === "") {
      setFailure(t("empty"));
      return;
    }
    setPending(true);
    setFailure(null);
    setDone(null);
    try {
      const result = await setProductionBranch(org, ws, bindingId, name);
      if (result.ok) {
        setBranch("");
        setDone(
          result.value.changed
            ? t("changed", {
                from: result.value.previousBranch,
                to: result.value.productionBranch,
              })
            : t("unchanged", { branch: result.value.productionBranch }),
        );
        if (result.value.changed) onChanged();
      } else setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    void save(branch);
  }

  return (
    <section
      aria-labelledby={`${fieldId}-heading`}
      className="border-t border-border pt-3.5"
    >
      <h3
        id={`${fieldId}-heading`}
        className="text-[12.5px] font-semibold text-muted-foreground"
      >
        {t("heading")}
      </h3>
      <p className={`mt-1 ${prose}`}>{t("about")}</p>
      {suggestion === null ? null : (
        <div
          data-testid="repository-dialog-branch-moved"
          className="mt-3 flex flex-col gap-2 rounded-md border border-border p-3"
        >
          <p className={prose}>
            {t("moved", { github: suggestion, current })}
          </p>
          <div>
            <button
              type="button"
              data-testid="repository-dialog-branch-use-suggestion"
              data-touch-target=""
              disabled={pending}
              className={buttonSecondary}
              onClick={() => {
                void save(suggestion);
              }}
            >
              {t("useSuggestion", { branch: suggestion })}
            </button>
          </div>
        </div>
      )}
      <form
        noValidate
        data-testid="repository-dialog-branch-form"
        className="mt-3"
        onSubmit={submit}
      >
        <label htmlFor={fieldId} className={`block ${eyebrow}`}>
          {t("label")}
        </label>
        <input
          id={fieldId}
          type="text"
          data-testid="repository-dialog-branch-input"
          className={`mt-1 font-mono text-base sm:text-[13px] ${inputBase}`}
          placeholder={current}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={failure === null ? undefined : true}
          value={branch}
          onChange={(e) => {
            setBranch(e.target.value);
          }}
        />
        {failure === null ? null : (
          <div className="mt-3">
            <FormAlert testId="repository-dialog-branch-failure">
              {failure}
            </FormAlert>
          </div>
        )}
        {done === null ? null : (
          <p
            role="status"
            data-testid="repository-dialog-branch-done"
            className="mt-3 text-sm text-foreground"
          >
            {done}
          </p>
        )}
        <div className="mt-3 flex justify-end">
          <SubmitButton
            pending={pending}
            fullWidth={false}
            secondary
            label={t("submit")}
            pendingLabel={t("pending")}
          />
        </div>
      </form>
    </section>
  );
}
