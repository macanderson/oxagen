"use client";
// The init wizard (mockup `wzInit()`; MC spec §10.2): add Oxagen to a
// repository by opening a pull request that puts the `.oxagen/` tree there.
//
// Five steps, in order: Repository, Branch and governance, Permissions,
// Review, Pull request. It is the only wizard that can run against a
// repository Oxagen has never written to, so before it drafts anything it says
// what the App will be able to do and what it still cannot. Both files are
// shown in full, and every line is the person's to change. The pull request
// comes from `oxagen/init` into the production branch. Nothing reaches the
// production branch until a person merges it on GitHub.
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import type { RepositoryTree } from "@/data/contracts/repository";
import { parseGitHubUrl } from "@/shared/github-url";
import {
  buttonPrimary,
  buttonSecondary,
  eyebrow,
  inputBase,
  mono,
} from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { GitHubLink } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { cell, Table } from "@/ui/table";
import { openInitPullRequest } from "./actions";
import type { BoundRepositoryRow } from "./bound-repositories";
import {
  draftGovernanceToml,
  draftWorkspaceToml,
  GOVERNANCE_MODES,
  GOVERNANCE_TOML,
  type GovernanceMode,
  INIT_BRANCH,
  INIT_FILES,
  WORKSPACE_TOML,
} from "./draft";
import { UNANSWERED, useRepositoriesFailure } from "./failure";
import { type Load, prose, sectionTitle } from "./parts";

const WIZARD_STEPS = [
  "repository",
  "branch",
  "permissions",
  "review",
  "pullRequest",
] as const;
type WizardStep = (typeof WIZARD_STEPS)[number];

/** The permissions the App needs for this lifecycle, writes included. */
const APP_PERMISSIONS = [
  { key: "contents", access: "readWrite" },
  { key: "pullRequests", access: "readWrite" },
  { key: "checks", access: "write" },
  { key: "metadata", access: "read" },
  { key: "issues", access: "read" },
] as const;

/** What the write access still does not buy. */
export const APP_CANNOT = [
  "productionBranch",
  "merge",
  "secrets",
  "authority",
] as const;

/**
 * The repositories the wizard offers: bound, with a readable production
 * branch, and no `.oxagen/` yet. A repository that already has the tree is
 * changed with an ordinary pull request, and `open_init_pr` refuses it.
 */
function initCandidates(
  repositories: readonly BoundRepositoryRow[],
  trees: Readonly<Record<string, Load<RepositoryTree>>>,
): BoundRepositoryRow[] {
  return repositories.filter((repository) => {
    const tree = trees[repository.bindingId];
    return (
      tree?.kind === "ready" &&
      tree.value.head !== null &&
      !tree.value.oxagen.present
    );
  });
}

type Opened = {
  fullName: string;
  base: string;
  number: number;
  htmlUrl: string;
  files: string[];
  reused: boolean;
};

