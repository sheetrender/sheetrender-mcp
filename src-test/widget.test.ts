import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

import { createScanner, SyntaxKind } from "typescript/unstable/ast";

import * as extApps from "@modelcontextprotocol/ext-apps/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { CatalogueCache, createAnonServer, SlidingWindowLimiter } from "../src/anon.js";
import { BANNED_WORDS } from "../src/anon-descriptions.js";
import type { SheetRenderClient } from "../src/client.js";
import {
    claudeWidgetDomain,
    loadWidgetBundle,
    RESOURCE_MIME_TYPE,
    RESOURCE_URI_META_KEY,
    WIDGET_BUNDLE_URL,
    WIDGET_URI,
    widgetHtml,
    widgetResourceMeta,
} from "../src/widget-resource.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
    while (closers.length) await closers.pop()!();
});

async function connect(apiUrl: string, publicUrl?: string): Promise<Client> {
    const server = createAnonServer({
        client: { baseUrl: apiUrl } as unknown as SheetRenderClient,
        limiter: new SlidingWindowLimiter(30, 3_600_000),
        catalogue: new CatalogueCache(),
        clientIp: "203.0.113.9",
        publicUrl,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closers.push(async () => {
        await client.close();
        await server.close();
    });
    return client;
}

/** Lex actual TS strings, including single quotes, escapes and template tails. */
function stringLiterals(source: string): string[] {
    const scanner = createScanner(true, undefined, source);
    const literals: string[] = [];
    const templates: number[] = [];
    let braces = 0;
    for (let token = scanner.scan(); token !== SyntaxKind.EndOfFile; token = scanner.scan()) {
        if (token === SyntaxKind.CloseBraceToken && templates.length && templates.at(-1) === braces) {
            token = scanner.reScanTemplateToken(false);
        } else if (token === SyntaxKind.OpenBraceToken) {
            braces++;
        } else if (token === SyntaxKind.CloseBraceToken) {
            braces--;
        }
        if (token === SyntaxKind.TemplateHead) templates.push(braces);
        if (token === SyntaxKind.TemplateTail) templates.pop();
        if ([SyntaxKind.StringLiteral, SyntaxKind.NoSubstitutionTemplateLiteral, SyntaxKind.TemplateHead,
            SyntaxKind.TemplateMiddle, SyntaxKind.TemplateTail].includes(token)) {
            literals.push(scanner.getTokenValue());
        }
    }
    return literals;
}

class Element {
    children: Element[] = [];
    textContent = "";
    className = "";
    dataset = { origin: "https://sheetrender.com" };
    listeners = new Map<string, () => void | Promise<void>>();
    src?: string;
    constructor(readonly tag: string) {}
    append(...nodes: Element[]): void { this.children.push(...nodes); }
    replaceChildren(): void { this.children = []; }
    setAttribute(): void {}
    addEventListener(name: string, callback: () => void | Promise<void>): void { this.listeners.set(name, callback); }
    all(): Element[] { return [this, ...this.children.flatMap((node) => node.all())]; }
}

/** Execute the actual view with a small host/DOM double, without a browser. */
async function view() {
    const root = new Element("main");
    const opened: string[] = [];
    const browserOpened: string[] = [];
    const calls: unknown[] = [];
    let replyUrl = "https://sheetrender.com/templates/mail-merge-letter#handoff=abc";
    const app = {
        deny: false,
        ontoolinput: (_params: { arguments: Record<string, unknown> }) => {},
        ontoolresult: (_params: { structuredContent: unknown }) => {},
        connect: async () => {},
        getHostContext: () => undefined,
        openLink: async ({ url }: { url: string }) => { opened.push(url); return { isError: app.deny }; },
        callServerTool: async (args: unknown) => { calls.push(args); return { structuredContent: { continue_url: replyUrl } }; },
    };
    const source = readFileSync(new URL("../../src/widget/documents.ts", import.meta.url), "utf8");
    const script = stripTypeScriptTypes(source).replace(/^import\s*\{[\s\S]*?\}\s*from\s*"@modelcontextprotocol\/ext-apps";/m, "");
    runInNewContext(script, {
        App: function () { return app; }, URL,
        document: { getElementById: () => root, createElement: (tag: string) => new Element(tag) },
        window: { open: (url: string) => browserOpened.push(url) },
        applyDocumentTheme: () => {}, applyHostFonts: () => {}, applyHostStyleVariables: () => {},
    });
    await Promise.resolve();
    return { root, app, opened, browserOpened, calls, reply: (url: string) => { replyUrl = url; } };
}

describe("widget resource", () => {
    it("uses the same constants as @modelcontextprotocol/ext-apps", () => {
        assert.equal(RESOURCE_MIME_TYPE, extApps.RESOURCE_MIME_TYPE);
        assert.equal(RESOURCE_URI_META_KEY, extApps.RESOURCE_URI_META_KEY);
        assert.equal(RESOURCE_MIME_TYPE, "text/html;profile=mcp-app");
    });

    it("is listed and read with the MCP Apps mime type, border and a CSP on the API origin", async () => {
        const client = await connect("https://staging.sheetrender.com", "https://mcp.staging.sheetrender.com/mcp");
        const { resources } = await client.listResources();
        assert.equal(resources.length, 1);
        assert.equal(resources[0]!.uri, WIDGET_URI);
        assert.equal(resources[0]!.mimeType, RESOURCE_MIME_TYPE);

        const read = await client.readResource({ uri: WIDGET_URI });
        const content = read.contents[0] as { uri: string; mimeType: string; text: string; _meta: Record<string, unknown> };
        assert.equal(content.uri, WIDGET_URI);
        assert.equal(content.mimeType, RESOURCE_MIME_TYPE);
        const ui = content._meta.ui as { csp: { resourceDomains: string[]; connectDomains?: string[] }; prefersBorder: boolean; domain?: string };
        assert.deepEqual(ui.csp, { resourceDomains: ["https://staging.sheetrender.com"] });
        assert.equal(ui.prefersBorder, true);
        // An unidentified host gets no ui.domain: a wrong format breaks the view.
        assert.equal(ui.domain, undefined);
        assert.equal(content._meta["openai/widgetDomain"], "https://mcp.staging.sheetrender.com");
        assert.deepEqual(content._meta["openai/widgetCSP"], {
            connect_domains: [],
            resource_domains: ["https://staging.sheetrender.com"],
            redirect_domains: ["https://staging.sheetrender.com"],
        });
        assert.match(content.text, /^<!doctype html>/);
        assert.match(content.text, /data-origin="https:\/\/staging\.sheetrender\.com"/);
    });

    it("derives the CSP origin from the API URL, path and all", () => {
        const meta = widgetResourceMeta({ apiOrigin: new URL("https://sheetrender.com/").origin, host: "other" });
        assert.deepEqual((meta.ui as { csp: unknown }).csp, { resourceDomains: ["https://sheetrender.com"] });
        assert.equal(meta["openai/widgetDomain"], undefined);
    });

    it("writes each host's own ui.domain format", () => {
        const publicUrl = "https://example.com/mcp";
        // The worked example from Claude's MCP Apps documentation.
        assert.equal(claudeWidgetDomain(publicUrl), "c3d80a4ed901ee05b21755a88273b4a4.claudemcpcontent.com");
        const claude = widgetResourceMeta({ apiOrigin: "https://sheetrender.com", publicUrl, host: "claude" });
        assert.equal((claude.ui as { domain: string }).domain, "c3d80a4ed901ee05b21755a88273b4a4.claudemcpcontent.com");
        const chatgpt = widgetResourceMeta({ apiOrigin: "https://sheetrender.com", publicUrl, host: "chatgpt" });
        assert.equal((chatgpt.ui as { domain: string }).domain, "https://example.com");
        assert.equal(
            claudeWidgetDomain("https://mcp.sheetrender.com/mcp"),
            createHash("sha256").update("https://mcp.sheetrender.com/mcp").digest("hex").slice(0, 32) + ".claudemcpcontent.com",
        );
    });

    it("inlines the built bundle without letting it close the script element", () => {
        assert.ok(existsSync(fileURLToPath(WIDGET_BUNDLE_URL)), "run deno task build first");
        const bundle = loadWidgetBundle();
        assert.ok(bundle.length > 1000);
        const html = widgetHtml("https://sheetrender.com", 'const a = "</script><script>alert(1)</script>";');
        assert.equal(html.match(/<\/script>/g)?.length, 1);
        assert.match(html, /<\\\/script><script>alert\(1\)<\\\/script>/);
        assert.match(widgetHtml("https://sheetrender.com"), /<script type="module">/);
        for (const ending of ["</ScRiPt >", "</SCRIPT\n>", "</script\t>", "</script/>"]) {
            const page = widgetHtml("https://sheetrender.com", `const a = ${JSON.stringify(`<!--<script>${ending}`)};`);
            assert.equal(page.match(/<\/script(?=[\s/>])/gi)?.length, 1, ending);
            assert.ok(!page.includes("<!--"), ending);
        }
        const page = widgetHtml("https://sheetrender.com", 'globalThis.matches = /<!--/u.test("<!--");');
        const script = page.match(/<script type="module">([\s\S]*)<\/script>/)![1]!;
        const context = { matches: false };
        runInNewContext(script, context);
        assert.equal(context.matches, true);
    });

    it("holds no pricing, plan, trial, upgrade or free wording in its page or view strings", () => {
        assert.doesNotMatch(widgetHtml("https://sheetrender.com", ""), BANNED_WORDS);
        const meta = JSON.stringify(widgetResourceMeta({ apiOrigin: "https://sheetrender.com", publicUrl: "https://mcp.sheetrender.com/mcp", host: "chatgpt" }));
        assert.doesNotMatch(meta, BANNED_WORDS);
        assert.doesNotMatch(readFileSync(new URL("../../README.md", import.meta.url), "utf8"), BANNED_WORDS);
        // All authored anonymous text: schema descriptions, dynamic message
        // fragments, resource metadata and HTML, not just ANON_TEXT or the view.
        for (const file of ["anon.ts", "anon-descriptions.ts", "widget-resource.ts", "widget/documents.ts", "http.ts"]) {
            const source = readFileSync(new URL(`../../src/${file}`, import.meta.url), "utf8");
            const literals = stringLiterals(source);
            assert.ok(literals.length > 10, file);
            for (const literal of literals) {
                // Backend error code used for branching, never emitted as copy.
                if (file === "anon.ts" && literal === "plan_limit") continue;
                assert.doesNotMatch(literal, BANNED_WORDS, `${file}: ${literal}`);
            }
        }
    });

    it("the policy check sees single quotes, decoded escapes and every interpolated template fragment", () => {
        const source = "// 'ignored'\nconst x = 'fr\\u0065e'; const y = `prefix ${fn({x: 'trial'})} upgrade ${1} subscriptions`;";
        assert.deepEqual(stringLiterals(source), ["free", "prefix ", "trial", " upgrade ", " subscriptions"]);
    });

    it("filters image and PDF origins and leaves row labels as text", async () => {
        const h = await view();
        const bad = ["javascript:alert(1)", "data:image/png;base64,AA", "blob:https://sheetrender.com/x",
            "https://evil.test/a", "https://sheetrender.com.evil.test/a", "https://user:pass@sheetrender.com/a"];
        const good = "https://sheetrender.com/api/previews/x/0.pdf";
        h.app.ontoolresult({ structuredContent: {
            template: "letter", documents: [good, ...bad].map((url, row_index) => ({
                row_index, label: "<script>alert(1)</script>", preview_png_url: url, pdf_url: url,
            })), missing_fields: [], volume: { used: 1, limit: 50, resets_at: null },
        } });
        assert.deepEqual(h.root.all().filter((node) => node.tag === "img").map((node) => node.src), [good]);
        const pdf = h.root.all().filter((node) => node.tag === "button");
        assert.equal(pdf.length, 1);
        await pdf[0]!.listeners.get("click")!();
        assert.deepEqual(h.opened, [good]);
        assert.ok(h.root.all().some((node) => node.textContent === "<script>alert(1)</script>"));
        assert.match(h.root.all().map((node) => node.textContent).join(" "), /49 of 50 documents left this month/);
        h.app.deny = true;
        await pdf[0]!.listeners.get("click")!();
        assert.equal(pdf[0]!.textContent, "Could not open PDF");
        assert.deepEqual(h.browserOpened, []);
    });

    it("shows volume refusal messages in a warn paragraph with no documents-left line", async () => {
        const h = await view();
        for (const [status, message, used] of [
            ["volume_used", "This month's documents for this connection are used. The count resets on 2026-11-01.", 50],
            ["volume_short", "There are 2 documents left this month, fewer than the 3 rows sent. The count resets on 2026-11-01.", 48],
        ] as const) {
            h.app.ontoolresult({ structuredContent: {
                template: "letter", template_name: "Letter", rows_received: 3, rows_rendered: 0,
                documents: [], missing_fields: [], expires_at: null, status, message,
                volume: { used, limit: 50, resets_at: "2026-11-01T00:00:00Z" },
            } });
            const nodes = h.root.all();
            assert.deepEqual(nodes.filter((node) => node.tag === "h1").map((node) => node.textContent), ["No documents rendered"]);
            const warnings = nodes.filter((node) => node.tag === "p" && node.className === "warn");
            assert.deepEqual(warnings.map((node) => node.textContent), [message]);
            assert.doesNotMatch(nodes.filter((node) => node !== warnings[0]).map((node) => node.textContent).join(" "), /documents left/i);
            assert.doesNotMatch(nodes.map((node) => node.textContent).join(" "), /\d+ of \d+ documents left/i);
            assert.equal(nodes.some((node) => node.tag === "img"), false);
            assert.doesNotMatch(nodes.map((node) => node.textContent).join(" "), BANNED_WORDS);
        }
    });

    it("says a shared limit is shared and never shows its numbers as the user's", async () => {
        const h = await view();
        const pool = { used: 1000, limit: 1000, resets_at: "2026-11-01T00:00:00Z", scope: "pool" };
        const doc = { row_index: 0, label: "A", preview_png_url: null, pdf_url: null };
        h.app.ontoolresult({ structuredContent: {
            template: "letter", documents: [doc], missing_fields: [], expires_at: null, volume: pool,
            status: "volume_short", message: "1 of the 3 rows were rendered. 2 did not fit in this month's volume, which is shared with other users. The count resets on 2026-11-01.",
        } });
        let text = h.root.all().map((node) => node.textContent).join(" ");
        assert.match(text, /This month's document limit is shared with other users; the count resets on /);
        assert.doesNotMatch(text, /\d+ of \d+ documents left/);
        // No backend message: the refusal is worded without the pool's numbers too.
        h.app.ontoolresult({ structuredContent: {
            template: "letter", documents: [], missing_fields: [], expires_at: null, volume: pool,
        } });
        text = h.root.all().map((node) => node.textContent).join(" ");
        assert.match(text, /This month's documents are used\. The limit is shared with other users and resets on /);
        assert.doesNotMatch(text, /1000/);
        assert.doesNotMatch(text, BANNED_WORDS);
    });

    it("shows a partial-render notice above the documents and retains their PDF links", async () => {
        const h = await view();
        const message = "  1 of the 3 rows was rendered. The remaining rows were not rendered.\n";
        const pdf = "https://sheetrender.com/api/previews/x/0.pdf";
        h.app.ontoolresult({ structuredContent: {
            template: "letter", template_name: "Letter", rows_received: 3, rows_rendered: 1,
            documents: [{ row_index: 0, label: "A", preview_png_url: "https://sheetrender.com/api/previews/x/0.png", pdf_url: pdf }],
            missing_fields: [], expires_at: null, status: "volume_short", message,
            volume: { used: 50, limit: 50, resets_at: "2026-11-01T00:00:00Z" },
        } });
        const nodes = h.root.all();
        assert.deepEqual(nodes.filter((node) => node.tag === "h1").map((node) => node.textContent), ["1 document ready"]);
        const notices = nodes.filter((node) => node.tag === "p" && node.className === "warn");
        assert.deepEqual(notices.map((node) => node.textContent), [message]);
        const strip = nodes.find((node) => node.className === "strip")!;
        assert.ok(strip);
        assert.ok(nodes.indexOf(notices[0]!) < nodes.indexOf(strip));
        assert.equal(nodes.filter((node) => node.tag === "img").length, 1);
        const button = nodes.find((node) => node.tag === "button" && node.textContent === "PDF")!;
        await button.listeners.get("click")!();
        assert.deepEqual(h.opened, [pdf]);
    });

    it("opens continue links with the saved row count intact in the fragment", async () => {
        const h = await view();
        h.app.ontoolinput({ arguments: { template: "letter", rows: [{ body: "A" }, { body: "B" }] } });
        h.app.ontoolresult({ structuredContent: { template: "letter", documents: [], missing_fields: [] } });
        const url = "https://sheetrender.com/templates/mail-merge-letter?ref=mcp#handoff=abc&rows=1";
        h.reply(url);
        const button = h.root.all().find((node) => node.textContent === "Continue in SheetRender with these rows")!;
        await button.listeners.get("click")!();
        assert.deepEqual(h.opened, [url]);
        assert.equal(new URL(h.opened[0]!).hash, "#handoff=abc&rows=1");
        assert.equal(h.calls.length, 1);
    });

    it("validates continue links and honours host link refusals", async () => {
        const h = await view();
        h.app.ontoolinput({ arguments: { template: "letter", rows: [{ body: "x" }] } });
        h.app.ontoolresult({ structuredContent: { template: "letter", documents: [], missing_fields: [] } });
        const button = h.root.all().find((node) => node.textContent === "Continue in SheetRender with these rows")!;
        for (const url of ["https://evil.test/", "javascript:alert(1)", "https://user:pass@sheetrender.com/"]) {
            h.reply(url);
            await button.listeners.get("click")!();
        }
        assert.deepEqual(h.opened, []);
        const good = "https://sheetrender.com/templates/mail-merge-letter#handoff=abc";
        h.reply(good);
        h.app.deny = true;
        await button.listeners.get("click")!();
        assert.deepEqual(h.opened, [good]);
        assert.deepEqual(h.browserOpened, []);
        assert.ok(h.root.all().some((node) => node.textContent.includes("The link could not be created")));
    });
});
