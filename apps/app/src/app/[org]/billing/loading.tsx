// The Billing skeleton: four tile blocks and a panel of seven rows under the
// shell while the page's reads resolve (pages/billing.md, loading). No figure
// and no zero renders until a read answers.
//
// The frame is a busy region, not `main#main`. While the page streams in, the
// document holds this fallback and the hidden page together, and only the
// page may own the landmark: two would give the skip link two targets and
// fail the page-load oracle's strict locator, as the onboarding gate did on
// 2026-09-24 (#4036).
import { BillingSkeleton } from "@/features/billing";

export default function BillingLoading() {
  return (
    <div
      aria-busy="true"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <BillingSkeleton />
    </div>
  );
}
