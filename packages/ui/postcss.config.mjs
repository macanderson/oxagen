// Tailwind v4 is processed through the PostCSS plugin. Vite (Storybook's builder)
// auto-discovers this config, so the token-driven `globals.css` compiles the
// same way it does in the apps.
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
