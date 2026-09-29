import { handleSlackCallback } from "@/features/organization";
export const GET = (request: Request): Promise<Response> =>
  handleSlackCallback(request);
