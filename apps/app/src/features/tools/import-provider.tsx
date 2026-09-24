"use client";
// Import a provider (mockup `tools.md`, the `import` dialog): three steps,
// Connect → Review tools/list → Classify and import.
//
//  1. **Connect** registers a new provider (`register_mcp_server`: the handler
//     health checks the endpoint, envelope-encrypts the auth config and records
//     the tools it lists), or picks one already registered.
//  2. **Review tools/list** offers every tool the provider listed, each checked,
//     so a person can leave one out. A provider picked from the roster lists no
//     names on this read, so the step takes names typed, or every pin when left
//     blank.
//  3. **Classify and import** says what import does and does not do, then runs
//     `import_tools`: one immutable version per changed manifest, idempotent on
//     an unchanged one. An imported version lands unclassified; the tool dialog
//     is where it is classified.
//
// The auth config is secret material: typed once, sent once, never rendered
// back and never in a failure message.
import { useTranslations } from "next-intl";
import { type ReactNode, type SyntheticEvent, useState } from "react";
import {
  MCP_AUTH_STRATEGIES,
  type McpAuthStrategy,
  REGISTERABLE_MCP_TRANSPORTS,
  type RegisterableMcpTransport,
} from "@/data/contracts/tools";
import {
  buttonPrimary,
  buttonSecondary,
  inputBase,
  mono,
} from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { UNANSWERED, useActionFailure } from "./action-failure";
import { importTools, registerServer } from "./actions";
import { parseMeasureLines, splitTags, textValue, type ToolsAt } from "./view";

const TESTID = "tools-import";
const NEW = "__new__";

type Step = 1 | 2 | 3;

const STEP_KEYS = { 1: "s1", 2: "s2", 3: "s3" } as const;

/** The provider the later steps work on, and the tool names it listed. */
type Connected = {
  id: string;
  name: string;
  /** Null when the provider came from the roster, which lists no names. */
  listed: readonly string[] | null;
};

function transportOf(raw: string): RegisterableMcpTransport {
  return (
    REGISTERABLE_MCP_TRANSPORTS.find((option) => option === raw) ??
    REGISTERABLE_MCP_TRANSPORTS[0]
  );
}

