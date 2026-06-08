#!/usr/bin/env node
import { Command } from "commander";
import { render } from "ink";
import React from "react";
import { DevStatus } from "./components/DevStatus";
import { authLoginCommand } from "./commands/auth.login";
import { authLogoutCommand } from "./commands/auth.logout";
import { authWhoamiCommand } from "./commands/auth.whoami";
import { orgListCommand } from "./commands/org.list";
import { workspaceListCommand } from "./commands/workspace.list";
import { chatSendCommand } from "./commands/chat.send";

const program = new Command();

program
  .name("oxagen")
  .description("Oxagen developer CLI")
  .version("0.2.0");

program
  .command("dev")
  .description("Show the current dev stack status")
  .action(() => {
    render(<DevStatus />);
  });

const auth = program
  .command("auth")
  .description("Authentication commands");

auth.addCommand(authLoginCommand);
auth.addCommand(authLogoutCommand);
auth.addCommand(authWhoamiCommand);

const org = program
  .command("org")
  .description("Organization commands");

org.addCommand(orgListCommand);

const workspace = program
  .command("workspace")
  .description("Workspace commands");

workspace.addCommand(workspaceListCommand);

const chat = program
  .command("chat")
  .description("Chat and messaging commands");

chat.addCommand(chatSendCommand);

program.parse(process.argv);

if (program.args.length === 0) {
  program.outputHelp();
}
