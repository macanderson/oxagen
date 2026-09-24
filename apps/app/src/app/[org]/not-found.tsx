"use client";
// A page under the organization that does not exist, or a workspace the
// person is not a member of. The shell stays, and the one action leads to the
// Organization page. A not-found file receives no props, so the slug comes
// from the URL.
import { useParams } from "next/navigation";
import { NotFoundState } from "@/ui/page-state";

export default function OrganizationNotFound() {
  const { org } = useParams<{ org: string }>();
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <NotFoundState scope="organization" org={org} />
    </main>
  );
}
