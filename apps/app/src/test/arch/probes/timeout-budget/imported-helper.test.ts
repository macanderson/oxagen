// The walker lives in another module and is handed over by name.
import { it } from "vitest";
import { scan } from "./imported-walker";

it("scan", scan);
