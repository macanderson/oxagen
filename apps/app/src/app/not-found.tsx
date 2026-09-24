import { NotFoundState } from "@/ui/page-state";

// An address that matches no page, outside any organization. The shared
// not-found state replaces the page and leads back to Oxagen's root, which
// opens the person's first workspace.
export default function NotFound() {
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <NotFoundState scope="app" />
    </main>
  );
}
