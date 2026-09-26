// A section whose read did not return a value: a denial with the permission it
// needed, an access request still waiting, or the error code the read path
// answered. It replaces the section body, never the page.
import { useTranslations } from "next-intl";
import type { Read } from "@/data/read";

type Failure = Exclude<Read<unknown>, { ok: true }>;

export function ReadFailure({
  read,
  section,
}: {
  read: Failure;
  /** The section's translated title. */
  section: string;
}) {
  const t = useTranslations("ui.readFailure");
  let text: string;
  switch (read.reason) {
    case "denied":
      // A workspace decision rule refuses a person who holds the role, so
      // telling them their roles are missing sends them to ask for a grant
      // they already have. The rule is named instead.
      text =
        read.decidedBy?.source === "decision_rule"
          ? t("deniedByRule", { section, rule: read.decidedBy.id })
          : t("denied", { section, permission: read.permission });
      break;
    case "pending_approval":
      text = t("pendingApproval", {
        section,
        accessRequestId: read.accessRequestId,
      });
      break;
    case "error":
      text = t("error", { section, code: read.code });
      break;
  }
  return (
    <p
      data-reason={read.reason}
      className="max-w-prose text-sm text-muted-foreground"
    >
      {text}
    </p>
  );
}
