// The onboarding lane's public surface: organization creation for
// /new-organization, Connect a code host for /welcome/{org}/new-workspace/connect,
// the first workspace for /welcome/{org}/new-workspace, the gate's later steps
// and the installer's screens for /welcome/{org}/{ws}/{step}, the gate's rail
// and banners over Fleet, and the register flow for /{org}/{ws}/register/{step}.
// The routes import from here; nothing else reaches into the folder (eslint:
// `@/features/*/*` is restricted).
export { WelcomeConnect } from "./connect";
export { WelcomeFirstWorkspace } from "./first-workspace";
export { OnboardingGate } from "./gate";
export {
  NewOrganizationLoading,
  NewOrganizationScreen,
} from "./new-organization";
export { RegisterAgent, RegisterGate, RegisterSkeleton } from "./register";
export { parseRegisterStep } from "./steps";
export { parseSteeringResult } from "./ui/steering-result";
export {
  WelcomeInstaller,
  WelcomeLoading,
  WelcomeRun,
  WelcomeWrap,
} from "./welcome";
