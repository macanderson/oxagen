// Loaded with `node --require ./drain-preload.cjs dist/http.js` on the node,
// so the servers xmcp starts close their ports on SIGTERM (#5318).
"use strict";
require("./drain-on-signal.cjs").installDrain();
