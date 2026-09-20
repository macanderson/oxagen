"use client";
// The repository dialog (mockup `DLG_EXT.repo`): one bound repository's
// production branch and its head, GitHub's default branch beside it as a
// suggestion, what it holds under `.oxagen/`, whether GitHub can deliver its
// events, and the facts no store records yet, each said as such.
//
// The production branch is the one branch whose commits update the code
// graph, the one `.oxagen/` is read from, and the one a Context PR merges
// into (§11.4). It never moves on its own: when GitHub's default branch moves,
// this dialog shows both and a person decides, through `set_production_branch`.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useId, useState } from "react";
import type { RepositoryTree } from "@/data/contracts/repository";
import { parseGitHubUrl } from "@/shared/github-url";
import {
  buttonPrimary,
  buttonSecondary,
  eyebrow,
  inputBase,
  mono,
} from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { GitHubLink } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { setProductionBranch } from "./actions";
import { type BoundRepositoryRow, TreeState } from "./bound-repositories";
import { UNANSWERED, useRepositoriesFailure } from "./failure";
import { Dot, type Load, prose, sectionTitle } from "./parts";

/** The first twelve characters of a commit, the way the page cites one. */
export function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

export function RepositoryDialog({
  org,
  ws,
  repository,
  tree,
  onClose,
  onChanged,
  onAddOxagen,
  onSeeChanges,
}: {
  org: string;
  ws: string;
  /** The row the dialog is about; null keeps it closed. */
  repository: BoundRepositoryRow | null;
  tree: Load<RepositoryTree> | undefined;
  onClose: () => void;
  /**
   * The production branch moved. The change wrote a new binding version, so
   * the repository now answers to `bindingId`. The page follows that id and
   * re-reads, which keeps this dialog open on the same repository.
   */
  onChanged: (bindingId: string) => void;
  /** Open the init wizard on this repository. */
  onAddOxagen: (bindingId: string) => void;
  /** Go to the Changes tab. */
  onSeeChanges: () => void;
}) {
  const t = useTranslations("repositories.dialog");
  const open = repository !== null;
  const governed = tree?.kind === "ready" && tree.value.oxagen.present;
  return (
    <SheetDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={repository?.fullName ?? t("title")}
      subtitle={
        repository === null
          ? undefined
          : repository.role === "main"
            ? t("roleMain")
            : t("roleLinked")
      }
      testId="repository-dialog"
      footer={
        repository === null ? null : governed ? (
          <button
            type="button"
            data-testid="repository-dialog-changes"
            data-touch-target=""
            className={buttonSecondary}
            onClick={onSeeChanges}
          >
            {t("seeChanges")}
          </button>
        ) : tree?.kind === "ready" && tree.value.head !== null ? (
          <button
            type="button"
            data-testid="repository-dialog-add-oxagen"
            data-touch-target=""
            className={buttonPrimary}
            onClick={() => {
              onAddOxagen(repository.bindingId);
            }}
          >
            {t("addOxagen")}
          </button>
        ) : null
      }
    >
      {repository === null ? null : (
        <DialogBody
          org={org}
          ws={ws}
          repository={repository}
          tree={tree}
          onChanged={onChanged}
        />
      )}
    </SheetDialog>
  );
}

