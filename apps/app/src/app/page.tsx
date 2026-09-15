import { Suspense } from "react";
import { dataSource } from "@/data/source";
import { Landing } from "@/features/shell";

// `/` redirects to the viewer's first workspace (ARCHITECTURE.md §1.2). The
// landing reads the session, so it renders inside <Suspense> (Cache Components).
export default function RootPage() {
  return (
    <Suspense fallback={null}>
      <Landing source={dataSource()} />
    </Suspense>
  );
}
