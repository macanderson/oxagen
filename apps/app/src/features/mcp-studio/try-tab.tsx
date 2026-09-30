"use client";
// A Studio server's Test tab (#4678, "Try it" in the spec): pick an environment and an
// imported tool, fill in its arguments, and see the request that went
// upstream, the raw result and the result after tools.toml's shaping. Save
// as test stages the call in the draft, and the steering PR adds it to the
// folder's tests/calls.jsonl.
//
// A run is a real call to the environment picked, recorded and metered like
// an agent's. The gateway adds the environment's credential after the
// request is recorded, so the request shown never holds it. Save as test
// still drops any credential header the record carries (scrubTest), since
// lane M11 refuses a saved test that holds one.
//
// Run calls try_studio_tool (#4742) through studio-calls.ts. Run is disabled,
// with a one-line note, while the record does not name the server's folder,
// because the call names the server by it.
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Badge } from "@/ui/badge";
import { CodeBlock } from "@/ui/code-panel";
import {
  buttonPrimary,
  buttonSecondary,
  fieldHint,
  fieldLabel,
  inputBase,
  panel,
  panelBody,
  panelHeader,
  panelTitle,
} from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { StateWrap } from "@/ui/state-wrap";
import { scrubTest } from "./draft";
import type { StudioGap } from "./gaps";
import type { StudioEnvironment, StudioTool } from "./model";
import { PendingNote } from "./pending-note";
import type { StudioAt } from "./route";
import {
  type TryResult,
  type TryStudioTool,
  tryStudioTool,
} from "./studio-calls";
import { useStudioDraft } from "./use-draft";

type Phase =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "badJson" }
  /** The call threw, so no answer came back. */
  | { kind: "error" }
  | {
      kind: "done";
      /** What was sent, kept so Save as test records the call that ran. */
      sent: { tool: string; environment: string; args: string };
      result: TryResult;
    };

type Saved =
  | { kind: "none" }
  /** Staged, with the credential headers removed on the way, if any. */
  | { kind: "saved"; stripped: readonly string[] }
  /** Staging refused the test: it breaks the draft's limits. */
  | { kind: "refused" }
  /** The record is not the shape a saved test holds, so nothing was staged. */
  | { kind: "badRecord" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The arguments as an object, or null when the text is not a JSON object. */
function argsOf(text: string): Readonly<Record<string, unknown>> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

function Output({
  title,
  code,
  testId,
}: {
  title: string;
  code: string;
  testId: string;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} data-testid={testId} className={panel}>
      <header className={panelHeader}>
        <h3 id={id} className={panelTitle}>
          {title}
        </h3>
      </header>
      <div className={panelBody}>
        <CodeBlock code={code} language="json" label={title} />
      </div>
    </section>
  );
}