function strategyOf(raw: string): McpAuthStrategy {
  return MCP_AUTH_STRATEGIES.find((option) => option === raw) ?? "none";
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      {children}
      {hint === undefined ? null : (
        <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

function Steps({ step }: { step: Step }) {
  const t = useTranslations("tools.import.steps");
  return (
    <ol
      aria-label={t("label")}
      className="mb-1 flex flex-wrap items-center gap-2 text-xs"
    >
      {([1, 2, 3] as const).map((n) => (
        <li
          key={n}
          aria-current={n === step ? "step" : undefined}
          data-step={n}
          className={`rounded border px-2 py-0.5 ${
            n === step
              ? "border-foreground text-foreground"
              : "border-border text-muted-foreground"
          }`}
        >
          {t(STEP_KEYS[n])}
        </li>
      ))}
    </ol>
  );
}

export function ImportProvider({
  at,
  servers,
  primary = false,
  label = "import",
  compact = false,
}: {
  at: ToolsAt;
  /** The workspace's registered providers, or null when the roster read failed. */
  servers: readonly { id: string; name: string }[] | null;
  /** Gold only where it is the screen's one primary action. */
  primary?: boolean;
  /** "Import a provider" in the header and the Tools panel; "Add a provider" on Providers. */
  label?: "import" | "add";
  /** The Tools panel header's copy of the control: the trigger drops to one line. */
  compact?: boolean;
}) {
  const t = useTranslations("tools.import");
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>(1);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [pick, setPick] = useState<string>(NEW);
  const [strategy, setStrategy] = useState<McpAuthStrategy>("none");
  const [connected, setConnected] = useState<Connected | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [typed, setTyped] = useState("");
  const [done, setDone] = useState<{
    published: number;
    unchanged: number;
  } | null>(null);

  function reset() {
    setStep(1);
    setFailure(null);
    setPick(NEW);
    setStrategy("none");
    setConnected(null);
    setSelected(new Set());
    setTyped("");
    setDone(null);
  }

  async function connect(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setFailure(null);
    if (pick !== NEW) {
      const server = servers?.find((s) => s.id === pick);
      if (server === undefined) return;
      setConnected({ id: server.id, name: server.name, listed: null });
      setStep(2);
      return;
    }
    const form = new FormData(event.currentTarget);
    const chosen = strategyOf(textValue(form, "authStrategy"));
    const pairs =
      chosen === "none" ? [] : parseMeasureLines(textValue(form, "authConfig"));
    if (pairs === null) {
      setFailure(
        failureText({ ok: false, reason: "invalid", code: "invalid_input" }),
      );
      return;
    }
    const name = textValue(form, "name").trim();
    setPending(true);
    try {
      const result = await registerServer(at.org, at.ws, {
        name,
        transportType: transportOf(textValue(form, "transportType")),
        endpointUrl: textValue(form, "endpointUrl"),
        authStrategy: chosen,
        authConfig: Object.fromEntries(pairs),
      });
      if (!result.ok) {
        setFailure(failureText(result));
        return;
      }
      setConnected({
        id: result.value.serverId,
        name,
        listed: result.value.discoveredTools,
      });
      setSelected(new Set(result.value.discoveredTools));
      setStep(2);
      // The provider now exists whether or not anything is imported, so the
      // page behind the dialog re-reads its roster.
      navigate.refresh();
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  /** The names step 3 imports: the checked ones, or the typed ones (blank is every pin). */
  const chosenTools: readonly string[] =
    connected?.listed === null ? splitTags(typed) : [...selected];

  async function runImport() {
    if (pending || connected === null) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await importTools(at.org, at.ws, {
        serverId: connected.id,
        tools: chosenTools,
      });
      if (!result.ok) {
        setFailure(failureText(result));
        return;
      }
      setDone({
        published: result.value.published,
        unchanged: result.value.unchanged,
      });
      // Re-read the tab the person is on rather than moving them: the dialog
      // may live in a tab's own panel (Add a provider on Providers), and
      // navigating away would unmount it before its receipt is read (#3800).
      navigate.refresh();
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  const listed = connected?.listed ?? null;
  const title =
    step === 1
      ? t("title")
      : step === 2
        ? t("reviewTitle")
        : t("classifyTitle");
  const subtitle =
    step === 1
      ? t("subtitle")
      : listed === null
        ? connected?.name
        : t("reviewSubtitle", {
            count: listed.length,
            name: connected?.name ?? "",
          });

  const footer =
    step === 1 ? (
      <button
        type="submit"
        form={`${TESTID}-connect`}
        data-testid={`${TESTID}-connect`}
        aria-disabled={pending || undefined}
        className={buttonPrimary}
      >
        {pending ? t("pending") : t("connect")}
      </button>
    ) : step === 2 ? (
      <>
        <button
          type="button"
          className={buttonSecondary}
          onClick={() => {
            setStep(1);
          }}
        >
          {t("back")}
        </button>
        <button
          type="button"
          data-testid={`${TESTID}-classify`}
          disabled={listed !== null && selected.size === 0}
          className={buttonPrimary}
          onClick={() => {
            setStep(3);
          }}
        >
          {t("classify")}
        </button>
      </>
    ) : (
      <>
        <button
          type="button"
          className={buttonSecondary}
          onClick={() => {
            setStep(2);
          }}
        >
          {t("back")}
        </button>
        <button
          type="button"
          data-testid={`${TESTID}-confirm`}
          aria-disabled={pending || done !== null || undefined}
          className={buttonPrimary}
          onClick={() => void runImport()}
        >
          {pending
            ? t("importing")
            : chosenTools.length === 0
              ? t("importAll")
              : t("importCount", { count: chosenTools.length })}
        </button>
      </>
    );

  return (
    <>
      <button
        type="button"
        data-testid={`${TESTID}-open`}
        className={`${primary ? buttonPrimary : buttonSecondary} ${compact ? "whitespace-nowrap" : ""}`}
        onClick={() => {
          setOpen(true);
        }}
      >
        {label === "add" ? t("openAdd") : t("open")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
        title={title}
        subtitle={subtitle}
        wide={step !== 1}
        closeLabel={t("cancel")}
        testId={`${TESTID}-dialog`}
        footer={footer}
      >
        <div className="flex flex-col gap-3">
          <Steps step={step} />
          {step === 1 ? (
            <form
              id={`${TESTID}-connect`}
              onSubmit={(e) => void connect(e)}
              className="flex flex-col gap-3"
            >
              <Field id="import-provider" label={t("provider")}>
                <select
                  id="import-provider"
                  value={pick}
                  onChange={(event) => {
                    setPick(event.currentTarget.value);
                  }}
                  className={inputBase}
                >
                  <option value={NEW}>{t("newProvider")}</option>
                  {(servers ?? []).map((server) => (
                    <option key={server.id} value={server.id}>
                      {server.name}
                    </option>
                  ))}
                </select>
              </Field>
              {pick === NEW ? (
                <>
                  <Field
                    id="import-name"
                    label={t("name")}
                    hint={t("nameHint")}
                  >
                    <input
                      id="import-name"
                      name="name"
                      required
                      maxLength={120}
                      className={inputBase}
                    />
                  </Field>
                  <Field
                    id="import-endpoint"
                    label={t("endpoint")}
                    hint={t("endpointHint")}
                  >
                    <input
                      id="import-endpoint"
                      name="endpointUrl"
                      type="url"
                      required
                      className={`${inputBase} ${mono}`}
                    />
                  </Field>
                  <Field
                    id="import-transport"
                    label={t("wire")}
                    hint={t("wireHint")}
                  >
                    <select
                      id="import-transport"
                      name="transportType"
                      defaultValue={REGISTERABLE_MCP_TRANSPORTS[0]}
                      className={inputBase}
                    >
                      {REGISTERABLE_MCP_TRANSPORTS.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field id="import-auth" label={t("auth")}>
                    <select
                      id="import-auth"
                      name="authStrategy"
                      value={strategy}
                      onChange={(event) => {
                        setStrategy(strategyOf(event.currentTarget.value));
                      }}
                      className={inputBase}
                    >
                      {MCP_AUTH_STRATEGIES.map((option) => (
                        <option key={option} value={option}>
                          {t(`authStrategies.${option}`)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {strategy === "none" ? null : (
                    <Field
                      id="import-auth-config"
                      label={t("authConfig")}
                      hint={t("authConfigHint")}
                    >
                      <textarea
                        id="import-auth-config"
                        name="authConfig"
                        rows={2}
                        required
                        autoComplete="off"
                        placeholder={t("authConfigPlaceholder")}
                        className={`${inputBase} ${mono}`}
                      />
                    </Field>
                  )}
                </>
              ) : null}
              <p className="rounded-lg border border-border px-3 py-2.5 text-[13px] text-muted-foreground">
                {t("connectNote")}
              </p>
            </form>
          ) : null}

          {step === 2 ? (
            listed === null ? (
              <Field id="import-tools" label={t("tools")} hint={t("toolsHint")}>
                <input
                  id="import-tools"
                  value={typed}
                  onChange={(event) => {
                    setTyped(event.currentTarget.value);
                  }}
                  className={`${inputBase} ${mono}`}
                />
              </Field>
            ) : listed.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("nothingListed")}
              </p>
            ) : (
              <fieldset className="flex flex-col gap-1.5">
                <legend className="mb-1 text-sm font-medium text-foreground">
                  {t("listed")}
                </legend>
                {listed.map((tool) => (
                  <label
                    key={tool}
                    className="flex min-h-9 items-center gap-2.5 rounded-md border border-border px-3 py-1.5 text-[13px] max-md:min-h-11"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(tool)}
                      onChange={(event) => {
                        const next = new Set(selected);
                        if (event.currentTarget.checked) next.add(tool);
                        else next.delete(tool);
                        setSelected(next);
                      }}
                    />
                    <span className={mono}>{tool}</span>
                  </label>
                ))}
                <p
                  data-testid={`${TESTID}-selected`}
                  className="text-xs text-muted-foreground"
                >
                  {t("selected", {
                    selected: selected.size,
                    total: listed.length,
                  })}
                </p>
              </fieldset>
            )
          ) : null}

          {step === 3 ? (
            <>
              {chosenTools.length === 0 ? (
                <p className="text-sm text-foreground">{t("allPins")}</p>
              ) : (
                <ul className="flex flex-wrap gap-1.5">
                  {chosenTools.map((tool) => (
                    <li
                      key={tool}
                      className={`${mono} rounded border border-border px-1.5 py-0.5 text-xs`}
                    >
                      {tool}
                    </li>
                  ))}
                </ul>
              )}
              <p className="rounded-lg border border-border px-3 py-2.5 text-[13px] text-muted-foreground">
                <b className="font-semibold text-foreground">
                  {t("grantsNothingTitle")}
                </b>{" "}
                {t("grantsNothing")}
              </p>
              {done === null ? null : (
                <p
                  role="status"
                  data-testid={`${TESTID}-done`}
                  className="rounded-lg border border-border bg-muted px-3 py-2.5 text-sm text-foreground"
                >
                  {t("done", {
                    published: done.published,
                    unchanged: done.unchanged,
                  })}
                </p>
              )}
            </>
          ) : null}

          {failure === null ? null : (
            <FormAlert testId={`${TESTID}-failure`}>{failure}</FormAlert>
          )}
        </div>
      </SheetDialog>
    </>
  );
}
