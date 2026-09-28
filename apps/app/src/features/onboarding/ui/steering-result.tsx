// The line a GitHub install leaves behind. The steering connection's start
// route sends the person back to its `return_to` with `?steering=connected`,
// or with `?steering=error&code=<reason>` when GitHub or the route refused.
// Connect a code host and Create the first workspace are both return targets,
// so both read the query and show the same line.
//
// The code is a query value anyone can type, so only a short snake_case reason
// is shown. Anything else reads as an error with no code.
import { useTranslations } from "next-intl";
import { FormAlert } from "@/ui/form-feedback";

export type SteeringResult =
  | { kind: "connected" }
  | { kind: "error"; code: string | null };

const REASON = /^[a-z0-9_]{1,64}$/;

/** The install's outcome from `?steering=` and `?code=`, or null when the query names none. */
export function parseSteeringResult(
  steering: string | null | undefined,
  code: string | null | undefined,
): SteeringResult | null {
  if (steering === "connected") return { kind: "connected" };
  if (steering !== "error") return null;
  return {
    kind: "error",
    code: typeof code === "string" && REASON.test(code) ? code : null,
  };
}

export function SteeringResultLine({
  result,
}: {
  result: SteeringResult | null;
}) {
  const t = useTranslations("onboarding.welcome.steeringResult");
  if (result === null) return null;
  if (result.kind === "connected")
    return (
      <p
        role="status"
        data-testid="steering-connected"
        className="text-sm text-foreground"
      >
        {t("connected")}
      </p>
    );
  return (
    <FormAlert testId="steering-error">
      {result.code === null
        ? t("errorNoCode")
        : t("error", { code: result.code })}
    </FormAlert>
  );
}
