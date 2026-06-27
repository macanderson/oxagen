/** `oxagen env …` — manage workspace environments via the org-scoped API. */
import { apiPost, printTable } from "../lib/api.js";
import { resolveEnvironmentId } from "../lib/resolve.js";

interface EnvSummary {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  isDefault: boolean;
  isActive: boolean;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function handleEnvList(opts: { json?: boolean }): Promise<void> {
  const { environments } = await apiPost<{ environments: EnvSummary[] }>("environment/list", {});
  if (opts.json) {
    process.stdout.write(JSON.stringify(environments, null, 2) + "\n");
    return;
  }
  printTable(
    ["NAME", "SLUG", "DEFAULT", "ACTIVE", "ID"],
    environments.map((e) => [
      e.name,
      e.slug,
      e.isDefault ? "★" : "",
      e.isActive ? "yes" : "no",
      e.id,
    ]),
  );
}

export async function handleEnvGet(idOrSlug: string, opts: { json?: boolean }): Promise<void> {
  const environmentId = await resolveEnvironmentId(idOrSlug);
  const { environment } = await apiPost<{ environment: EnvSummary }>("environment/get", {
    environmentId,
  });
  process.stdout.write(JSON.stringify(environment, null, 2) + "\n");
  void opts;
}

export async function handleEnvCreate(
  name: string,
  opts: { slug?: string; description?: string },
): Promise<void> {
  const slug = opts.slug ?? slugify(name);
  const { environment } = await apiPost<{ environment: EnvSummary }>("environment/create", {
    name,
    slug,
    description: opts.description ?? null,
  });
  process.stdout.write(`✓ created environment ${environment.name} (${environment.slug}) ${environment.id}\n`);
}

export async function handleEnvUpdate(
  idOrSlug: string,
  opts: { name?: string; slug?: string; description?: string; active?: boolean },
): Promise<void> {
  const environmentId = await resolveEnvironmentId(idOrSlug);
  const { environment } = await apiPost<{ environment: EnvSummary }>("environment/update", {
    environmentId,
    name: opts.name,
    slug: opts.slug,
    description: opts.description,
    isActive: opts.active,
  });
  process.stdout.write(`✓ updated environment ${environment.name} (${environment.slug})\n`);
}

export async function handleEnvRemove(idOrSlug: string): Promise<void> {
  const environmentId = await resolveEnvironmentId(idOrSlug);
  await apiPost<{ ok: boolean }>("environment/delete", { environmentId });
  process.stdout.write(`✓ removed environment ${idOrSlug}\n`);
}

export async function handleEnvSetDefault(idOrSlug: string): Promise<void> {
  const environmentId = await resolveEnvironmentId(idOrSlug);
  const { environment } = await apiPost<{ environment: EnvSummary }>("environment/set-default", {
    environmentId,
  });
  process.stdout.write(`✓ default environment: ${environment.name} (${environment.slug})\n`);
}
