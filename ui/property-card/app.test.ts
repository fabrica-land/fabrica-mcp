import { afterEach, describe, expect, it, vi } from "vitest";

// The card only needs element creation, child replacement and tab clicks here.
// Keep the rendered tree observable without adding a browser dependency.
class TestElement {
  className = "";
  textContent = "";
  children: TestElement[] = [];
  onclick: (() => void) | null = null;
  readonly attributes = new Map<string, string>();
  constructor(readonly tag: string) {}
  append(...nodes: TestElement[]): void {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: TestElement[]): void {
    this.children = nodes;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  descendants(): TestElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
}

describe("property card check list", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("@modelcontextprotocol/ext-apps");
    vi.resetModules();
  });

  it("renders informational legal-description results without pass or fail styling", async () => {
    const root = new TestElement("div");
    const app = {
      ontoolresult: (_result: { structuredContent: Record<string, unknown> }): void => {},
      getHostContext: () => ({ displayMode: "fullscreen" }),
      connect: async () => {},
    };
    vi.doMock("@modelcontextprotocol/ext-apps", () => ({
      App: class { constructor() { return app; } },
    }));
    vi.stubGlobal("document", {
      getElementById: (id: string) => id === "root" ? root : null,
      createElement: (tag: string) => new TestElement(tag),
      documentElement: { dataset: {}, style: { setProperty: () => {} } },
    });
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: false }),
      innerWidth: 1024,
      screen: { width: 1024, height: 768 },
      addEventListener: () => {},
    });
    await import("./app.js");
    app.ontoolresult({ structuredContent: {
      propertyChecks: { results: [
        { check: "Proof of Title Verified", passed: true },
        { check: "Holding Entity Matches Owner from County Assessor", passed: false },
        { check: "Legal description matches", result: "false or unknown", point: 1 },
      ] },
    } });
    const valueTab = root.descendants().find((node) => node.attributes.get("role") === "tab" && node.textContent === "Value");
    expect(valueTab).toBeDefined();
    valueTab?.onclick?.();
    const list = root.descendants().find((node) => node.tag === "ul" && node.className === "checklist");
    expect(list).toBeDefined();
    expect(list?.children.map((row) => ({
      tag: row.tag,
      className: row.className,
      status: row.children.find((node) => node.className === "mark")?.textContent,
      check: row.children.find((node) => node.className === "")?.textContent,
    }))).toEqual([
      { tag: "li", className: "pass", status: "Pass", check: "Proof of Title Verified" },
      { tag: "li", className: "fail", status: "Not passed", check: "Holding Entity Matches Owner from County Assessor" },
      { tag: "li", className: "", status: "Informational", check: "Legal description matches" },
    ]);
  });
});
