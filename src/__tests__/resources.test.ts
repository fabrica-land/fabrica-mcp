import { createServer as createHttpServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handleMcpHttpRequest } from "../http.js";
import { getKnowledgeDocuments } from "../knowledge/documents.js";
import { CURATED_DOCS, NETWORK_URI } from "../resources/knowledge.js";

vi.mock("../clients/graphql.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../clients/graphql.js")>();
  return {
    ...original,
    getOperatingAgreement: vi.fn(async (tokenId: string) =>
      tokenId === "12743610130101631987"
        ? { tokenId, operatingAgreementName: "Fabrica US Trust v3.4", operatingAgreementUrl: "ipfs://QmTest", operatingAgreement: "# Fabrica Trust Agreement\n\nThis Trust Agreement..." }
        : null,
    ),
  };
});

/**
 * Resources ride the same stateless HTTP handler as tools: every request gets a fresh
 * server, so listing and reading must work with no session state.
 */
describe("knowledge resources", () => {
  let httpServer: Server;
  let url: string;

  beforeAll(async () => {
    httpServer = createHttpServer((req, res) => void handleMcpHttpRequest(req, res));
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (address === null || typeof address === "string") throw new Error("HTTP test server has no port");
    url = `http://127.0.0.1:${address.port}/mcp`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  async function connect(): Promise<Client> {
    const client = new Client({ name: "resources-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    return client;
  }

  it("lists the curated pages first, then every docs page, the trust agreement, the network and the help articles", async () => {
    const client = await connect();
    const { resources } = await client.listResources();
    const uris = resources.map((resource) => resource.uri);
    expect(uris.slice(0, CURATED_DOCS.length)).toEqual(CURATED_DOCS.map((slug) => `fabrica://docs/${slug}`));
    const documents = getKnowledgeDocuments();
    for (const document of documents) expect(uris).toContain(document.uri);
    expect(uris).toContain(NETWORK_URI);
    expect(uris).toContain("fabrica://legal/us-trust-agreement");
    for (const resource of resources) {
      expect(resource.title, resource.uri).toBeTruthy();
      expect(resource.mimeType, resource.uri).toBe("text/markdown");
      expect(resource.description ?? "", resource.uri).not.toMatch(/—/);
    }
    await client.close();
  });

  it("lists the three templates with descriptions", async () => {
    const client = await connect();
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((template) => template.uriTemplate).sort()).toEqual([
      "fabrica://docs/{slug}",
      "fabrica://help/{id}",
      "fabrica://property/{tokenId}/trust-agreement",
    ]);
    await client.close();
  });

  it("reads every curated resource with a source URL header and non-empty text", async () => {
    const client = await connect();
    for (const slug of CURATED_DOCS) {
      const { contents } = await client.readResource({ uri: `fabrica://docs/${slug}` });
      const [content] = contents;
      const text = content && "text" in content ? content.text : "";
      expect(text, slug).toContain(`Source: https://docs.fabrica.land/docs/${slug}`);
      expect(text.length, slug).toBeGreaterThan(400);
      expect(content?.mimeType).toBe("text/markdown");
    }
    await client.close();
  });

  it("reads the trust agreement, a help article and the network resource", async () => {
    const client = await connect();
    const trust = await client.readResource({ uri: "fabrica://legal/us-trust-agreement" });
    const trustText = trust.contents[0] && "text" in trust.contents[0] ? trust.contents[0].text : "";
    expect(trustText).toContain("Source: https://github.com/fabrica-land/fabrica-connectors/");
    expect(trustText.toLowerCase()).toContain("trustee");
    expect(trustText.length).toBeGreaterThan(50_000);

    const help = await client.readResource({ uri: "fabrica://help/3305355-what-does-fabrica-cost" });
    const helpText = help.contents[0] && "text" in help.contents[0] ? help.contents[0].text : "";
    expect(helpText).toContain("Source: https://help.fabrica.land/en/articles/3305355-what-does-fabrica-cost");

    const network = await client.readResource({ uri: NETWORK_URI });
    const networkText = network.contents[0] && "text" in network.contents[0] ? network.contents[0].text : "";
    expect(networkText).toContain("Network:");
    expect(networkText).toContain("0x");
    await client.close();
  });

  it("resolves the per-token trust agreement template and rejects unknown tokens", async () => {
    const client = await connect();
    const { contents } = await client.readResource({ uri: "fabrica://property/12743610130101631987/trust-agreement" });
    const text = contents[0] && "text" in contents[0] ? contents[0].text : "";
    expect(text).toContain("Fabrica US Trust v3.4 (token 12743610130101631987)");
    expect(text).toContain("Source: ipfs://QmTest");
    expect(text).toContain("This Trust Agreement");
    await expect(client.readResource({ uri: "fabrica://property/1/trust-agreement" })).rejects.toThrow(/No property found/);
    await expect(client.readResource({ uri: "fabrica://docs/not-a-page" })).rejects.toThrow(/No docs page/);
    await client.close();
  });

  it("gives every document a stable, URL-safe key", () => {
    for (const document of getKnowledgeDocuments()) {
      expect(document.key, document.url).toMatch(/^[a-z0-9-]+$/);
      expect(document.text.length, document.url).toBeGreaterThan(40);
    }
    expect(new Set(getKnowledgeDocuments().map((document) => document.uri)).size).toBe(getKnowledgeDocuments().length);
  });
});
