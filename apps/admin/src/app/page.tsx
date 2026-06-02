export default function HomePage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <section className="w-full max-w-xl rounded-xl border bg-card text-card-foreground shadow p-10 text-center">
        <h1 className="text-4xl font-semibold tracking-tight">Oxagen Admin</h1>
        <p className="mt-4 text-base text-muted-foreground">
          Agents, workflows, and connected data — one platform, one contract.
        </p>
      </section>
    </main>
  );
}
