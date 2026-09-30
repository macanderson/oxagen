// @vitest-environment jsdom
// The Connection tab's credential form (#4678, item 13).
//
//   - While set_mcp_credential is a stub, the form renders disabled with the
//     note naming the capability and #4742.
//   - With the capability, the form sends the name and the secret it reads
//     at submit, empties the secret fields once the vault stores them, and
//     shows only the vault reference.
//   - A refusal or a thrown call names the code or the failure, never the
//     secret.
//
// Secret-shaped values are joined at run time, so no literal reaches the
// repository. axe checks the state each test ends in (INV-26).
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider, translator } from "@/test/intl";
import { CredentialForm } from "./credential-form";
import type {
  SetMcpCredential,
  SetMcpCredentialInput,
} from "./pending-capabilities";

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

const auth = translator("mcpStudio.connection.auth");

const SECRET = ["sk", "live", "4f1c2b9a0d4e"].join("_");
const CLIENT_ID = ["client", "7d9e"].join("_");
const CLIENT_SECRET = ["cs", "live", "9a8b7c6d"].join("_");
const REFERENCE = "oxagen:credential/stripe-restricted";

type CredentialAnswer = Awaited<ReturnType<SetMcpCredential["call"]>>;

/** set_mcp_credential as it will be once #4742 merges it. */
function fakeCredential(answer: () => Promise<CredentialAnswer>) {
  const calls: SetMcpCredentialInput[] = [];
  const credential: SetMcpCredential = {
    name: "set_mcp_credential",
    available: true,
    gap: "credentials",
    call: (input) => {
      calls.push(input);
      return answer();
    },
  };
  return { credential, calls };
}

const STORED: CredentialAnswer = {
  ok: true,
  name: "stripe-restricted",
  reference: REFERENCE,
  created: false,
};

function inputOf(label: string): HTMLInputElement {
  const node = screen.getByLabelText(label);
  if (!(node instanceof HTMLInputElement)) throw new Error(`no ${label} input`);
  return node;
}

function renderForm(
  credential?: SetMcpCredential,
  defaultKind: SetMcpCredentialInput["kind"] = "secret",
) {
  const user = userEvent.setup();
  render(
    <IntlProvider>
      <CredentialForm
        defaultName="stripe-restricted"
        defaultKind={defaultKind}
        {...(credential === undefined ? {} : { credential })}
      />
    </IntlProvider>,
  );
  return user;
}

/** Nothing the page shows or keeps in its markup holds a secret. */
function expectNoSecret() {
  const markup = document.body.innerHTML;
  for (const value of [SECRET, CLIENT_ID, CLIENT_SECRET]) {
    expect(markup).not.toContain(value);
  }
}

