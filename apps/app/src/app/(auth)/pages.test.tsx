// @vitest-environment jsdom
// Each sign-in page names itself once: generateMetadata returns its pages.* title
// and the page's one h1 reads the same string (ARCHITECTURE.md §1.2). The forms
// are islands with their own tests; here they render as stand-ins.
import { describe, it, vi } from "vitest";
import { translator } from "@/test/intl";
import {
  expectPageTitle,
  type PageModule,
  routeProps,
} from "@/test/render-page";

vi.mock("next-intl/server", () => ({
  getTranslations: (namespace: string) =>
    Promise.resolve(translator(namespace)),
}));
vi.mock("@/features/auth", async () => ({
  ...(await vi.importActual<typeof import("@/features/auth/routes")>(
    "@/features/auth/routes",
  )),
  ForgotPasswordForm: () => <form />,
  LoginForm: () => <form />,
  OAuthButtons: () => null,
  oauthQueryOutcome: () => null,
  ResetPasswordForm: () => <form />,
  SignupForm: () => <form />,
  TwoFactorForm: () => <form />,
  VerifyPanel: () => null,
}));

type Load = () => Promise<PageModule<object>>;

const PAGES: [string, Load, Record<string, string>][] = [
  ["login", () => import("./login/page"), {}],
  ["signup", () => import("./signup/page"), {}],
  ["verify", () => import("./verify/page"), { email: "marcus@a-intel.com" }],
  ["twoFactor", () => import("./two-factor/page"), {}],
  ["forgotPassword", () => import("./forgot-password/page"), {}],
  ["resetPassword", () => import("./reset-password/page"), { token: "t" }],
];

describe("sign-in pages", () => {
  it.each(PAGES)(
    "pages.%s is the document title and the one h1",
    async (key, load, query) => {
      await expectPageTitle(
        await load(),
        routeProps({}, query),
        translator("pages")(key),
      );
    },
  );
});
