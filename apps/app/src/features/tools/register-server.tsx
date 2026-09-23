"use client";
// Register an MCP server (lane: connections): health check an endpoint, record
// what it pins and store any auth config encrypted.
//
// Registering is not importing. The server row is what a tool server kill
// switch names and what `import_tools` reads from; no tool version reaches the
// registry until the import above runs. The dialog says what was discovered
// and stops there.
//
// The form offers HTTP, which the runtime can connect to. A server
// carrying `sse` exists in the table and was written by a plugin install, so
// the list admits that word and this form does not offer it.
//
// `authConfig` is secret material and is handled the way the add-connection
// dialog handles a credential: typed once, sent once, never rendered back and
// never in a failure message.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useState } from "react";
import {
  MCP_AUTH_STRATEGIES,
  type McpAuthStrategy,
  REGISTERABLE_MCP_TRANSPORTS,
  type RegisterableMcpTransport,
} from "@/data/contracts/tools";
import { routes } from "@/shared/safe-path";
import { buttonSecondary, inputBase, mono } from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { UNANSWERED, useActionFailure } from "./action-failure";
import { registerServer } from "./actions";
import { parseMeasureLines, textValue, type ToolsAt } from "./view";

const TESTID = "server-register";

/** A form value as a supported endpoint transport. */
function transportOf(raw: string): RegisterableMcpTransport {
  return (
    REGISTERABLE_MCP_TRANSPORTS.find((option) => option === raw) ??
    REGISTERABLE_MCP_TRANSPORTS[0]
  );
}

function strategyOf(raw: string): McpAuthStrategy {
  return MCP_AUTH_STRATEGIES.find((option) => option === raw) ?? "none";
}

export function RegisterServer({ at }: { at: ToolsAt }) {
  const t = useTranslations("tools.servers.register");
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [transport, setTransport] = useState<RegisterableMcpTransport>(
    REGISTERABLE_MCP_TRANSPORTS[0],
  );
  const [strategy, setStrategy] = useState<McpAuthStrategy>("none");
  const [done, setDone] = useState<{
    id: string;
    name: string;
    health: "healthy" | "degraded" | "unreachable";
    tools: number;
  } | null>(null);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const chosenStrategy = strategyOf(textValue(form, "authStrategy"));
    // `name = value` lines, refused whole when a line is malformed: a config
    // that silently lost its token would register a server that cannot
    // authenticate and report it as healthy or not, with no line to point at.
    const pairs =
      chosenStrategy === "none"
        ? []
        : parseMeasureLines(textValue(form, "authConfig"));
    if (pairs === null) {
      setFailure(
        failureText({ ok: false, reason: "invalid", code: "invalid_input" }),
      );
      return;
    }
    const name = textValue(form, "name");
    setPending(true);
    setFailure(null);
    try {
      const result = await registerServer(at.org, at.ws, {
        name,
        transportType: transportOf(textValue(form, "transportType")),
        endpointUrl: textValue(form, "endpointUrl"),
        authStrategy: chosenStrategy,
        authConfig: Object.fromEntries(pairs),
      });
      if (result.ok) {
        setDone({
          id: result.value.serverId,
          name: name.trim(),
          health: result.value.healthStatus,
          tools: result.value.discoveredTools.length,
        });
        navigate.replace(routes.tools(at.org, at.ws));
        return;
      }
      setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        data-testid={`${TESTID}-open`}
        className={buttonSecondary}
        onClick={() => {
          setOpen(true);
        }}
      >
        {t("open")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setFailure(null);
            setDone(null);
          }
        }}
        title={t("title")}
        testId={`${TESTID}-dialog`}
      >
        {done === null ? (
          <form
            onSubmit={(e) => void submit(e)}
            className="flex flex-col gap-3"
          >
            <p className="text-sm text-muted-foreground">{t("body")}</p>
            <div className="flex min-w-0 flex-col gap-1.5">
              <label
                htmlFor="name"
                className="text-sm font-medium text-foreground"
              >
                {t("name")}
              </label>
              <input
                id="name"
                name="name"
                required
                maxLength={120}
                className={inputBase}
              />
              <p className="text-xs text-muted-foreground">{t("nameHint")}</p>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <label
                htmlFor="transportType"
                className="text-sm font-medium text-foreground"
              >
                {t("transport")}
              </label>
              <select
                id="transportType"
                name="transportType"
                value={transport}
                onChange={(event) => {
                  setTransport(transportOf(event.currentTarget.value));
                }}
                className={inputBase}
              >
                {REGISTERABLE_MCP_TRANSPORTS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {t("transportHint")}
              </p>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <label
                htmlFor="endpointUrl"
                className="text-sm font-medium text-foreground"
              >
                {t("endpoint")}
              </label>
              <input
                id="endpointUrl"
                name="endpointUrl"
                type="url"
                required
                className={`${inputBase} ${mono}`}
              />
              <p className="text-xs text-muted-foreground">
                {t("endpointHint")}
              </p>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <label
                htmlFor="authStrategy"
                className="text-sm font-medium text-foreground"
              >
                {t("authStrategy")}
              </label>
              <select
                id="authStrategy"
                name="authStrategy"
                value={strategy}
                onChange={(event) => {
                  setStrategy(strategyOf(event.currentTarget.value));
                }}
                className={inputBase}
              >
                {MCP_AUTH_STRATEGIES.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
            {strategy === "none" ? null : (
              <div className="flex min-w-0 flex-col gap-1.5">
                <label
                  htmlFor="authConfig"
                  className="text-sm font-medium text-foreground"
                >
                  {t("authConfig")}
                </label>
                <textarea
                  id="authConfig"
                  name="authConfig"
                  rows={2}
                  required
                  autoComplete="off"
                  placeholder={t("authConfigPlaceholder")}
                  className={`${inputBase} ${mono}`}
                />
                <p className="text-xs text-muted-foreground">
                  {t("authConfigHint")}
                </p>
              </div>
            )}
            {failure === null ? null : (
              <FormAlert testId={`${TESTID}-failure`}>{failure}</FormAlert>
            )}
            <SubmitButton
              pending={pending}
              label={t("confirm")}
              pendingLabel={t("pending")}
            />
          </form>
        ) : (
          <p
            data-testid={`${TESTID}-done`}
            className="rounded-lg border border-border bg-muted px-3 py-2.5 text-sm text-foreground"
          >
            {t("done", {
              name: done.name,
              id: done.id,
              health: t(`doneHealth.${done.health}`),
              tools: done.tools,
            })}
          </p>
        )}
      </SheetDialog>
    </>
  );
}
