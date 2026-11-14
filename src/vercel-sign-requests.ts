import { handleSignRequestHttp } from "./sign-requests/http.js";

console.info(JSON.stringify({ event: "node_runtime", service: "fabrica-mcp-sign-requests", node: process.version }));

export default handleSignRequestHttp;
