import { handleSteeringLanding } from "@/features/onboarding";
import { resolveViewer } from "@/server/viewer";

export const GET = (request: Request): Promise<Response> =>
  handleSteeringLanding(request, { resolveViewer });
