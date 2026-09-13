import type { Preview } from "@storybook/nextjs-vite";
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
        <div
          className={`${context.globals.theme === "dark" ? "dark " : ""}bg-background p-4 font-sans text-foreground`}
        >
          <Story />
        </div>
      </NextIntlClientProvider>
    ),
  ],
};

export default preview;