describe("CredentialForm", () => {
  it("renders disabled with the note while set_mcp_credential is a stub", () => {
    renderForm();
    const replace = screen.getByTestId("studio-credential-replace");
    expect(replace).toBeDisabled();
    expect(replace).toHaveTextContent(auth("replace"));
    expect(replace).toHaveAccessibleDescription(auth("pending"));
    const note = screen.getByTestId("studio-credential-pending");
    expect(note).toHaveAttribute("data-state", "not-available");
    expect(note).toHaveAttribute("data-capability", "set_mcp_credential");
    expect(note).toHaveAttribute("data-gap", "#4742");
    expect(inputOf(auth("name"))).toHaveValue("stripe-restricted");
    expect(inputOf(auth("name"))).toBeDisabled();
    expect(inputOf(auth("secret"))).toBeDisabled();
  });

  it("stores a service secret and shows only its reference", async () => {
    const { credential, calls } = fakeCredential(() =>
      Promise.resolve(STORED),
    );
    const user = renderForm(credential);
    expect(
      screen.queryByTestId("studio-credential-pending"),
    ).not.toBeInTheDocument();
    await user.type(inputOf(auth("secret")), SECRET);
    await user.click(screen.getByTestId("studio-credential-replace"));
    expect(
      await screen.findByTestId("studio-credential-saved"),
    ).toHaveTextContent(auth("saved", { reference: REFERENCE }));
    expect(calls).toStrictEqual([
      { name: "stripe-restricted", kind: "secret", secret: SECRET },
    ]);
    expect(inputOf(auth("secret"))).toHaveValue("");
    expectNoSecret();
  });

  it("stores an OAuth client's id and secret", async () => {
    const { credential, calls } = fakeCredential(() =>
      Promise.resolve(STORED),
    );
    const user = renderForm(credential);
    await user.click(screen.getByTestId("studio-credential-kind-oauth_client"));
    expect(screen.queryByLabelText(auth("secret"))).not.toBeInTheDocument();
    await user.clear(inputOf(auth("name")));
    await user.type(inputOf(auth("name")), "billing-oauth");
    await user.type(inputOf(auth("clientId")), CLIENT_ID);
    await user.type(inputOf(auth("clientSecret")), CLIENT_SECRET);
    await user.click(screen.getByTestId("studio-credential-replace"));
    await screen.findByTestId("studio-credential-saved");
    expect(calls).toStrictEqual([
      {
        name: "billing-oauth",
        kind: "oauth_client",
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
      },
    ]);
    expect(inputOf(auth("clientId"))).toHaveValue("");
    expect(inputOf(auth("clientSecret"))).toHaveValue("");
    expectNoSecret();
  });

  it("opens on the kind the record names", () => {
    renderForm(undefined, "oauth_client");
    expect(
      screen.getByTestId("studio-credential-kind-oauth_client"),
    ).toBeChecked();
    expect(inputOf(auth("clientId"))).toBeDisabled();
    expect(inputOf(auth("clientSecret"))).toBeDisabled();
  });

  it.each<[string, CredentialAnswer, string]>([
    ["a refusal", { ok: false, reason: "failed", code: "denied" }, "denied"],
    [
      "an answer that the capability is not built",
      { ok: false, reason: "not_built", gap: "credentials" },
      "not_built",
    ],
  ])("names the code of %s and never the secret", async (_, answer, code) => {
    const { credential } = fakeCredential(() => Promise.resolve(answer));
    const user = renderForm(credential);
    await user.type(inputOf(auth("secret")), SECRET);
    await user.click(screen.getByTestId("studio-credential-replace"));
    expect(
      await screen.findByTestId("studio-credential-failed"),
    ).toHaveTextContent(auth("failed", { code }));
    expect(
      screen.queryByTestId("studio-credential-saved"),
    ).not.toBeInTheDocument();
    expectNoSecret();
  });

  it("says the request failed when the call throws, and never shows the error", async () => {
    const { credential } = fakeCredential(() =>
      Promise.reject(new Error(`vault refused ${SECRET}`)),
    );
    const user = renderForm(credential);
    await user.type(inputOf(auth("secret")), SECRET);
    await user.click(screen.getByTestId("studio-credential-replace"));
    expect(
      await screen.findByTestId("studio-credential-failed"),
    ).toHaveTextContent(auth("thrown"));
    expectNoSecret();
  });

  it("sends once while a store is in flight", async () => {
    let settle: (answer: CredentialAnswer) => void = () => undefined;
    const { credential, calls } = fakeCredential(
      () =>
        new Promise<CredentialAnswer>((resolve) => {
          settle = resolve;
        }),
    );
    const user = renderForm(credential);
    await user.type(inputOf(auth("secret")), SECRET);
    const replace = screen.getByTestId("studio-credential-replace");
    await user.click(replace);
    expect(replace).toHaveTextContent(auth("saving"));
    expect(replace).toHaveAttribute("aria-disabled", "true");
    await user.click(replace);
    expect(calls).toHaveLength(1);
    settle(STORED);
    expect(
      await screen.findByTestId("studio-credential-saved"),
    ).toHaveTextContent(auth("saved", { reference: REFERENCE }));
    expect(replace).toHaveTextContent(auth("replace"));
  });
});
