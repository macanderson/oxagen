"use client";
// The Repositories tab's table (MC spec §10.1; the §17 M0 acceptance test "a
// second repo can be linked and unlinked"): every repository the workspace
// binds, main first, with its role, production branch, whether it carries
// `.oxagen/`, whether GitHub can deliver its events, and its code graph.
//
// A workspace has one main repository and any number of linked ones, the
// repositories its agents work on. The main row never offers an unlink: a
// workspace without a main repo cannot exist, `unlink_repository` refuses it
// with `main_repo_unlink_refused`, and a control that can only refuse is a
// control that lies. Below the table, the repositories the installation
// reaches that nobody has bound, each with its own Link, and a field that
// links one by `owner/name` when the installation reaches more than GitHub
// listed.
//
// The rows are local facts (`list_repositories` makes no GitHub call), so the
// table draws while GitHub is down. The `.oxagen/` column is a live read per
// repository and says so when it could not be made.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useEffect, useId, useState } from "react";
import type {
  InstallationRepositories,
  RepositoryTree,
  WorkspaceRepositories,
} from "@/data/contracts/repository";
import { parseGitHubUrl } from "@/shared/github-url";
import {
  buttonSecondary,
  eyebrow,
  inputBase,
  linkText,
} from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { GitHubLink } from "@/ui/navigation";
import { cell, Table } from "@/ui/table";
import {
  linkWorkspaceRepository,
  listInstallationRepositories,
  unlinkWorkspaceRepository,
} from "./actions";
import { UNANSWERED, useRepositoriesFailure } from "./failure";
import { badge, Dot, type Load, prose, sectionTitle, type Tone } from "./parts";

export type BoundRepositoryRow = WorkspaceRepositories["repositories"][number];

/**
 * `owner/name` as a person types it or pastes it from GitHub: surrounding
 * space and a trailing `.git` are dropped, and anything that is not exactly
 * two non-empty segments is not a repository. The segments' own spelling is
 * the contract's to judge, so this only splits.
 */
function parseRepository(text: string): { owner: string; name: string } | null {
  const trimmed = text.trim().replace(/\.git$/, "");
  const parts = trimmed.split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  if (owner === undefined || name === undefined) return null;
  if (owner === "" || name === "") return null;
  return { owner, name };
}

const EVENT_TONE: Record<BoundRepositoryRow["events"], Tone> = {
  installed: "ok",
  paused: "warn",
  suspended: "bad",
  uninstalled: "bad",
  retired: "bad",
  unknown: "idle",
};

/** The `.oxagen/` cell: governed, not governed, unread, or a branch that is gone. */
export function TreeState({
  tree,
  testId,
}: {
  tree: Load<RepositoryTree> | undefined;
  testId?: string;
}) {
  const t = useTranslations("repositories.table.tree");
  if (tree === undefined || tree.kind === "loading")
    return (
      <Dot tone="idle" testId={testId}>
        {t("reading")}
      </Dot>
    );
  if (tree.kind === "failed")
    return (
      <Dot tone="idle" testId={testId}>
        {t("unread")}
      </Dot>
    );
  if (tree.value.head === null)
    return (
      <Dot tone="bad" testId={testId}>
        {t("branchMissing")}
      </Dot>
    );
  return tree.value.oxagen.present ? (
    <Dot tone="ok" testId={testId}>
      {t("governed", { files: tree.value.oxagen.files.length })}
    </Dot>
  ) : (
    <Dot tone="warn" testId={testId}>
      {t("absent")}
    </Dot>
  );
}

export function RepositoryTable({
  org,
  ws,
  repositories,
  trees,
  onOpen,
  onChanged,
}: {
  org: string;
  ws: string;
  repositories: BoundRepositoryRow[];
  trees: Readonly<Record<string, Load<RepositoryTree>>>;
  /** Open the repository dialog on one row. */
  onOpen: (bindingId: string) => void;
  /** A link or an unlink settled; the page re-reads. */
  onChanged: () => void;
}) {
  const t = useTranslations("repositories.table");
  return (
    <>
      <Table
        label={t("label")}
        columns={[
          { label: t("columns.repository") },
          { label: t("columns.role") },
          { label: t("columns.productionBranch") },
          { label: t("columns.oxagen") },
          { label: t("columns.events") },
          { label: t("columns.symbols") },
          { label: t("columns.action") },
        ]}
      >
        {repositories.map((repository) => (
          <RepositoryRow
            key={repository.bindingId}
            org={org}
            ws={ws}
            repository={repository}
            tree={trees[repository.bindingId]}
            onOpen={onOpen}
            onUnlinked={onChanged}
          />
        ))}
      </Table>
      {repositories.every((repository) => repository.role === "main") ? (
        <p
          data-testid="workspace-repository-list-only-main"
          className={`mt-2 ${prose}`}
        >
          {t("onlyMain")}
        </p>
      ) : null}
    </>
  );
}

