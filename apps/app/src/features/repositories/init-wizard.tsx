"use client";
// The init wizard (mockup `wzInit()`; MC spec §10.2; docs/creation-spec.md in
// oxagen-roadmap): add Oxagen to a repository by opening a pull request that
// puts the `.oxagen/` tree there.
//
// Five steps, in order: Repository, Branch & governance, Permissions, Review,
// Pull request. It is the only wizard that can run against a repository
// Oxagen has never written to, so before it drafts anything it says what the
// App will be able to do and what it still cannot. Both files are shown in
// full, and every line is the person's to change. The pull request comes from
// `oxagen/init` into the production branch, and nothing reaches the
// production branch until a person merges it.
//
// Step 1 offers the repositories with no `.oxagen/`: a bound one whose tree
// read came back empty, or one the installation reaches that this workspace
// does not bind yet (its tree is read by the `layout` check, which refuses a
// repository that already has one). A bound repository keeps its role, and the
// drafted `role` follows it. One that is not bound yet is linked:
// `link_repository` opens a steering PR that adds it to `workspace.toml`
// (ADR-212), and the wizard stops there, names that PR, and says to merge it.
// Opened again after the merge, it finds the repository bound and goes on. With
// a binding in hand, the wizard moves the production branch if the person
// changed it (`set_production_branch`), then opens the pull request
// (`open_init_pr`). Each is a governed write the kernel gates on its own.
import { CheckIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import type { LinkedRepository } from "@/data/contracts/repository";
import { parseGitHubUrl } from "@/shared/github-url";
import {
  buttonPrimary,
  buttonSecondary,
  inputBase,
  mono,
  textareaBase,
} from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { GitHubLink } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { cell, headCell } from "@/ui/table";
import {
  linkWorkspaceRepository,
  openInitPullRequest,
  setProductionBranch,
} from "./actions";
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
import { RepositorySetup } from "./main-repository";
import { CheckRows, code, note } from "./parts";
import { SteeringProposal } from "./steering-proposal";
import { type RepositoryRow, treeState } from "./view";

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
  "contents",
  "pullRequests",
  "checks",
  "metadata",
  "issues",
] as const;

/** What the write access still does not buy. */
const APP_CANNOT = ["push", "merge", "secret", "authority"] as const;

const INIT_CHECKS = [
  "schema",
  "layout",
  "governance",
  "secret_pii_scan",
  "no_authority",
] as const;

/** What each file the pull request carries is for, in `INIT_FILES` order. */
const FILE_NOTE = [
  "workspaceToml",
  "governanceToml",
  "rules",
  "proposals",
  "gitignore",
] as const;

/**
 * The repositories the wizard offers: a bound one whose production branch
 * reads and holds no `.oxagen/`, and one the installation reaches that no
 * binding names yet.
 */
function initCandidates(rows: readonly RepositoryRow[]): RepositoryRow[] {
  return rows.filter(
    (row) => row.role === "available" || treeState(row.tree) === "absent",
  );
}

type Opened = {
  fullName: string;
  number: number;
  htmlUrl: string;
  reused: boolean;
};

