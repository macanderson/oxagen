"use client";

// The Run lane's public client entry. A client component in another lane
// imports from here, never from the server barrel: `@/features/run` reaches
// server-only modules, and a client import of it puts them in the browser
// bundle (INV-21).
//
// Fleet's Steer the fleet receipt opens the delivery report for the command
// ids its broadcast returned (#2953), through the dialog and the read the Run
// page's own report uses.
export { DeliveryReport } from "./delivery-report";
