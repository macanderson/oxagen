# 2. Vendor Lock-In Avoidance

- Depend on interfaces, not vendors. Wrap every third-party SDK behind a thin internal adapter in a shared package so the vendor is swappable at one seam.
- No vendor-specific primitives leaking into domain or business logic. Storage, queue, auth, and model-provider calls go through our own abstractions.
- Database stays portable Postgres. Use standard SQL and Postgres-native features only. Never adopt a managed extension or proprietary API that cannot run on vanilla Postgres.
- Do not use Supabase for Postgres.
- Assume Vercel for app hosting, but keep build and runtime config portable. No hard dependency on a host-only feature that cannot be reproduced locally or on another runner.
- Infrastructure config is declarative and lives in the repo. No clicked-in console state that only exists in a vendor dashboard.
