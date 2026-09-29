// The Billing skeleton: four tile blocks and a panel of seven rows under the
// shell while the page's reads resolve (pages/billing.md, loading). No figure
// and no zero renders until a read answers.
//
// A busy region inside the shell's `main#main`, which is the only landmark
// (ADR-227). A `main` here would give the skip link a second target while the
// page streams in beside it (arch/loading-landmarks.test.ts).
import { BillingSkeleton } from "@/features/billing";

export default function BillingLoading() {
  return (
    <div aria-busy="true" className="flex w-full flex-col gap-4">
      <BillingSkeleton />
    </div>
  );
}
