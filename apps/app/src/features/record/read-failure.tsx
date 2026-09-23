// A panel whose own read did not return a value: a denial with the permission
// it needed, an access request still waiting, or the error code the read path
// answered. It replaces the panel body, never the page, so a record still
// reads when the panel beside it could not be filled.
import { useTranslations } from "next-intl";
import type { Read } from "@/data/read";

type Failure = Exclude<Read<unknown>, { ok: true }>;

export function RecordReadFailure({
  read,
  section,
}: {
  read: Failure;
  /** The panel's translated title. */
  section: string;
}) {
  const t = useTranslations("record.failure");
  let text: string;
  switch (read.reason) {
    case "denied":
      text = t("sectionDenied", { section, permission: read.permission });
      break;
    case "pending_approval":
      text = t("sectionPending", {
        section,
        accessRequestId: read.accessRequestId,
      });
      break;
    case "error":
      text = t("sectionError", { section, code: read.code });
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
