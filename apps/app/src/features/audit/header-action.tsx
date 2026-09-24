// The header's one gold action, Export evidence bundle (rev1 audit.md,
// Header), which opens `newexport`. It steps aside whenever the body shows a
// state in place of the record (empty, loading, error, denied: states.tsx and
// the skeleton mark themselves `data-audit-state`), so a state is shown alone,
// as the design draws it, and its own action is the one gold one on screen.
// The route's <main> is the `audit` group this keys on.
import { BundleDialog } from "./dialogs";
import { AUDIT_GAPS } from "./gaps";

export function AuditHeaderAction({ org }: { org: string }) {
  return (
    <span
      data-testid="audit-header-action"
      className="contents group-has-[[data-audit-state]]/audit:hidden"
    >
      <BundleDialog org={org} gap={AUDIT_GAPS.exports} />
    </span>
  );
}
