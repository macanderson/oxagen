// The Billing skeleton: four tile blocks and a panel of seven rows under the
// shell while the page's reads resolve (pages/billing.md, loading). No figure
// and no zero renders until a read answers.
//
// A busy region, not the page's `main`: while the page streams in, this
// fallback and the page are in the document together, and only the page may
// own main#main. Two gave the skip link two targets and failed page-load's
// strict locator on 2026-09-24 (arch/loading-landmarks.test.ts).
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
