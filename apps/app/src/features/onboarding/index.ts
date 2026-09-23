// The onboarding lane's public surface: organization creation for
// /new-organization, the gate's later steps and the installer's screens for
// /welcome/{org}/{ws}/{step}, the gate's rail and banners over Fleet, and the
// register flow for /{org}/{ws}/register/{step}. The routes import from here; nothing
// else reaches into the folder (eslint: `@/features/*/*` is restricted).
export { OnboardingGate } from "./gate";
export {
  NewOrganizationLoading,
  NewOrganizationScreen,
} from "./new-organization";
export { RegisterAgent, RegisterGate, RegisterSkeleton } from "./register";
export { parseRegisterStep } from "./steps";
export {
  WelcomeInstaller,
  WelcomeLoading,
  WelcomeRun,
  WelcomeWrap,
} from "./welcome";
