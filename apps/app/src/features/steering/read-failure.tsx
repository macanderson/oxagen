// A Steering section whose read did not return a value: a denial with the
// permission it needed, an access request still waiting, or the error code the
// read path answered. It replaces the section body, never the page.
import { useTranslations } from "next-intl";
import type { Read } from "@/data/read";

type Failure = Exclude<Read<unknown>, { ok: true }>;

export function SteeringReadFailure({
  read,
  section,
}: {
  read: Failure;
  /** The section's translated title. */
  section: string;
}) {
  const t = useTranslations("steering.failure");
  let text: string;
  switch (read.reason) {
    case "denied":
      text = t("denied", { section, permission: read.permission });
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
