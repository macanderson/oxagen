#!/usr/bin/env node
import { Command } from "commander";
import { render } from "ink";
import React from "react";
import { DevStatus } from "./components/DevStatus";

const program = new Command();

program
  .name("oxagen")
  .description("Oxagen developer CLI")
  .version("0.1.0");

program
  .command("dev")
  .description("Show the current dev stack status")
  .action(() => {
    render(<DevStatus />);
  });

program.parse(process.argv);

if (program.args.length === 0) {
  program.outputHelp();
}
