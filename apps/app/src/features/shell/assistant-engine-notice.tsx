"use client";
// The line above the composer while stella's engine takes no turn (#3227). It
// names the state the engine reported, gives the probe's code beneath it the
// way a refused turn gives its code, and offers Check again. The flyout points
// Send's `aria-describedby` at the sentence, so the reason Send is held is what
// a screen reader reads on Send.
//
// `role="alert"`, like a refused turn: the line can appear seconds after the
// panel opens, once the probe of a down engine gives up, and it stops the
// person from sending, so it interrupts rather than waiting to be found.
import { CircleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { linkText } from "@/ui/control-styles";
import type { EngineDown, EngineHealth } from "./use-engine-health";

/** The sentence Send is described by while the engine is down. */
export const ASSISTANT_ENGINE_REASON_ID = "assistant-engine-reason";

/**
 * Each state's sentence, spelled out rather than interpolated: INV-12's
 * catalog walk reads `t()` keys statically, and a computed key reaches no
 * catalog it can check.
 */
function EngineText({ state }: { state: EngineDown }) {
  const t = useTranslations("shell.assistant.engine");
  switch (state) {
    case "unreachable":
      return <>{t("unreachable")}</>;
    case "starting":
      return <>{t("starting")}</>;
    case "draining":
      return <>{t("draining")}</>;
    case "unconfigured":
      return <>{t("unconfigured")}</>;
  }
}

export function AssistantEngineNotice({
  health,
  onRecovered,
}: {
  health: EngineHealth;
  /** Called when Check again finds the engine ready, as the line goes away. */
  onRecovered: () => void;
}) {
  const t = useTranslations("shell.assistant.engine");
  if (health.down === null) return null;
  return (
    <div data-testid="assistant-engine-down" className="mb-2">
      <p
        id={ASSISTANT_ENGINE_REASON_ID}
        role="alert"
        data-testid={`assistant-engine-${health.down}`}
        className="flex items-start gap-2 text-sm text-error-ink"
      >
        <CircleAlert
          aria-hidden="true"
          className="mt-0.5 size-4 flex-none text-error"
        />
        <span>
          <EngineText state={health.down} />
        </span>
      </p>
      {health.error === null ? null : (
        <p
          data-testid="assistant-engine-code"
          className="mt-1 ml-6 font-mono text-[11px] text-muted-foreground"
        >
          {health.error}
        </p>
      )}
      {/*
        Held with `aria-disabled` rather than `disabled` while a read is out,
        so focus stays on it: a disabled button drops focus to the page.
      */}
      <button
        type="button"
        data-testid="assistant-engine-check"
        aria-disabled={health.checking || undefined}
        onClick={() => {
          if (health.checking) return;
          void health.check().then((ready) => {
            if (ready) onRecovered();
          });
        }}
        className={`mt-1.5 ml-6 text-[12px] ${linkText} aria-disabled:opacity-60`}
      >
        {health.checking ? t("checking") : t("check")}
      </button>
    </div>
  );
}
