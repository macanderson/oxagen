import { notBacked } from "@/data/not-backed";
import { PageState } from "@/ui/page-state";
import { PlaceholderPage } from "@/ui/placeholder-page";

// Batch 0 skeleton; its Batch 2 page lane replaces it.
export default function RegisterPage() {
  return (
    <PlaceholderPage route="register">
      <PageState page="register" result={notBacked("M1", "G15")} />
    </PlaceholderPage>
  );
}
