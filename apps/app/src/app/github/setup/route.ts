import { getAuthUser, handleGithubSetup } from "@/features/auth";

export const GET = (request: Request): Promise<Response> =>
  handleGithubSetup(request, { getAuthUser });
