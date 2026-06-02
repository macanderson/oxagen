"use client";
// Top-level error boundary. Renders outside the root layout (its own <html>/<body>)
// and without next-themes, so it is immune to the ThemeProvider prerender crash.
import { GlobalErrorPage } from "@oxagen/ui/components/global-error";

export default GlobalErrorPage;