export function TryTab({
  at,
  serverName,
  serverId,
  tools,
  environments,
  agentEnvironment,
  canEdit,
  call = tryStudioTool,
}: {
  /** The workspace the draft belongs to. */
  at: StudioAt;
  /** The folder name the draft is keyed by; null until the record names it. */
  serverName: string | null;
  serverId: string;
  tools: readonly StudioTool[];
  environments: readonly StudioEnvironment[];
  agentEnvironment: string | null;
  /** An org Owner or Admin, who can save a call as a test in the draft. */
  canEdit: boolean;
  /** The Test tab's capability. A test passes a fake. */
  call?: TryStudioTool;
}) {
  const t = useTranslations("mcpStudio.try");
  const draft = useStudioDraft({ at, serverName, serverId });
  const id = useId();
  const imported = tools.filter((tool) => tool.imported);
  const [environment, setEnvironment] = useState(
    agentEnvironment ??
      environments.find((env) => env.sandbox)?.name ??
      environments[0]?.name ??
      "",
  );
  const [tool, setTool] = useState(imported[0]?.name ?? "");
  const [args, setArgs] = useState("{}");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [saved, setSaved] = useState<Saved>({ kind: "none" });

  if (imported.length === 0) {
    return (
      <StateWrap
        tone="neutral"
        testId="studio-try-empty"
        title={t("empty.title")}
      >
        {t("empty.body")}
      </StateWrap>
    );
  }

  const chosen = environments.find((env) => env.name === environment);
  const live = chosen !== undefined && !chosen.sandbox;
  /** Why Run is off: no folder is named, so the call cannot name the server. */
  const blocked: StudioGap | null = serverName === null ? "record" : null;

  const run = async () => {
    if (serverName === null) return;
    const parsed = argsOf(args);
    if (parsed === null) {
      setPhase({ kind: "badJson" });
      return;
    }
    setPhase({ kind: "running" });
    setSaved({ kind: "none" });
    const sent = { tool, environment, args };
    try {
      const result = await call.call(at, {
        server: serverName,
        tool,
        environment,
        arguments: parsed,
      });
      setPhase({ kind: "done", sent, result });
    } catch {
      setPhase({ kind: "error" });
    }
  };

  const result = phase.kind === "done" ? phase.result : null;

  return (
    <div className="flex flex-col gap-4" data-testid="studio-try">
      <section aria-labelledby={`${id}-h`} className={panel}>
        <header className={panelHeader}>
          <h2 id={`${id}-h`} className={panelTitle}>
            {t("title")}
          </h2>
        </header>
        <form
          className={`${panelBody} flex flex-col gap-3`}
          onSubmit={(event) => {
            event.preventDefault();
            if (phase.kind === "running" || blocked !== null) return;
            void run();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`${id}-env`} className={fieldLabel}>
                {t("environment")}
              </label>
              <select
                id={`${id}-env`}
                data-testid="studio-try-environment"
                className={inputBase}
                value={environment}
                onChange={(event) => {
                  setEnvironment(event.target.value);
                }}
              >
                {environments.map((env) => (
                  <option key={env.name} value={env.name}>
                    {env.sandbox
                      ? t("sandboxOption", { name: env.name })
                      : env.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={`${id}-tool`} className={fieldLabel}>
                {t("tool")}
              </label>
              <select
                id={`${id}-tool`}
                data-testid="studio-try-tool"
                className={inputBase}
                value={tool}
                onChange={(event) => {
                  setTool(event.target.value);
                }}
              >
                {imported.map((candidate) => (
                  <option key={candidate.name} value={candidate.name}>
                    {candidate.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {live ? (
            <p
              data-testid="studio-try-live"
              className="flex items-center gap-2 text-[12.5px] text-foreground"
            >
              <Badge tone="denied">{t("liveBadge")}</Badge>
              {t("live")}
            </p>
          ) : null}
          <div>
            <label htmlFor={`${id}-args`} className={fieldLabel}>
              {t("args")}
            </label>
            <textarea
              id={`${id}-args`}
              data-testid="studio-try-args"
              rows={6}
              spellCheck={false}
              aria-invalid={phase.kind === "badJson" || undefined}
              aria-describedby={`${id}-args-hint`}
              className={`${inputBase} font-mono`}
              value={args}
              onChange={(event) => {
                setArgs(event.target.value);
              }}
            />
            <p id={`${id}-args-hint`} className={fieldHint}>
              {t("argsHint")}
            </p>
          </div>
          {phase.kind === "badJson" ? (
            <FormAlert testId="studio-try-bad-json">{t("badJson")}</FormAlert>
          ) : null}
          {phase.kind === "error" ? (
            <FormAlert testId="studio-try-error">{t("error")}</FormAlert>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              data-testid="studio-try-run"
              disabled={blocked !== null}
              aria-disabled={phase.kind === "running" || undefined}
              aria-describedby={blocked === null ? undefined : `${id}-pending`}
              data-capability={call.name}
              className={buttonPrimary}
            >
              {phase.kind === "running" ? t("running") : t("run")}
            </button>
          </div>
          {blocked === null ? null : (
            <PendingNote
              id={`${id}-pending`}
              capability={call.name}
              gap={blocked}
              testId="studio-try-pending"
            >
              {t("notBuilt")}
            </PendingNote>
          )}
          <p className="text-[12.5px] text-muted-foreground">
            {t("credentialNote")}
          </p>
        </form>
      </section>

      {result === null ? null : result.ok ? (
        <>
          <div className="grid min-w-0 gap-4 lg:grid-cols-3">
            <Output
              title={t("request")}
              code={result.request}
              testId="studio-try-request"
            />
            <Output
              title={t("raw")}
              code={result.raw}
              testId="studio-try-raw"
            />
            <Output
              title={t("shaped")}
              code={result.shaped}
              testId="studio-try-shaped"
            />
          </div>
          {canEdit && phase.kind === "done" ? (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="studio-try-save"
                className={buttonSecondary}
                aria-disabled={saved.kind === "saved" || undefined}
                onClick={() => {
                  if (saved.kind === "saved") return;
                  const scrubbed = scrubTest({
                    request: result.request,
                    raw: result.raw,
                    shaped: result.shaped,
                  });
                  if (!scrubbed.ok) {
                    setSaved({ kind: "badRecord" });
                    return;
                  }
                  const ok = draft.stage({
                    kind: "test",
                    ...phase.sent,
                    request: scrubbed.request,
                    raw: scrubbed.raw,
                    shaped: scrubbed.shaped,
                  });
                  setSaved(
                    ok
                      ? { kind: "saved", stripped: scrubbed.removed }
                      : { kind: "refused" },
                  );
                }}
              >
                {t("save")}
              </button>
              {saved.kind === "saved" ? (
                <span
                  role="status"
                  data-testid="studio-try-saved"
                  className="text-[12.5px] text-muted-foreground"
                >
                  {t("saved")}
                </span>
              ) : null}
              {saved.kind === "refused" ? (
                <FormAlert testId="studio-try-too-large">
                  {t("tooLarge")}
                </FormAlert>
              ) : null}
              {saved.kind === "badRecord" ? (
                <FormAlert testId="studio-try-bad-record">
                  {t("badRecord")}
                </FormAlert>
              ) : null}
            </div>
          ) : null}
          {saved.kind === "saved" && saved.stripped.length > 0 ? (
            <p
              data-testid="studio-try-stripped"
              className="text-[12.5px] text-muted-foreground"
            >
              {t("stripped", {
                count: saved.stripped.length,
                headers: saved.stripped.join(", "),
              })}
            </p>
          ) : null}
        </>
      ) : result.reason === "denied" ? (
        <FormAlert testId="studio-try-denied">
          {t("denied", { message: result.message })}
        </FormAlert>
      ) : (
        <FormAlert testId="studio-try-failed">
          {t("failed", { message: result.message })}
        </FormAlert>
      )}
    </div>
  );
}