function DialogBody({
  org,
  ws,
  repository,
  tree,
  onChanged,
}: {
  org: string;
  ws: string;
  repository: BoundRepositoryRow;
  tree: Load<RepositoryTree> | undefined;
  onChanged: (bindingId: string) => void;
}) {
  const t = useTranslations("repositories.dialog");
  const failureText = useRepositoriesFailure();
  const ready = tree?.kind === "ready" ? tree.value : null;
  const initPr = ready === null ? null : ready.initPullRequest;
  const initHref = initPr === null ? null : parseGitHubUrl(initPr.htmlUrl);
  return (
    <div className="flex flex-col gap-5">
      {tree?.kind === "failed" ? (
        <FormAlert testId="repository-dialog-failure">
          {failureText(tree.failure)}
        </FormAlert>
      ) : null}
      {tree === undefined || tree.kind === "loading" ? (
        <p
          role="status"
          data-testid="repository-dialog-loading"
          className={prose}
        >
          {t("loading")}
        </p>
      ) : null}

      <dl className="grid grid-cols-1 gap-x-4 gap-y-3 text-sm sm:grid-cols-[max-content_1fr]">
        <dt className={eyebrow}>{t("facts.productionBranch")}</dt>
        <dd data-testid="repository-dialog-branch">
          <span className={mono}>{repository.defaultRef}</span>
          {ready === null ? null : ready.head === null ? (
            <span className="ml-2">
              <Dot tone="bad">{t("facts.branchMissing")}</Dot>
            </span>
          ) : (
            <span className="ml-2 text-muted-foreground">
              {t("facts.head", { sha: shortSha(ready.head) })}
            </span>
          )}
        </dd>
        {ready === null ? null : (
          <>
            <dt className={eyebrow}>{t("facts.githubDefault")}</dt>
            <dd data-testid="repository-dialog-github-default">
              <span className={mono}>{ready.githubDefaultBranch}</span>
              <span className="ml-2 text-muted-foreground">
                {t("facts.suggestion")}
              </span>
            </dd>
          </>
        )}
        <dt className={eyebrow}>{t("facts.oxagen")}</dt>
        <dd>
          <TreeState tree={tree} testId="repository-dialog-tree" />
          {ready !== null && ready.head !== null && ready.oxagen.present ? (
            <span className="ml-2 text-muted-foreground">
              {t("facts.atCommit", { sha: shortSha(ready.head) })}
            </span>
          ) : null}
        </dd>
        <dt className={eyebrow}>{t("facts.events")}</dt>
        <dd>{t(`events.${repository.events}`)}</dd>
        <dt className={eyebrow}>{t("facts.codeGraph")}</dt>
        <dd className="text-muted-foreground">{t("notRecorded")}</dd>
        <dt className={eyebrow}>{t("facts.drift")}</dt>
        <dd className="text-muted-foreground">{t("notRecorded")}</dd>
        <dt className={eyebrow}>{t("facts.workingCopies")}</dt>
        <dd className="text-muted-foreground">{t("notRecorded")}</dd>
        <dt className={eyebrow}>{t("facts.issues")}</dt>
        <dd className="text-muted-foreground">{t("issuesNotRecorded")}</dd>
      </dl>

      {initHref === null || initPr === null ? null : (
        <p data-testid="repository-dialog-init-pr" className={prose}>
          {t("initOpen", { number: initPr.number })}{" "}
          <GitHubLink to={initHref} className="underline">
            {t("initOpenLink")}
          </GitHubLink>
        </p>
      )}

      {ready !== null && !ready.oxagen.present && ready.head !== null ? (
        <p data-testid="repository-dialog-ungoverned" className={prose}>
          {repository.role === "linked"
            ? t("ungovernedLinked")
            : t("ungovernedMain")}
        </p>
      ) : null}

      <ProductionBranchForm
        org={org}
        ws={ws}
        repository={repository}
        suggestion={
          ready !== null && ready.githubDefaultBranch !== repository.defaultRef
            ? ready.githubDefaultBranch
            : null
        }
        onChanged={onChanged}
      />
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
  repository,
  suggestion,
  onChanged,
}: {
  org: string;
  ws: string;
  repository: BoundRepositoryRow;
  /** GitHub's default branch when it differs from the production branch. */
  suggestion: string | null;
  onChanged: (bindingId: string) => void;
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
      const result = await setProductionBranch(
        org,
        ws,
        repository.bindingId,
        name,
      );
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
        if (result.value.changed) onChanged(result.value.bindingId);
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
    <section aria-labelledby={`${fieldId}-heading`}>
      <h3 id={`${fieldId}-heading`} className={sectionTitle}>
        {t("heading")}
      </h3>
      <p className={`mt-1 ${prose}`}>{t("about")}</p>
      {suggestion === null ? null : (
        <div
          data-testid="repository-dialog-branch-moved"
          className="mt-3 flex flex-col gap-2 rounded-md border border-border p-3"
        >
          <p className={prose}>
            {t("moved", { github: suggestion, current: repository.defaultRef })}
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
          className={`mt-1 font-mono ${inputBase}`}
          placeholder={repository.defaultRef}
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
