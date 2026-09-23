// The header's one gold action, Export evidence bundle (rev1 audit.md,
// Header), which opens `newexport`. It steps aside while the body shows a
// failed or refused read (states.tsx marks it `data-audit-failed`), so the
// state's own Try again or Request access is the one gold action on screen.
// The route's <main> is the `audit` group this keys on.
import { BundleDialog } from "./dialogs";
import { AUDIT_GAPS } from "./gaps";

export function AuditHeaderAction() {
  return (
    <span
      data-testid="audit-header-action"
      className="contents group-has-[[data-audit-failed]]/audit:hidden"
    >
      <BundleDialog gap={AUDIT_GAPS.exports} />
    </span>
  );
}
