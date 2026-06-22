import * as React from "react";
import "../src/styles/globals.css";
import type { Decorator, Preview } from "@storybook/react-vite";

/**
 * Theme toolbar — coss ui is fully token-driven: the `.dark` class on an
 * ancestor flips every surface, control, and state. The decorator below applies
 * that class to the story container so each component can be inspected in both
 * light and dark without a full ThemeProvider (which needs cookies/SSR wiring).
 */
const withTheme: Decorator = (Story, context) => {
  const theme = (context.globals.theme as string | undefined) ?? "light";
  return (
    <div
      className={[
        theme === "dark" ? "dark" : "",
        "min-h-screen bg-background p-6 text-foreground",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <Story />
    </div>
  );
};

const preview: Preview = {
  decorators: [withTheme],
  globalTypes: {
    theme: {
      description: "Light / dark token theme",
      defaultValue: "light",
      toolbar: {
        title: "Theme",
        icon: "circlehollow",
        items: [
          { value: "light", title: "Light", icon: "sun" },
          { value: "dark", title: "Dark", icon: "moon" },
        ],
        dynamicTitle: true,
      },
    },
  },
  parameters: {
    layout: "fullscreen",
    controls: { expanded: true },
  },
};

export default preview;
