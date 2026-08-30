/** `oxagen env …` — manage workspace environments via the org-scoped API. */
import { apiPost, printTable } from "../lib/api.js";
import { resolveEnvironmentId } from "../lib/resolve.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

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

export async function handleEnvList(
  opts: { json?: boolean },
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const { environments } = await apiPost<{ environments: EnvSummary[] }>(
    "environment/list",
    {},
    writer,
  );
  if (opts.json) {
    writer.write(JSON.stringify(environments, null, 2));
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
    writer,
  );
}

export async function handleEnvGet(
  idOrSlug: string,
  opts: { json?: boolean },
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const environmentId = await resolveEnvironmentId(idOrSlug);
  const { environment } = await apiPost<{ environment: EnvSummary }>(
    "environment/get",
    { environmentId },
    writer,
  );
  writer.write(JSON.stringify(environment, null, 2));
  void opts;
}

export async function handleEnvCreate(
  name: string,
  opts: { slug?: string; description?: string },
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const slug = opts.slug ?? slugify(name);
  const { environment } = await apiPost<{ environment: EnvSummary }>(
    "environment/create",
    {
      name,
      slug,
      description: opts.description ?? null,
    },
    writer,
  );
  writer.write(
    `✓ created environment ${environment.name} (${environment.slug}) ${environment.id}`,
  );
}

export async function handleEnvUpdate(
  idOrSlug: string,
  opts: {
    name?: string;
    slug?: string;
    description?: string;
    active?: boolean;
  },
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const environmentId = await resolveEnvironmentId(idOrSlug);
  const { environment } = await apiPost<{ environment: EnvSummary }>(
    "environment/update",
    {
      environmentId,
      name: opts.name,
      slug: opts.slug,
      description: opts.description,
      isActive: opts.active,
    },
    writer,
  );
  writer.write(
    `✓ updated environment ${environment.name} (${environment.slug})`,
  );
}

export async function handleEnvRemove(
  idOrSlug: string,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const environmentId = await resolveEnvironmentId(idOrSlug);
  await apiPost<{ ok: boolean }>(
    "environment/delete",
    { environmentId },
    writer,
  );
  writer.write(`✓ removed environment ${idOrSlug}`);
}

export async function handleEnvSetDefault(
  idOrSlug: string,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const environmentId = await resolveEnvironmentId(idOrSlug);
  const { environment } = await apiPost<{ environment: EnvSummary }>(
    "environment/set-default",
    { environmentId },
    writer,
  );
  writer.write(
    `✓ default environment: ${environment.name} (${environment.slug})`,
  );
}
