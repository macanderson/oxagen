// The Billing skeleton: four tile blocks and a panel of seven rows under the
// shell while the page's reads resolve (pages/billing.md, loading). No figure
// and no zero renders until a read answers. The <main> landmark is layout.tsx's.
import { BillingSkeleton } from "@/features/billing";

export default function BillingLoading() {
  return <BillingSkeleton />;
}