function RepositoryRow({
  org,
  ws,
  repository,
  tree,
  onOpen,
  onUnlinked,
}: {
  org: string;
  ws: string;
  repository: BoundRepositoryRow;
  tree: Load<RepositoryTree> | undefined;
  onOpen: (bindingId: string) => void;
  onUnlinked: () => void;
}) {
  const t = useTranslations("repositories.table");
  const href = parseGitHubUrl(repository.htmlUrl);
  const id = repository.bindingId;
  const name = (
    <span className="min-w-0 break-all font-mono text-[13px] font-semibold text-foreground">
      {repository.fullName}
    </span>
  );
  return (
    <tr
      data-testid={`workspace-repository-row-${id}`}
      data-role={repository.role}
    >
      <td className={cell}>
        {href === null ? (
          name
        ) : (
          <GitHubLink
            to={href}
            data-testid={`workspace-repository-open-${id}`}
            title={t("openOnGitHub")}
            className={`min-w-0 ${linkText}`}
          >
            {name}
          </GitHubLink>
        )}
        {repository.connectionLive ? null : (
          <p
            data-testid={`workspace-repository-retired-${id}`}
            className="mt-1 text-xs leading-relaxed text-destructive"
          >
            {t("retired")}
          </p>
        )}
      </td>
      <td className={cell}>
        <span className={badge}>
          {repository.role === "main" ? t("roleMain") : t("roleLinked")}
        </span>
      </td>
      <td className={`${cell} font-mono text-xs`}>{repository.defaultRef}</td>
      <td className={cell}>
        <TreeState tree={tree} testId={`workspace-repository-tree-${id}`} />
      </td>
      <td className={cell}>
        <Dot tone={EVENT_TONE[repository.events]}>
          {t(`events.${repository.events}`)}
        </Dot>
      </td>
      <td className={cell}>
        <span className="text-xs text-muted-foreground">
          {t("symbolsNotRecorded")}
        </span>
      </td>
      <td className={cell}>
        <div className="flex flex-col items-start gap-2">
          <button
            type="button"
            data-testid={`workspace-repository-details-${id}`}
            data-touch-target=""
            aria-haspopup="dialog"
            className={buttonSecondary}
            onClick={() => {
              onOpen(id);
            }}
          >
            {t("details")}
          </button>
          {repository.role === "linked" ? (
            <UnlinkRepository
              org={org}
              ws={ws}
              repository={repository}
              onUnlinked={onUnlinked}
            />
          ) : null}
        </div>
      </td>
    </tr>
  );
}

/**
 * The repositories the installation reaches that this workspace does not
 * bind, each one a Link away. A live GitHub call made once per page load. A
 * workspace with no installation is refused with `github_not_connected`,
 * which the setup panel below already answers, so that refusal draws nothing.
 */
export function ReachableRepositories({
  org,
  ws,
  bound,
  version,
  onLinked,
}: {
  org: string;
  ws: string;
  /** `owner/name` of every repository already bound, so none is offered twice. */
  bound: readonly string[];
  version: number;
  onLinked: () => void;
}) {
  const t = useTranslations("repositories.table.reachable");
  const failureText = useRepositoriesFailure();
  const [listing, setListing] = useState<Load<InstallationRepositories>>({
    kind: "loading",
  });
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const live = { current: true };
    const cancelled = () => !live.current;
    const load = async () => {
      let read;
      try {
        read = await listInstallationRepositories(org, ws);
      } catch {
        read = UNANSWERED;
      }
      if (cancelled()) return;
      setListing(
        read.ok
          ? { kind: "ready", value: read.value }
          : { kind: "failed", failure: read },
      );
    };
    void load();
    return () => {
      live.current = false;
    };
  }, [org, ws, version]);

  if (listing.kind === "loading") return null;
  if (listing.kind === "failed") {
    const quiet =
      "code" in listing.failure &&
      (listing.failure.code === "github_not_connected" ||
        listing.failure.code === "github_not_authorized");
    return quiet ? null : (
      <div className="mt-4">
        <FormAlert testId="workspace-repository-reachable-failure">
          {failureText(listing.failure)}
        </FormAlert>
      </div>
    );
  }
  const boundNames = new Set(bound.map((name) => name.toLowerCase()));
  const rows = listing.value.repositories.filter(
    (repository) => !boundNames.has(repository.fullName.toLowerCase()),
  );
  if (rows.length === 0) return null;

  async function link(owner: string, name: string, fullName: string) {
    if (pending !== null) return;
    setPending(fullName);
    setFailure(null);
    try {
      const result = await linkWorkspaceRepository(org, ws, { owner, name });
      if (result.ok) onLinked();
      else setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(null);
    }
  }

  return (
    <section
      data-testid="workspace-repository-reachable"
      aria-labelledby="workspace-repository-reachable"
      className="mt-6"
    >
      <h3 id="workspace-repository-reachable" className={sectionTitle}>
        {t("heading")}
      </h3>
      <p className={`mt-1 ${prose}`}>{t("about")}</p>
      {failure === null ? null : (
        <div className="mt-3">
          <FormAlert testId="workspace-repository-reachable-link-failure">
            {failure}
          </FormAlert>
        </div>
      )}
      <div className="mt-3">
        <Table
          label={t("label")}
          columns={[
            { label: t("columns.repository") },
            { label: t("columns.role") },
            { label: t("columns.defaultBranch") },
            { label: t("columns.action") },
          ]}
        >
          {rows.map((repository) => (
            <tr
              key={repository.id}
              data-testid={`workspace-repository-reachable-${repository.fullName}`}
            >
              <td className={`${cell} break-all font-mono text-[13px]`}>
                {repository.fullName}
              </td>
              <td className={cell}>
                <span className={badge}>{t("notLinked")}</span>
              </td>
              <td className={`${cell} font-mono text-xs`}>
                {repository.defaultBranch}
              </td>
              <td className={cell}>
                <button
                  type="button"
                  data-touch-target=""
                  disabled={pending !== null}
                  className={buttonSecondary}
                  onClick={() => {
                    void link(
                      repository.owner,
                      repository.name,
                      repository.fullName,
                    );
                  }}
                >
                  {pending === repository.fullName ? t("linking") : t("link")}
                </button>
              </td>
            </tr>
          ))}
        </Table>
      </div>
      {listing.value.truncated ? (
        <p className={`mt-2 text-xs ${prose}`}>{t("truncated")}</p>
      ) : null}
    </section>
  );
}

