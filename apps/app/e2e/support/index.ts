// Shared e2e helpers. Specs import from "./support".
import { test as base, expect, type Page } from "@playwright/test";
import { signInAsFixtureUser } from "./session";

export { expectNoAxeViolations } from "./axe";
export { FIXTURE_USER, signInAsFixtureUser } from "./session";
export {
  MC_STATE_COOKIE,
  PAGE_STATES,
  type PageStateName,
  clearPageState,
  setPageState,
} from "./state";

type Fixtures = {
  /** A page whose context is signed in as the fixture operator. */
  signedInPage: Page;
};

export const test = base.extend<Fixtures>({
  signedInPage: async ({ context, page, baseURL }, use) => {
    await signInAsFixtureUser(context, baseURL ?? "http://localhost:3000");
    await use(page);
  },
});

export { expect };
