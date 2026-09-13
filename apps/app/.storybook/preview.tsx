import type { Preview } from "@storybook/nextjs-vite";
import { type ReactNode, useEffect } from "react";
import { NextIntlClientProvider } from "next-intl";
import { mergeCatalogs } from "../src/i18n/catalogs";
import en from "../messages/en.json";
import ui from "../messages/ui.json";
import "../src/app/globals.css";

// The same catalogs the app merges (src/i18n/request.ts), so stories show real copy.
const messages = mergeCatalogs([
  ["en", en],
  ["ui", ui],
]);

// The house tokens flip on the root element: component tokens (tabs, buttons,
// inputs) are declared on :root as var() references and inherit as computed
// values, so a `.dark` class on a wrapper would flip only the core tokens.
function ThemeRoot({
  theme,
  children,
}: {
  theme: string;
  children: ReactNode;
}) {
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.classList.toggle("light", theme !== "dark");
  }, [theme]);
  return <>{children}</>;
}

const preview: Preview = {
  parameters: {
    layout: "padded",
    controls: { expanded: true },
    nextjs: { appDirectory: true },
    // Every story is an accessibility test: an axe violation fails it.
    a11y: { test: "error" },
  },
  globalTypes: {
    theme: {
      description: "House theme",
      toolbar: {
        title: "Theme",
        icon: "mirror",
        items: [
          { value: "light", title: "Light" },
          { value: "dark", title: "Dark" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: "light" },
  decorators: [
    (Story, context) => (
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <ThemeRoot theme={String(context.globals.theme)}>
          <div className="bg-background p-4 font-sans text-foreground">
            <Story />
          </div>
        </ThemeRoot>
      </NextIntlClientProvider>
    ),
  ],
};

export default preview;
