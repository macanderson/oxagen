-- Per-ecosystem package lists for a sandbox template: an array of
-- { manager: 'pip'|'npm'|'apt'|'cargo'|'gem'|'go'|'pnpm'|'yarn'|'poetry'|'uv',
--   names: string[] } groups installed into the image at provision time. The
-- manager set is validated in zod (sandboxTemplatePackagesSchema), not as a DB
-- enum, so new ecosystems never require a migration. Defaults to an empty list
-- so every existing template stays valid with no packages.
ALTER TABLE "environments"."sandbox_templates" ADD COLUMN "packages" jsonb NOT NULL DEFAULT '[]'::jsonb;
