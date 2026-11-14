import { handleWellKnownHttp } from "./well-known.js";

console.info(JSON.stringify({ event: "node_runtime", service: "fabrica-mcp-well-known", node: process.version }));

export default handleWellKnownHttp;
