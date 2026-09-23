import { handleLinearCallback } from "@/features/run-outcomes";
export const GET = (request: Request): Promise<Response> =>
  handleLinearCallback(request);
