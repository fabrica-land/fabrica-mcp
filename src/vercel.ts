import { handleMcpHttpRequest } from "./http.js";

console.info(JSON.stringify({ event: "node_runtime", service: "fabrica-mcp", node: process.version }));

export default handleMcpHttpRequest;
