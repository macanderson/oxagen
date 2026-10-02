/**
 * The one command the docs give for installing the oxagen CLI. The docs site
 * serves `public/install.sh` at this URL, so the command names the docs host
 * (#4960). The script downloads the executable for your platform from
 * https://downloads.oxagen.sh/latest. Every page, component, and guide that
 * shows the command imports it from here, and
 * tools/scripts/install-command.tree.test.ts fails on one that names another
 * host.
 */
export const INSTALL_SCRIPT_URL = "https://docs.oxagen.sh/install.sh";

export const INSTALL_CMD = `curl -fsSL ${INSTALL_SCRIPT_URL} | sh`;