/**
 * The unlink, confirmed in place. A question drawn on the row keeps the
 * repository it is about in view and the way back one click away.
 */
function UnlinkRepository({
  org,
  ws,
  repository,
  onUnlinked,
}: {
  org: string;
  ws: string;
  repository: BoundRepositoryRow;
  onUnlinked: () => void;
}) {
  const t = useTranslations("repositories.table");
  const failureText = useRepositoriesFailure();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const id = repository.bindingId;

  async function unlink(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await unlinkWorkspaceRepository(org, ws, id);
      if (result.ok) onUnlinked();
      else setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  if (!confirming) {
    return (
      <div className="mt-1 flex">
        <button
          type="button"
          data-testid={`workspace-repository-unlink-${id}`}
          data-touch-target=""
          className={buttonSecondary}
          onClick={() => {
            setConfirming(true);
          }}
        >
          {t("unlink")}
        </button>
      </div>
    );
  }
  return (
    <form
      noValidate
      data-testid={`workspace-repository-unlink-confirm-${id}`}
      className="mt-1 flex flex-col gap-2"
      onSubmit={(e) => void unlink(e)}
    >
      <p className={prose}>
        {t("unlinkConfirm", { repository: repository.fullName })}
      </p>
      {failure === null ? null : (
        <FormAlert testId={`workspace-repository-unlink-failure-${id}`}>
          {failure}
        </FormAlert>
      )}
      <div className="flex flex-wrap gap-2">
        <SubmitButton
          pending={pending}
          fullWidth={false}
          secondary
          label={t("unlinkYes")}
          pendingLabel={t("unlinking")}
        />
        <button
          type="button"
          data-testid={`workspace-repository-unlink-keep-${id}`}
          data-touch-target=""
          className={buttonSecondary}
          onClick={() => {
            setConfirming(false);
            setFailure(null);
          }}
        >
          {t("unlinkNo")}
        </button>
      </div>
    </form>
  );
}

/**
 * One field and one submit, for a repository the listing above did not show
 * (the installation reaches more than GitHub listed, or the listing could not
 * be read). The link refuses a repository the installation cannot see with a
 * sentence of its own.
 */
export function LinkRepository({
  org,
  ws,
  onLinked,
}: {
  org: string;
  ws: string;
  onLinked: () => void;
}) {
  const t = useTranslations("repositories.table.link");
  const failureText = useRepositoriesFailure();
  const fieldId = useId();
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function link(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const repository = parseRepository(text);
    if (repository === null) {
      setFailure(t("unparsable"));
      return;
    }
    setPending(true);
    setFailure(null);
    try {
      const result = await linkWorkspaceRepository(org, ws, repository);
      if (result.ok) {
        setText("");
        onLinked();
      } else setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      noValidate
      data-testid="workspace-repository-link"
      className="mt-4"
      onSubmit={(e) => void link(e)}
    >
      <h4 className={sectionTitle}>{t("heading")}</h4>
      <label htmlFor={fieldId} className={`mt-3 block ${eyebrow}`}>
        {t("label")}
      </label>
      <input
        id={fieldId}
        type="text"
        data-testid="workspace-repository-link-input"
        className={`mt-1 font-mono ${inputBase}`}
        placeholder={t("placeholder")}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        aria-describedby={`${fieldId}-hint`}
        aria-invalid={failure === null ? undefined : true}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
        }}
      />
      <p id={`${fieldId}-hint`} className={`mt-1 text-xs ${prose}`}>
        {t("hint")}
      </p>
      {failure === null ? null : (
        <div className="mt-3">
          <FormAlert testId="workspace-repository-link-failure">
            {failure}
          </FormAlert>
        </div>
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
  );
}
