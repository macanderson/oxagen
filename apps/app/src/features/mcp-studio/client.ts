"use client";

// Studio's public client entry. A client component in another lane imports
// from here, never from the server barrel: `@/features/mcp-studio` reaches
// server-only modules, and a client import of it puts them in the browser
// bundle (INV-21).
//
// The Tools page's Add a provider dialog renders Add server's Studio sources
// (#4678, items 1 to 3): From a definition, Local command, a registry entry's
// offer and package form, and discovery progress. The five components live in
// add-server.tsx, and nothing they reach imports `@/features/tools`, so the
// two lanes never import each other in a cycle.
export {
  DefinitionFields,
  DiscoveryProgress,
  LocalCommandFields,
  RegistryOfferChip,
  RegistryPackageFields,
} from "./add-server";
