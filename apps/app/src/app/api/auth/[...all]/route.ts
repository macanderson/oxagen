// Better Auth: sessions, email and password, social sign-in, two-factor, reset.
// Node runtime (the auth server reaches Postgres); do not export `runtime`.
import { handleAuthRequest } from "@/features/auth";

export function GET(request: Request): Promise<Response> {
  return handleAuthRequest(request);
}

export function POST(request: Request): Promise<Response> {
  return handleAuthRequest(request);
}
