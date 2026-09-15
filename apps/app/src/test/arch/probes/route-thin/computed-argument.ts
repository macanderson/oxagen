import { getAuthUser, handleGithubSetup } from "@/features/auth";

export const GET = (request: Request) =>
  handleGithubSetup(request, { getAuthUser, now: Date.now() });
