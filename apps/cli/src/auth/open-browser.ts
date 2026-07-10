/**
 * Cross-platform browser launcher for the loopback OAuth flow.
 *
 * Uses only Node built-ins (node:child_process). Errors are swallowed because
 * the caller always prints the URL so the user can paste it manually if the
 * browser fails to open.
 */
import { spawn } from "node:child_process";

/**
 * Open `url` in the system default browser. Never throws — on any error the
 * call is a no-op, relying on the caller to print the URL as a fallback.
 */
export function openBrowser(url: string): void {
  try {
    let cmd: string;
    let args: string[];
    switch (process.platform) {
      case "darwin":
        cmd = "open";
        args = [url];
        break;
      case "win32":
        cmd = "cmd";
        args = ["/c", "start", "", url];
        break;
      default:
        cmd = "xdg-open";
        args = [url];
    }
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // Swallow: the caller always prints the URL for manual fallback.
  }
}
