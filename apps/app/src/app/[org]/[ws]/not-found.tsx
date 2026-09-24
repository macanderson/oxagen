"use client";
// A record under the workspace that does not exist, such as a run or a
// runtime the workspace does not hold. The shell stays, and the one action
// leads back to Fleet. A not-found file receives no props, so the slugs come
// from the URL.
import { useParams } from "next/navigation";
import { NotFoundState } from "@/ui/page-state";

export default function WorkspaceNotFound() {
  const { org, ws } = useParams<{ org: string; ws: string }>();
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <NotFoundState scope="workspace" org={org} ws={ws} />
    </main>
  );
}
