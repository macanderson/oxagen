import { notBacked } from "@/data/not-backed";
import { PageState } from "@/ui/page-state";
import { PlaceholderPage } from "@/ui/placeholder-page";

// Batch 0 skeleton; its Batch 2 page lane replaces it.
export default function HomePage() {
  return (
    <PlaceholderPage route="home">
      <PageState page="home" result={notBacked("M1", "G15")} />
    </PlaceholderPage>
  );
}