export function InitWizard({
  org,
  ws,
  wsName,
  open,
  initial,
  repositories,
  trees,
  onClose,
  onOpened,
}: {
  org: string;
  ws: string;
  wsName: string;
  open: boolean;
  /** The repository the wizard opens on, when it was opened from one. */
  initial: string | null;
  repositories: readonly BoundRepositoryRow[];
  trees: Readonly<Record<string, Load<RepositoryTree>>>;
  onClose: () => void;
  /** The pull request is open; the page re-reads. */
  onOpened: () => void;
}) {
  const t = useTranslations("repositories.wizard");
  const failureText = useRepositoriesFailure();
  const candidates = initCandidates(repositories, trees);
  // The page mounts a fresh wizard for each opening (it keys it), so each one
  // starts over on the repository it was opened for.
  const [step, setStep] = useState<WizardStep>(
    initial === null ? "repository" : "branch",
  );
  const [picked, setPicked] = useState<string | null>(initial);
  const [mode, setMode] = useState<GovernanceMode>("team");
  const [workspaceToml, setWorkspaceToml] = useState("");
  const [governanceToml, setGovernanceToml] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const formId = useId();

  const repository =
    candidates.find((candidate) => candidate.bindingId === picked) ?? null;
  const tree = repository === null ? undefined : trees[repository.bindingId];
  const ready = tree?.kind === "ready" ? tree.value : null;
  const index = WIZARD_STEPS.indexOf(step);

  function draft() {
    if (repository === null) return;
    setWorkspaceToml(
      draftWorkspaceToml({
        org,
        ws,
        wsName,
        repository: repository.fullName,
        role: repository.role,
        productionBranch: repository.defaultRef,
      }),
    );
    setGovernanceToml(draftGovernanceToml(mode));
  }

  function next() {
    setFailure(null);
    if (step === "repository" && repository === null) {
      setFailure(t("repository.none"));
      return;
    }
    // The drafts are written each time the person moves from Permissions to
    // Review, from what they chose, so a mode changed on the way back shows up
    // in governance.toml. Edits made on Review stay while they move forward.
    if (step === "permissions") draft();
    const following = WIZARD_STEPS[index + 1];
    if (following !== undefined) setStep(following);
  }

  function back() {
    setFailure(null);
    const previous = WIZARD_STEPS[index - 1];
    if (previous !== undefined) setStep(previous);
  }

  async function submit() {
    if (pending || repository === null) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await openInitPullRequest(org, ws, {
        bindingId: repository.bindingId,
        governanceMode: mode,
        workspaceToml,
        governanceToml,
      });
      if (result.ok) {
        setOpened({
          fullName: result.value.fullName,
          base: result.value.base,
          number: result.value.pullRequest.number,
          htmlUrl: result.value.pullRequest.htmlUrl,
          files: result.value.files,
          reused: result.value.reused,
        });
        onOpened();
      } else setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  const footer =
    opened !== null ? null : (
      <>
        {index > 0 ? (
          <button
            type="button"
            data-testid="init-wizard-back"
            data-touch-target=""
            className={buttonSecondary}
            onClick={back}
          >
            {t("back")}
          </button>
        ) : null}
        {step === "pullRequest" ? (
          <button
            type="button"
            data-testid="init-wizard-open"
            data-touch-target=""
            disabled={pending}
            className={buttonPrimary}
            onClick={() => {
              void submit();
            }}
          >
            {pending ? t("opening") : t("open")}
          </button>
        ) : (
          <button
            type="button"
            data-testid="init-wizard-next"
            data-touch-target=""
            disabled={step === "repository" && candidates.length === 0}
            className={buttonPrimary}
            onClick={next}
          >
            {t("next")}
          </button>
        )}
      </>
    );

  return (
    <SheetDialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
      title={t("title")}
      subtitle={repository?.fullName}
      testId="init-wizard"
      wide
      footer={footer}
      closeLabel={opened === null ? t("cancel") : undefined}
    >
      <ol
        aria-label={t("stepsLabel")}
        className="mb-5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"
      >
        {WIZARD_STEPS.map((key, position) => (
          <li
            key={key}
            data-step={key}
            aria-current={key === step ? "step" : undefined}
            className="aria-[current=step]:font-semibold aria-[current=step]:text-foreground"
          >
            {position + 1}. {t(`steps.${key}`)}
          </li>
        ))}
      </ol>

      {failure === null ? null : (
        <div className="mb-4">
          <FormAlert testId="init-wizard-failure">{failure}</FormAlert>
        </div>
      )}

      {opened !== null ? (
        <OpenedPullRequest opened={opened} />
      ) : step === "repository" ? (
        <fieldset data-testid="init-wizard-repository">
          <legend className={sectionTitle}>{t("repository.heading")}</legend>
          <p className={`mt-1 ${prose}`}>{t("repository.about")}</p>
          {candidates.length === 0 ? (
            <p
              data-testid="init-wizard-no-candidates"
              className={`mt-3 ${prose}`}
            >
              {t("repository.empty")}
            </p>
          ) : (
            <div className="mt-3 flex flex-col gap-1">
              {candidates.map((candidate) => (
                <label
                  key={candidate.bindingId}
                  data-touch-target=""
                  className="flex min-h-11 items-center gap-2.5 rounded-md border border-border px-2.5 py-2 text-sm hover:bg-accent has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring"
                >
                  <input
                    type="radio"
                    name={`${formId}-repository`}
                    value={candidate.bindingId}
                    checked={picked === candidate.bindingId}
                    onChange={() => {
                      setPicked(candidate.bindingId);
                    }}
                  />
                  <span className="min-w-0 flex-1 break-all font-mono text-[13px] font-semibold">
                    {candidate.fullName}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {candidate.role === "main"
                      ? t("repository.main")
                      : t("repository.linked")}
                  </span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
      ) : step === "branch" ? (
        <div data-testid="init-wizard-branch" className="flex flex-col gap-4">
          <section>
            <h3 className={sectionTitle}>{t("branch.heading")}</h3>
            <p className={`mt-1 ${prose}`}>
              {t("branch.production", {
                branch: repository?.defaultRef ?? "",
              })}
            </p>
            {ready !== null &&
            repository !== null &&
            ready.githubDefaultBranch !== repository.defaultRef ? (
              <p className={`mt-1 ${prose}`}>
                {t("branch.suggestion", { branch: ready.githubDefaultBranch })}
              </p>
            ) : (
              <p className={`mt-1 ${prose}`}>{t("branch.same")}</p>
            )}
          </section>
          <fieldset>
            <legend className={sectionTitle}>{t("mode.heading")}</legend>
            <p className={`mt-1 ${prose}`}>{t("mode.about")}</p>
            <div className="mt-3 flex flex-col gap-1">
              {GOVERNANCE_MODES.map((option) => (
                <label
                  key={option}
                  data-touch-target=""
                  className="flex min-h-11 items-start gap-2.5 rounded-md border border-border px-2.5 py-2 text-sm hover:bg-accent has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring"
                >
                  <input
                    type="radio"
                    className="mt-1"
                    name={`${formId}-mode`}
                    value={option}
                    checked={mode === option}
                    onChange={() => {
                      setMode(option);
                    }}
                  />
                  <span>
                    <b className="block font-mono text-[13px]">{option}</b>
                    <span className="block text-xs text-muted-foreground">
                      {t(`mode.${option}`)}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      ) : step === "permissions" ? (
        <PermissionsStep />
      ) : step === "review" ? (
        <div data-testid="init-wizard-review" className="flex flex-col gap-4">
          <p className={prose}>{t("review.about")}</p>
          <TomlField
            label={WORKSPACE_TOML}
            testId="init-wizard-workspace-toml"
            value={workspaceToml}
            onChange={setWorkspaceToml}
          />
          <TomlField
            label={GOVERNANCE_TOML}
            testId="init-wizard-governance-toml"
            value={governanceToml}
            onChange={setGovernanceToml}
          />
        </div>
      ) : (
        <div data-testid="init-wizard-pull-request">
          <h3 className={sectionTitle}>
            {t("pullRequest.heading", {
              repository: repository?.fullName ?? "",
            })}
          </h3>
          <p className={`mt-1 ${prose}`}>
            {t("pullRequest.about", {
              branch: INIT_BRANCH,
              base: repository?.defaultRef ?? "",
            })}
          </p>
          <ul className="mt-3 flex flex-col gap-1 text-sm">
            {INIT_FILES.map((file) => (
              <li key={file} className={mono}>
                {file}
              </li>
            ))}
          </ul>
          <p className={`mt-3 ${prose}`}>{t("pullRequest.gitignore")}</p>
        </div>
      )}
    </SheetDialog>
  );
}

function PermissionsStep() {
  const t = useTranslations("repositories.permissions");
  return (
    <div data-testid="init-wizard-permissions" className="flex flex-col gap-4">
      <PermissionTable />
      <section>
        <h3 className={sectionTitle}>{t("cannotHeading")}</h3>
        <ul className={`mt-2 list-disc pl-5 ${prose}`}>
          {APP_CANNOT.map((key) => (
            <li key={key}>{t(`cannot.${key}`)}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** The permission table: the access this lifecycle needs, writes included. */
export function PermissionTable() {
  const t = useTranslations("repositories.permissions");
  return (
    <Table
      label={t("label")}
      columns={[
        { label: t("columns.permission") },
        { label: t("columns.access") },
      ]}
    >
      {APP_PERMISSIONS.map((permission) => (
        <tr key={permission.key} data-permission={permission.key}>
          <td className={cell}>{t(`names.${permission.key}`)}</td>
          <td className={cell}>{t(`access.${permission.access}`)}</td>
        </tr>
      ))}
    </Table>
  );
}

function TomlField({
  label,
  testId,
  value,
  onChange,
}: {
  label: string;
  testId: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className={`block font-mono ${eyebrow}`}>
        {label}
      </label>
      <textarea
        id={id}
        data-testid={testId}
        rows={9}
        spellCheck={false}
        className={`mt-1 min-h-40 font-mono text-xs ${inputBase}`}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      />
    </div>
  );
}

function OpenedPullRequest({ opened }: { opened: Opened }) {
  const t = useTranslations("repositories.wizard.opened");
  const href = parseGitHubUrl(opened.htmlUrl);
  return (
    <div
      role="status"
      data-testid="init-wizard-opened"
      className="flex flex-col gap-3"
    >
      <p className="text-sm text-foreground">
        {opened.reused
          ? t("reused", { number: opened.number, repository: opened.fullName })
          : t("opened", {
              number: opened.number,
              repository: opened.fullName,
              base: opened.base,
            })}
      </p>
      {opened.files.length === 0 ? null : (
        <ul className="flex flex-col gap-1 text-sm">
          {opened.files.map((file) => (
            <li key={file} className={mono}>
              {file}
            </li>
          ))}
        </ul>
      )}
      <p className={prose}>{t("merge")}</p>
      {href === null ? null : (
        <GitHubLink
          to={href}
          data-testid="init-wizard-pr-link"
          className={buttonSecondary}
        >
          {t("link", { number: opened.number })}
        </GitHubLink>
      )}
    </div>
  );
}