export function InitWizard({
  org,
  ws,
  wsName,
  open,
  initial,
  rows,
  connectNeeded,
  onClose,
  onOpened,
}: {
  org: string;
  ws: string;
  wsName: string;
  open: boolean;
  /** The repository the wizard opens on, by full name, when it was opened from one. */
  initial: string | null;
  rows: readonly RepositoryRow[];
  /**
   * The installation could not be listed because GitHub is not connected to
   * this workspace yet: step 1 carries the connection before any repository.
   */
  connectNeeded: boolean;
  onClose: () => void;
  /**
   * A write settled (an attach, a link, a branch move or the pull request); the
   * page re-reads.
   */
  onOpened: () => void;
}) {
  const t = useTranslations("repositories.wizard");
  const failureText = useRepositoriesFailure();
  const id = useId();
  const candidates = initCandidates(rows);
  // The page mounts a fresh wizard for each opening (it keys it), so each one
  // starts over on the repository it was opened for.
  const [step, setStep] = useState<WizardStep>("repository");
  const [picked, setPicked] = useState<string | null>(
    candidates.find((row) => row.fullName === initial)?.fullName ??
      candidates[0]?.fullName ??
      null,
  );
  const [mode, setMode] = useState<GovernanceMode>("team");
  const [branch, setBranch] = useState<string | null>(null);
  const [workspaceToml, setWorkspaceToml] = useState("");
  const [governanceToml, setGovernanceToml] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  /** The link proposed for a repository with no binding. The wizard stops on it. */
  const [proposed, setProposed] = useState<LinkedRepository | null>(null);
  const finished = opened !== null || proposed !== null;

  const repository = candidates.find((row) => row.fullName === picked) ?? null;
  // The drafted role follows the binding: a repository already bound keeps its
  // role, and one that is not is linked. The steering repository is written
  // when the workspace is created (ADR-212), so the wizard never makes one.
  const role: "main" | "linked" =
    repository !== null && repository.role !== "available"
      ? repository.role
      : "linked";
  // What step 1 says about that role: the steering repository, a linked one,
  // or one the wizard links through a steering PR and stops on.
  const roleNote =
    role === "main"
      ? "noteMain"
      : repository?.bindingId === null
        ? "noteLink"
        : "noteLinked";
  const ready =
    repository?.tree?.kind === "ready" ? repository.tree.value : null;
  const suggestion =
    ready?.githubDefaultBranch ?? repository?.productionBranch ?? "";
  const productionBranch = branch ?? repository?.productionBranch ?? "";
  const index = WIZARD_STEPS.indexOf(step);

  function draft() {
    if (repository === null) return;
    setWorkspaceToml(
      draftWorkspaceToml({
        org,
        ws,
        wsName,
        repository: repository.fullName,
        role,
        productionBranch,
      }),
    );
    setGovernanceToml(draftGovernanceToml(mode));
  }

  function next() {
    setFailure(null);
    if (step === "repository" && repository === null) return;
    if (step === "branch" && productionBranch.trim() === "") {
      setFailure(t("branch.empty"));
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
    let wrote = false;
    try {
      // A repository with no binding is linked, and a link binds nothing at
      // once (ADR-212). It opens a steering PR, and the binding follows its
      // merge, so there is no binding yet to move the production branch on or
      // to open the pull request against. The wizard stops on the steering PR,
      // and opened again after the merge it finds the repository bound and
      // goes on from here.
      const { bindingId } = repository;
      if (bindingId === null) {
        const linked = await linkWorkspaceRepository(org, ws, {
          owner: repository.owner,
          name: repository.name,
        });
        if (!linked.ok) {
          setFailure(failureText(linked));
          return;
        }
        wrote = true;
        setProposed(linked.value);
        return;
      }
      const wanted = productionBranch.trim();
      if (wanted !== repository.productionBranch) {
        const moved = await setProductionBranch(org, ws, bindingId, wanted);
        if (!moved.ok) {
          setFailure(failureText(moved));
          return;
        }
        wrote = true;
      }
      const result = await openInitPullRequest(org, ws, {
        bindingId,
        governanceMode: mode,
        workspaceToml,
        governanceToml,
      });
      if (result.ok) {
        wrote = true;
        setOpened({
          fullName: result.value.fullName,
          number: result.value.pullRequest.number,
          htmlUrl: result.value.pullRequest.htmlUrl,
          reused: result.value.reused,
        });
      } else setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
      if (wrote) onOpened();
    }
  }

  const footer =
    finished ? null : (
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
            disabled={step === "repository" && repository === null}
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
      title={
        repository === null || step === "repository"
          ? t("title")
          : t("titleFor", { repository: repository.fullName })
      }
      subtitle={ws}
      testId="init-wizard"
      wide
      footer={footer}
      closeLabel={!finished && index === 0 ? t("cancel") : undefined}
    >
      <ol
        aria-label={t("stepsLabel")}
        className="mb-4 flex flex-wrap gap-1.5 text-sm"
      >
        {WIZARD_STEPS.map((key, position) => {
          const done = opened !== null || position < index;
          return (
            <li
              key={key}
              data-step={key}
              aria-current={
                key === step && opened === null ? "step" : undefined
              }
              className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-1 text-muted-foreground aria-[current=step]:border-gold aria-[current=step]:text-foreground"
            >
              <span
                aria-hidden="true"
                className={`grid size-4 place-items-center rounded-full border text-xs ${key === step && opened === null ? "border-gold bg-gold text-on-gold" : "border-border"}`}
              >
                {done ? <CheckIcon className="size-2.5" /> : position + 1}
              </span>
              {t(`steps.${key}`)}
            </li>
          );
        })}
      </ol>

      {failure === null ? null : (
        <div className="mb-4">
          <FormAlert testId="init-wizard-failure">{failure}</FormAlert>
        </div>
      )}

      {opened !== null ? (
        <OpenedPullRequest opened={opened} />
      ) : proposed !== null ? (
        <div className="flex flex-col gap-3">
          <SteeringProposal
            action="link"
            fullName={proposed.fullName}
            steeringPullRequest={proposed.steeringPullRequest}
            testId="init-wizard-steering-pr"
          />
          <p
            data-testid="init-wizard-resume"
            className="text-sm leading-relaxed text-muted-foreground"
          >
            {t.rich("resume", { repository: proposed.fullName, code })}
          </p>
        </div>
      ) : step === "repository" ? (
        <div
          data-testid="init-wizard-repository"
          className="flex flex-col gap-3"
        >
          <p className="text-base leading-relaxed text-foreground">
            {t("repository.lead")}
          </p>
          {connectNeeded && candidates.length === 0 ? (
            <>
              <p
                data-testid="init-wizard-connect"
                className="text-sm text-muted-foreground"
              >
                {t("repository.connect")}
              </p>
              <RepositorySetup org={org} ws={ws} onChanged={onOpened} />
            </>
          ) : candidates.length === 0 ? (
            <p
              data-testid="init-wizard-no-candidates"
              className="text-sm text-muted-foreground"
            >
              {t.rich("repository.empty", { code })}
            </p>
          ) : (
            <>
              <div>
                <label
                  htmlFor={`${id}-repository`}
                  className="mb-1 block text-sm font-semibold text-muted-foreground"
                >
                  {t("repository.label")}
                </label>
                <select
                  id={`${id}-repository`}
                  data-testid="init-wizard-select"
                  value={picked ?? ""}
                  className={inputBase}
                  onChange={(event) => {
                    setPicked(event.target.value);
                    setBranch(null);
                  }}
                >
                  {candidates.map((row) => (
                    <option key={row.fullName} value={row.fullName}>
                      {row.visibility === null
                        ? row.fullName
                        : t("repository.option", {
                            repository: row.fullName,
                            visibility: row.visibility,
                          })}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t.rich("repository.hint", { code })}
                </p>
              </div>
              <p data-testid="init-wizard-role-note" className={note}>
                {t(`repository.${roleNote}`, {
                  repository: repository?.fullName ?? "",
                })}
              </p>
            </>
          )}
        </div>
      ) : step === "branch" ? (
        <div data-testid="init-wizard-branch" className="flex flex-col gap-3.5">
          <p className="text-base leading-relaxed text-foreground">
            {t("branch.lead")}
          </p>
          <div>
            <label
              htmlFor={`${id}-branch`}
              className="mb-1 block text-sm font-semibold text-muted-foreground"
            >
              {t("branch.label")}
            </label>
            <input
              id={`${id}-branch`}
              data-testid="init-wizard-branch-input"
              className={`font-mono ${inputBase}`}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={productionBranch}
              onChange={(event) => {
                setBranch(event.target.value);
              }}
            />
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {t.rich("branch.hint", { branch: suggestion, code })}
            </p>
          </div>
          <fieldset>
            <legend className="mb-1 block text-sm font-semibold text-muted-foreground">
              {t("branch.modeLabel")}
            </legend>
            <div className="grid gap-2.5 sm:grid-cols-3">
              {GOVERNANCE_MODES.map((option) => (
                <label
                  key={option}
                  data-mode={option}
                  data-touch-target=""
                  className="flex cursor-pointer flex-col gap-1 rounded-xl border border-border px-3.5 py-3 has-[:checked]:border-gold has-[:checked]:bg-hl has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring"
                >
                  <input
                    type="radio"
                    className="sr-only"
                    name={`${id}-mode`}
                    value={option}
                    checked={mode === option}
                    onChange={() => {
                      setMode(option);
                    }}
                  />
                  <b
                    className={`${mono} text-sm font-semibold text-foreground`}
                  >
                    {option}
                  </b>
                  <span className="text-sm leading-relaxed text-muted-foreground">
                    {t(`branch.modes.${option}`)}
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
              {t.rich("branch.modeHint", { code })}
            </p>
          </fieldset>
        </div>
      ) : step === "permissions" ? (
        <div
          data-testid="init-wizard-permissions"
          className="flex flex-col gap-3.5"
        >
          <p className="text-base font-semibold text-foreground">
            {t("permissions.lead", { repository: repository?.fullName ?? "" })}
          </p>
          <PermissionTable />
          <section aria-labelledby={`${id}-cannot`}>
            <h3
              id={`${id}-cannot`}
              className="mb-1.5 text-sm font-semibold text-muted-foreground"
            >
              {t("permissions.cannotLabel")}
            </h3>
            <CheckRows
              testId="init-wizard-cannot"
              rows={APP_CANNOT.map((key) => ({
                key,
                name: t(`permissions.cannot.${key}.name`, {
                  branch: productionBranch,
                }),
                what: t.rich(`permissions.cannot.${key}.what`, { code }),
              }))}
            />
          </section>
        </div>
      ) : step === "review" ? (
        <div data-testid="init-wizard-review" className="flex flex-col gap-3.5">
          <p className="text-base font-semibold text-foreground">
            {t("review.lead", { repository: repository?.fullName ?? "" })}
          </p>
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
          <p className={note}>{t("review.note")}</p>
        </div>
      ) : (
        <div
          data-testid="init-wizard-pull-request"
          className="flex flex-col gap-3.5"
        >
          <p className="text-base leading-relaxed text-foreground">
            {t.rich("pullRequest.lead", {
              repository: repository?.fullName ?? "",
              code,
            })}
          </p>
          <div className="overflow-hidden rounded-xl border border-border">
            <div
              data-testid="init-wizard-pr-head"
              className="flex flex-wrap items-center gap-2 border-b border-border bg-hl px-3.5 py-2.5 text-sm"
            >
              <span
                className={`${mono} rounded-sm border border-border bg-card px-1.5 py-0.5`}
              >
                {repository?.fullName}
              </span>
              <span aria-hidden="true" className="text-dim">
                ←
              </span>
              <span
                className={`${mono} rounded-sm border border-info/40 bg-info/10 px-1.5 py-0.5 text-info`}
              >
                {INIT_BRANCH}
              </span>
            </div>
            <ul data-testid="init-wizard-files" className="text-sm">
              {INIT_FILES.map((file, position) => {
                const key = FILE_NOTE[position] ?? "rules";
                return (
                  <li
                    key={file}
                    data-file={file}
                    className="flex flex-wrap items-baseline gap-x-2.5 border-b border-border px-3.5 py-2 last:border-b-0"
                  >
                    <span
                      aria-hidden="true"
                      className="w-3 font-mono text-success"
                    >
                      {file === ".gitignore" ? "~" : "+"}
                    </span>
                    <span className={`${mono} text-foreground`}>{file}</span>
                    <span className="text-dim">
                      {key === "workspaceToml"
                        ? t(`pullRequest.files.workspaceToml.${role}`)
                        : t(`pullRequest.files.${key}`, { mode })}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
          <section aria-labelledby={`${id}-checks`}>
            <h3
              id={`${id}-checks`}
              className="mb-1.5 text-sm font-semibold text-muted-foreground"
            >
              {t("pullRequest.checksLabel")}
            </h3>
            <CheckRows
              testId="init-wizard-checks"
              rows={INIT_CHECKS.map((check) => ({
                key: check,
                name: check,
                what: t.rich(`pullRequest.checks.${check}`, {
                  branch: productionBranch,
                  mode,
                  code,
                }),
              }))}
            />
          </section>
        </div>
      )}
      <p className="mt-4 font-mono text-xs text-dim">
        {t("needs")}
      </p>
    </SheetDialog>
  );
}

/** The permission table: the access this lifecycle needs, writes included. */
function PermissionTable() {
  const t = useTranslations("repositories.wizard.permissions");
  return (
    <div className="min-w-0 overflow-x-auto rounded-xl border border-border">
      <table
        aria-label={t("label")}
        data-testid="permission-table"
        className="w-full border-collapse text-sm"
      >
        <thead>
          <tr className="border-b border-border">
            {(["permission", "level", "for"] as const).map((column) => (
              <th key={column} scope="col" className={`${headCell} text-left`}>
                {t(`columns.${column}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {APP_PERMISSIONS.map((permission) => (
            <tr key={permission} data-permission={permission}>
              <td className={`${cell} font-semibold text-foreground`}>
                {t(`rows.${permission}.name`)}
              </td>
              <td className={`${cell} ${mono}`}>
                {t(`rows.${permission}.level`)}
              </td>
              <td
                className={`${cell} text-muted-foreground cell-max-wide`}
              >
                {t(`rows.${permission}.for`)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
      <label
        htmlFor={id}
        className="mb-1 block font-mono text-sm font-semibold text-muted-foreground"
      >
        {label}
      </label>
      <textarea
        id={id}
        data-testid={testId}
        rows={9}
        spellCheck={false}
        className={`min-h-40 font-mono text-lg sm:text-sm ${textareaBase}`}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
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
      <p className="text-base font-semibold text-foreground">
        {opened.reused
          ? t("reused", { number: opened.number, repository: opened.fullName })
          : t("opened", { number: opened.number, repository: opened.fullName })}
      </p>
      <p className={note}>{t("merge")}</p>
      {href === null ? null : (
        <div>
          <GitHubLink
            to={href}
            data-testid="init-wizard-pr-link"
            className={buttonSecondary}
          >
            {t("link", { number: opened.number })}
          </GitHubLink>
        </div>
      )}
    </div>
  );
}
