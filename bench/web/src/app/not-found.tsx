import Link from "next/link";

// Custom 404 so Next prerenders this instead of its builtin /_not-found
// page (which crashes under Turbopack alongside /_global-error).
export default function NotFound(): React.ReactElement {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-sm opacity-70">
        The page you are looking for does not exist.
      </p>
      <Link href="/" className="text-sm underline underline-offset-4">
        Back to the benchmark dashboard
      </Link>
    </main>
  );
}
