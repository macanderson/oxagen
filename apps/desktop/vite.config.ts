import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri expects a fixed dev port and watches the source tree itself, so the
// Rust side must be left out of Vite's watcher.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: ["es2022", "safari15"],
    // Vite 8 minifies with Oxc. Its esbuild option is deprecated and needs
    // esbuild installed beside it, so the default stands.
    minify: "oxc",
    sourcemap: false,
  },
});
