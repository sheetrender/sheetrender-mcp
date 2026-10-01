import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
    anonToolError,
    buildRenderResult,
    CatalogueCache,
    createAnonServer,
    detectSource,
    isClaudeIp,
    MAX_CELL_CHARS,
    MAX_CELL_BYTES,
    MAX_HANDOFF_BYTES,
    MAX_ROW_KEYS,
    normaliseCatalogue,
    SlidingWindowLimiter,
    subjectKey,
} from "../src/anon.js";
import {
    ANON_TEXT,
    BANNED_WORDS,
    CONTINUE_ROW_LIMIT,
    RENDER_ROW_LIMIT,
    TEMPLATE_KEYS,
    TEMPLATE_SLUGS,
} from "../src/anon-descriptions.js";
import {
    SheetRenderError,
    type BuiltinRenderInput,
    type BuiltinRenderResult,
    type BuiltinTemplate,
    type HandoffInput,
    type SheetRenderClient,
} from "../src/client.js";

const API_URL = "https://staging.sheetrender.test";

/**
 * The backend's real catalogue (a copy of sheetrender's
 * backend/tests/fixtures/builtin_catalogue.json), plus one key the tools do
 * not offer, which must never be listed since render_documents would refuse it.
 */
const FIXTURE = JSON.parse(
    readFileSync(new URL("../../src-test/fixtures/builtin_catalogue.json", import.meta.url), "utf8"),
) as { templates: BuiltinTemplate[]; limits: Record<string, number> };
const CATALOGUE: BuiltinTemplate[] = [
    ...FIXTURE.templates,
    { key: "invoice", name: "Invoice", description: "Not offered.", fields: [] },
];

const RENDERED: BuiltinRenderResult = {
    render_id: "r_1",
    documents: [
        { row_index: 0, label: "Ada Lovelace", preview_png_url: "/api/previews/r_1/0.png", pdf_url: "/api/previews/r_1/0.pdf" },
        { row_index: 1, label: "Grace Hopper", preview_png_url: "/api/previews/r_1/1.png", pdf_url: "/api/previews/r_1/1.pdf" },
    ],
    missing_fields: [{ row_index: 2, fields: ["course"] }],
    volume: { used: 12, limit: 50, resets_at: "2026-11-01T00:00:00Z" },
    expires_at: "2026-10-01T14:00:00Z",
};

interface Calls {
    renders: Array<[string, BuiltinRenderInput]>;
    handoffs: HandoffInput[];
    catalogue: number;
}

function fakeClient(overrides: Partial<SheetRenderClient> = {}): { client: SheetRenderClient; calls: Calls } {
    const calls: Calls = { renders: [], handoffs: [], catalogue: 0 };
    const client = {
        baseUrl: API_URL,
        listBuiltinTemplates: async () => {
            calls.catalogue += 1;
            return CATALOGUE;
        },
        renderBuiltin: async (key: string, input: BuiltinRenderInput) => {
            calls.renders.push([key, input]);
            return RENDERED;
        },
        createHandoff: async (input: HandoffInput) => {
            calls.handoffs.push(input);
            return { token: "tok_abc-123", expires_at: "2026-10-08T12:00:00Z" };
        },
        ...overrides,
    } as unknown as SheetRenderClient;
    return { client, calls };
}

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
    while (closers.length) await closers.pop()!();
});

interface ConnectOptions {
    client?: SheetRenderClient;
    limiter?: SlidingWindowLimiter;
    claudeLimiter?: SlidingWindowLimiter;
    catalogue?: CatalogueCache;
    clientIp?: string;
    publicUrl?: string;
    demoApiKey?: string;
}

async function connect(options: ConnectOptions = {}): Promise<{ client: Client; calls: Calls }> {
    const fake = options.client ? { client: options.client, calls: { renders: [], handoffs: [], catalogue: 0 } } : fakeClient();
    const server = createAnonServer({
        client: fake.client,
        limiter: options.limiter ?? new SlidingWindowLimiter(30, 3_600_000),
        claudeLimiter: options.claudeLimiter,
        catalogue: options.catalogue ?? new CatalogueCache(),
        clientIp: options.clientIp ?? "203.0.113.9",
        publicUrl: options.publicUrl,
        demoApiKey: options.demoApiKey,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closers.push(async () => {
        await client.close();
        await server.close();
    });
    return { client, calls: fake.calls };
}

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

function textOf(result: ToolResult): string {
    return (result.content as { text: string }[])[0]!.text;
}

function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

const CERT_ROWS = [
    { recipient_name: "Ada Lovelace", course: "Engines", date: "2026-09-30" },
    { recipient_name: "Grace Hopper", course: "Compilers", date: "2026-09-30" },
    { recipient_name: "Alan Turing", date: "2026-09-30" },
];

describe("anonymous tool list", () => {
    it("offers exactly the three anonymous tools, each with a title and the required annotations", async () => {
        const { client } = await connect();
        const { tools } = await client.listTools();
        assert.deepEqual(tools.map((tool) => tool.name).sort(), [
            "create_continue_link",
            "list_document_templates",
            "render_documents",
        ]);
        for (const tool of tools) {
            assert.ok(tool.title, tool.name);
            assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", tool.name);
            assert.equal(typeof tool.annotations?.destructiveHint, "boolean", tool.name);
            assert.equal(typeof tool.annotations?.openWorldHint, "boolean", tool.name);
            assert.deepEqual(tool._meta?.securitySchemes, [{ type: "noauth" }], tool.name);
            assert.ok(tool.outputSchema, tool.name);
            assert.ok(tool.name.length <= 64);
        }
        const byName = new Map(tools.map((tool) => [tool.name, tool]));
        assert.equal(byName.get("list_document_templates")!.annotations!.readOnlyHint, true);
        assert.equal(byName.get("render_documents")!.annotations!.readOnlyHint, true);
        assert.equal(byName.get("create_continue_link")!.annotations!.readOnlyHint, false);
        assert.equal(byName.get("create_continue_link")!.annotations!.destructiveHint, false);
    });

    it("links render_documents to the view and lets the view call create_continue_link", async () => {
        const { client } = await connect();
        const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
        const render = tools.get("render_documents")!._meta!;
        assert.deepEqual(render.ui, { resourceUri: "ui://sheetrender/documents.html" });
        assert.equal(render["openai/outputTemplate"], "ui://sheetrender/documents.html");
        assert.equal(render["ui/resourceUri"], "ui://sheetrender/documents.html");
        assert.equal(render["openai/toolInvocation/invoking"], "Rendering documents");
        assert.equal(render["openai/toolInvocation/invoked"], "Documents ready");
        const cont = tools.get("create_continue_link")!._meta!;
        assert.deepEqual(cont.ui, { visibility: ["model", "app"] });
        assert.equal(cont["openai/widgetAccessible"], true);
    });

    it("takes a fixed template key and caps rows at 25 to render and 100 to continue", async () => {
        const { client } = await connect();
        const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
        type ArraySchema = { maxItems?: number; minItems?: number };
        type Props = { template: { enum: string[] }; rows: ArraySchema };
        const render = tools.get("render_documents")!.inputSchema;
        const cont = tools.get("create_continue_link")!.inputSchema;
        assert.deepEqual((render.properties as unknown as Props).template.enum, [
            "certificate", "letter", "donation_receipt", "job_offer_letter",
        ]);
        assert.equal((render.properties as unknown as Props).rows.maxItems, 25);
        assert.equal((cont.properties as unknown as Props).rows.maxItems, 100);
        assert.deepEqual(render.required?.slice().sort(), ["rows", "template"]);
    });

    it("never mentions pricing, plans, trials, upgrades or anything free", async () => {
        const { client } = await connect();
        const listing = JSON.stringify(await client.listTools());
        assert.doesNotMatch(listing, BANNED_WORDS);
        for (const [name, value] of Object.entries(ANON_TEXT)) {
            assert.doesNotMatch(value, BANNED_WORDS, name);
        }
        // The check itself catches what it must.
        for (const word of ["Free", "pricing", "price", "plan", "trial", "upgrade", "subscription", "discount", "free-form"]) {
            assert.match(word, BANNED_WORDS);
        }
    });
});

describe("list_document_templates", () => {
    it("returns the four templates in a fixed order with guide links on the API's origin", async () => {
        const { client } = await connect();
        const result = await client.callTool({ name: "list_document_templates", arguments: {} });
        assert.equal(result.isError, undefined);
        const templates = (result.structuredContent as { templates: { key: string; guide_url: string; fields: unknown[] }[] }).templates;
        assert.deepEqual(templates.map((t) => t.key), ["certificate", "letter", "donation_receipt", "job_offer_letter"]);
        assert.equal(templates[0]!.guide_url, `${API_URL}/templates/certificate-of-completion`);
        assert.equal(templates[1]!.guide_url, `${API_URL}/templates/mail-merge-letter`);
        assert.deepEqual(templates[0]!.fields[3], {
            key: "issuer",
            label: "Issued by",
            required: false,
            example: "Northfield Training Institute",
            description: "The organisation awarding the certificate, printed across the top.",
        });
        const text = textOf(result);
        assert.match(text, /^4 templates:\ncertificate: Certificate of completion \(A4, landscape\)\. A landscape certificate/);
        assert.match(text, /  - recipient_name \(required\): The person receiving the certificate/);
        assert.match(text, /  guide: https:\/\/staging\.sheetrender\.test\/templates\/certificate-of-completion/);
        assert.doesNotMatch(text, /invoice/i);
        assert.doesNotMatch(JSON.stringify(result), BANNED_WORDS);
    });

    it("agrees with the backend catalogue on keys, page slugs and limits", () => {
        assert.deepEqual(FIXTURE.templates.map((t) => t.key), [...TEMPLATE_KEYS]);
        for (const template of FIXTURE.templates) {
            assert.equal(template.slug, TEMPLATE_SLUGS[template.key as keyof typeof TEMPLATE_SLUGS], template.key);
        }
        assert.equal(FIXTURE.limits.rows_per_render, RENDER_ROW_LIMIT);
        assert.equal(FIXTURE.limits.rows_per_handoff, CONTINUE_ROW_LIMIT);
        assert.equal(FIXTURE.limits.cell_max_chars, MAX_CELL_CHARS);
        assert.equal(FIXTURE.limits.cell_max_bytes, MAX_CELL_BYTES);
        assert.equal(FIXTURE.limits.handoff_payload_max_bytes, MAX_HANDOFF_BYTES);
        assert.equal(FIXTURE.limits.title_max_chars, 120);
        assert.equal(FIXTURE.limits.documents_per_month, 50);
    });

    it("accepts the catalogue as a bare array or under `templates`, and fills in missing names", () => {
        const normalised = normaliseCatalogue([{ key: "letter" }], "https://sheetrender.com/");
        assert.deepEqual(normalised, [{
            key: "letter",
            name: "Letter",
            description: "",
            page: "A4",
            orientation: "portrait",
            guide_url: "https://sheetrender.com/templates/mail-merge-letter",
            fields: [],
        }]);
    });

    it("caches the catalogue for an hour and serves the stale copy if a refresh fails", async () => {
        let now = 0;
        const cache = new CatalogueCache(3_600_000, () => now);
        let fail = false;
        let fetched = 0;
        const { client } = fakeClient({
            listBuiltinTemplates: async () => {
                fetched += 1;
                if (fail) throw new SheetRenderError("down", 503);
                return CATALOGUE;
            },
        });
        await cache.get(client);
        await cache.get(client);
        assert.equal(fetched, 1);
        now = 3_600_001;
        fail = true;
        const stale = await cache.get(client);
        assert.equal(fetched, 2);
        assert.equal(stale.length, 4);
    });

    it("bounds cached fields and text even if the backend catalogue grows", () => {
        const templates = normaliseCatalogue([{
            key: "letter", name: "x".repeat(10_000),
            fields: Array.from({ length: 1000 }, (_, i) => ({
                key: `field_${i}`, description: "x".repeat(10_000), example: "x".repeat(10_000),
            })),
        }], API_URL);
        assert.equal(templates[0]!.name.length, MAX_CELL_CHARS);
        assert.equal(templates[0]!.fields.length, MAX_ROW_KEYS);
        assert.equal(templates[0]!.fields[0]!.description.length, MAX_CELL_CHARS);
        assert.equal((templates[0]!.fields[0]!.example as string).length, MAX_CELL_CHARS);
    });

    it("rejects backend-authored promotional catalogue strings", async () => {
        for (const field of ["name", "description", "example", "label"]) {
            const bad = field === "name" || field === "description"
                ? { key: "letter", [field]: "Upgrade your plan" }
                : { key: "letter", fields: [{ key: "body", [field]: "Upgrade your plan" }] };
            const { client } = await connect({ client: fakeClient({ listBuiltinTemplates: async () => [bad] }).client });
            const result = await client.callTool({ name: "list_document_templates", arguments: {} });
            assert.equal(result.isError, true);
            assert.doesNotMatch(JSON.stringify(result), BANNED_WORDS);
        }
    });
});

describe("render_documents", () => {
    it("forwards rows with a hashed subject and the source, and returns the plan's structuredContent", async () => {
        const { client, calls } = await connect();
        const result = await client.callTool({
            name: "render_documents",
            arguments: { template: "certificate", rows: CERT_ROWS, title: "Q3" },
            _meta: { "openai/subject": "user-123", "openai/locale": "en-GB" },
        });
        assert.equal(result.isError, undefined, textOf(result));

        assert.equal(calls.renders.length, 1);
        const [key, input] = calls.renders[0]!;
        assert.equal(key, "certificate");
        assert.deepEqual(input.rows, CERT_ROWS);
        assert.equal(input.title, "Q3");
        assert.equal(input.subject, `sub:${sha256("user-123")}`);
        assert.equal(input.source, "chatgpt");

        assert.deepEqual(result.structuredContent, {
            template: "certificate",
            template_name: "Certificate of completion",
            rows_received: 3,
            rows_rendered: 2,
            documents: [
                {
                    row_index: 0,
                    label: "Ada Lovelace",
                    preview_png_url: `${API_URL}/api/previews/r_1/0.png`,
                    pdf_url: `${API_URL}/api/previews/r_1/0.pdf`,
                },
                {
                    row_index: 1,
                    label: "Grace Hopper",
                    preview_png_url: `${API_URL}/api/previews/r_1/1.png`,
                    pdf_url: `${API_URL}/api/previews/r_1/1.pdf`,
                },
            ],
            expires_at: "2026-10-01T14:00:00Z",
            missing_fields: [{ row_index: 2, fields: ["course"] }],
            volume: { used: 12, limit: 50, resets_at: "2026-11-01T00:00:00Z" },
            continue: { guide_url: `${API_URL}/templates/certificate-of-completion`, how: ANON_TEXT.continueHow },
        });
        const text = textOf(result);
        assert.match(text, /Rendered 2 documents from 3 rows with the Certificate of completion template\./);
        assert.match(text, /row 3 \(course\)/);
        assert.match(text, /38 of 50 documents left this month; the count resets on 2026-11-01\./);
        assert.match(text, /Row 1, Ada Lovelace: https:\/\/staging\.sheetrender\.test\/api\/previews\/r_1\/0\.pdf/);
        assert.ok(text.endsWith(ANON_TEXT.continueHow));
        assert.doesNotMatch(text, BANNED_WORDS);
        assert.doesNotMatch(text, /daily/i);
    });

    it("falls back to the client IP when there is no subject", async () => {
        const { client, calls } = await connect({ clientIp: "198.51.100.7" });
        await client.callTool({ name: "render_documents", arguments: { template: "letter", rows: [{ recipient_name: "A", body: "B" }] } });
        assert.equal(calls.renders[0]![1].subject, `ip:${sha256("198.51.100.7")}`);
        assert.equal(calls.renders[0]![1].source, "other");
    });

    it("refuses 26 rows, nested values and unknown templates before calling the backend", async () => {
        const { client, calls } = await connect();
        const rows = Array.from({ length: 26 }, (_, i) => ({ recipient_name: `R${i}`, body: "x" }));
        const tooMany = await client.callTool({ name: "render_documents", arguments: { template: "letter", rows } });
        assert.equal(tooMany.isError, true);
        const nested = await client.callTool({
            name: "render_documents",
            arguments: { template: "letter", rows: [{ recipient_name: { first: "A" }, body: "x" }] },
        });
        assert.equal(nested.isError, true);
        const unknown = await client.callTool({
            name: "render_documents",
            arguments: { template: "invoice", rows: [{ a: 1 }] },
        });
        assert.equal(unknown.isError, true);
        const longCell = await client.callTool({
            name: "render_documents",
            arguments: { template: "letter", rows: [{ recipient_name: "A", body: "x".repeat(2001) }] },
        });
        assert.equal(longCell.isError, true);
        assert.equal(calls.renders.length, 0);
    });

    it("reports a used-up month with zero documents, the reset date and nothing else", () => {
        const result = buildRenderResult("certificate", 3, {
            documents: [],
            missing_fields: [],
            monthly_volume: { used: 50, limit: 50, resets_at: "2026-11-01T00:00:00Z" },
            expires_at: null,
        }, API_URL);
        assert.equal(result.isError, undefined);
        assert.equal(
            (result.content[0] as { text: string }).text,
            "No documents were rendered: this month's 50 documents are used. The count resets on 2026-11-01.",
        );
        const structured = result.structuredContent as { rows_rendered: number; volume: unknown };
        assert.equal(structured.rows_rendered, 0);
        assert.deepEqual(structured.volume, { used: 50, limit: 50, resets_at: "2026-11-01T00:00:00Z" });
    });

    it("enforces the UTF-8 cell cap on render and continue without truncating valid cells", async () => {
        const { client, calls } = await connect();
        for (const name of ["render_documents", "create_continue_link"]) {
            const tooLarge = await client.callTool({ name, arguments: { template: "letter", rows: [{ body: "😀".repeat(513) }] } });
            assert.equal(tooLarge.isError, true);
            const valid = await client.callTool({ name, arguments: { template: "letter", rows: [{ body: "😀".repeat(512) }] } });
            assert.equal(valid.isError, undefined);
        }
        assert.equal(calls.renders.length, 1);
        assert.equal(calls.handoffs.length, 1);
        assert.equal(calls.renders[0]![1].rows[0]!.body, "😀".repeat(512));
    });

    it("reads the volume under its old `daily_volume` name too", () => {
        const result = buildRenderResult("letter", 1, {
            documents: [],
            daily_volume: { used: 1, limit: 50, resets_at: null },
        }, API_URL);
        assert.deepEqual((result.structuredContent as { volume: unknown }).volume, { used: 1, limit: 50, resets_at: null });
    });

    it("drops off-origin, credentialed and non-preview links from model and widget output", () => {
        for (const url of [
            "javascript:alert(1)", "data:application/pdf;base64,AA", "//evil.test/api/previews/x/0.pdf",
            "https://evil.test/api/previews/x/0.pdf", `${API_URL}.evil.test/api/previews/x/0.pdf`,
            "https://user:password@staging.sheetrender.test/api/previews/x/0.pdf", `${API_URL}/signup`,
        ]) {
            const result = buildRenderResult("letter", 1, {
                documents: [{ row_index: 0, label: "x", preview_png_url: url, pdf_url: url }],
            }, API_URL);
            const doc = (result.structuredContent as { documents: { preview_png_url: unknown; pdf_url: unknown }[] }).documents[0]!;
            assert.equal(doc.preview_png_url, null, url);
            assert.equal(doc.pdf_url, null, url);
            assert.ok(!textOf(result).includes(url), url);
        }
    });

    it("words a backend capacity refusal neutrally, whatever the body says", async () => {
        const { client } = await connect({
            client: fakeClient({
                renderBuiltin: async () => {
                    throw new SheetRenderError("Rendering documents failed: plan limit reached (HTTP 429).", 429, {
                        code: "plan_limit",
                        message: "Upgrade your plan",
                    });
                },
            }).client,
        });
        const result = await client.callTool({ name: "render_documents", arguments: { template: "letter", rows: [{ body: "x" }] } });
        assert.equal(result.isError, true);
        assert.equal(textOf(result), ANON_TEXT.busy);
    });

    it("never forwards upstream error text, credentials or row values", () => {
        const kept = anonToolError(new SheetRenderError("Rendering documents failed: rows.0.date: bad date (HTTP 422).", 422), "Rendering documents");
        assert.match((kept.content[0] as { text: string }).text, /Check them against the template's fields/);
        const dropped = anonToolError(new SheetRenderError("Rendering documents failed: not on your plan (HTTP 422).", 422), "Rendering documents");
        assert.doesNotMatch((dropped.content[0] as { text: string }).text, BANNED_WORDS);
        const handoff = anonToolError(new SheetRenderError("x (HTTP 429).", 429), "Creating the continue link");
        assert.equal((handoff.content[0] as { text: string }).text, ANON_TEXT.continueBusy);
        const auth = anonToolError(new SheetRenderError("x (HTTP 401).", 401), "Rendering documents");
        assert.match((auth.content[0] as { text: string }).text, /failed on the SheetRender side/);
        const capacity = anonToolError(new SheetRenderError("Upgrade", 403, { code: "plan_limit" }), "Rendering documents");
        assert.equal((capacity.content[0] as { text: string }).text, ANON_TEXT.busy);
        for (const status of [undefined, 400, 401, 403, 404, 413, 422, 429, 500]) {
            const result = anonToolError(new SheetRenderError("sr_live_secret Ada Private Upgrade your plan", status), "Rendering documents");
            assert.doesNotMatch(JSON.stringify(result), /sr_live_secret|Ada Private/);
            assert.doesNotMatch(JSON.stringify(result), BANNED_WORDS);
        }
    });

    it("refuses a successful upstream reply that reflects the hosted credential", async () => {
        const { client } = await connect({
            demoApiKey: "sr_live_secret",
            client: fakeClient({
                listBuiltinTemplates: async () => [{ key: "letter", name: "sr_live_secret" }],
                renderBuiltin: async () => ({ documents: [{ row_index: 0, label: "sr_live_secret" }] }),
                createHandoff: async () => ({ token: "sr_live_secret" }),
            }).client,
        });
        for (const name of ["list_document_templates", "render_documents", "create_continue_link"]) {
            const result = await client.callTool({ name, arguments: { template: "letter", rows: [{ body: "x" }] } });
            assert.equal(result.isError, true, name);
            assert.doesNotMatch(JSON.stringify(result), /sr_live_secret/);
        }
    });
});

describe("create_continue_link", () => {
    it("stores the rows and returns the template page with the token in the fragment", async () => {
        const { client, calls } = await connect();
        const rows = Array.from({ length: 42 }, (_, i) => ({ recipient_name: `R${i}`, course: "C", date: "2026-09-30" }));
        const result = await client.callTool({
            name: "create_continue_link",
            arguments: { template: "certificate", rows, title: "Volunteers" },
            _meta: { "openai/subject": "user-123" },
        });
        assert.equal(result.isError, undefined, textOf(result));
        const url = `${API_URL}/templates/certificate-of-completion?ref=chatgpt#handoff=tok_abc-123`;
        assert.deepEqual(result.structuredContent, {
            continue_url: url,
            expires_at: "2026-10-08T12:00:00Z",
            rows_saved: 42,
        });
        assert.equal(textOf(result), `Your 42 rows are loaded on the template page: ${url}\nThe link expires in 7 days.`);
        assert.deepEqual(calls.handoffs, [{
            template: "certificate",
            rows,
            title: "Volunteers",
            subject: `sub:${sha256("user-123")}`,
            source: "chatgpt",
        }]);
    });

    it("accepts 100 rows and refuses 101", async () => {
        const { client, calls } = await connect();
        const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ recipient_name: `R${i}`, body: "x" }));
        const ok = await client.callTool({ name: "create_continue_link", arguments: { template: "letter", rows: rows(100) } });
        assert.equal(ok.isError, undefined, textOf(ok));
        const tooMany = await client.callTool({ name: "create_continue_link", arguments: { template: "letter", rows: rows(101) } });
        assert.equal(tooMany.isError, true);
        assert.equal(calls.handoffs.length, 1);
    });

    it("refuses a payload over 256 KB without calling the backend", async () => {
        const { client, calls } = await connect();
        const rows = Array.from({ length: 100 }, () => ({ body: "x".repeat(2000), a: "y".repeat(2000) }));
        const result = await client.callTool({ name: "create_continue_link", arguments: { template: "letter", rows } });
        assert.equal(result.isError, true);
        assert.match(textOf(result), /256 KB/);
        assert.equal(calls.handoffs.length, 0);
    });

    it("includes title and identity in the handoff byte cap", async () => {
        const { client, calls } = await connect();
        const rows = Array.from({ length: 100 }, () => ({ body: "x".repeat(2000), a: "y".repeat(600) }));
        // Rows fit, but adding the envelope crosses the backend's exact cap.
        const gap = MAX_HANDOFF_BYTES - Buffer.byteLength(JSON.stringify(rows)) - 1;
        rows[0]!.a += "z".repeat(gap);
        assert.equal(Buffer.byteLength(JSON.stringify(rows)), MAX_HANDOFF_BYTES - 1);
        const result = await client.callTool({ name: "create_continue_link", arguments: { template: "letter", rows, title: "x".repeat(120) } });
        assert.equal(result.isError, true);
        assert.match(textOf(result), /256 KB/);
        assert.equal(calls.handoffs.length, 0);
    });
});

describe("flood guard", () => {
    it("isolates the shared Claude network budget, retains subjects and expires the window", async () => {
        let now = 0;
        const limiter = new SlidingWindowLimiter(1, 3_600_000, () => now);
        const claudeLimiter = new SlidingWindowLimiter(3, 3_600_000, () => now, 1);
        const a = await connect({ limiter, claudeLimiter, clientIp: "160.79.104.1" });
        const b = await connect({ limiter, claudeLimiter, clientIp: "160.79.111.255" });
        const other = await connect({ limiter, claudeLimiter, clientIp: "160.79.112.0" });
        const call = (client: Client, subject?: string, name = "render_documents") => client.callTool({
            name, arguments: { template: "letter", rows: [{ body: "x" }] },
            ...(subject ? { _meta: { "openai/subject": subject } } : {}),
        });
        assert.equal((await call(a.client)).isError, undefined);
        assert.equal((await call(b.client, undefined, "create_continue_link")).isError, undefined);
        assert.equal((await call(a.client)).isError, undefined);
        const sharedRefusal = await call(b.client);
        assert.equal(sharedRefusal.isError, true);
        assert.equal(textOf(sharedRefusal), ANON_TEXT.tooManySharedCalls.replace("{minutes}", "60"));
        assert.equal(claudeLimiter.size, 1);
        assert.equal(limiter.size, 0);
        // A ChatGPT subject on that same network retains its ordinary budget.
        assert.equal((await call(a.client, "chatgpt-user")).isError, undefined);
        assert.equal((await call(a.client, "chatgpt-user")).isError, true);
        assert.equal((await call(other.client)).isError, undefined);
        assert.equal((await call(other.client)).isError, true);
        // The backend's quota identity stays the hashed IP, not the shared key.
        assert.equal(a.calls.renders[0]![1].subject, `ip:${sha256("160.79.104.1")}`);
        now += 3_600_000;
        assert.equal((await call(b.client)).isError, undefined);
    });
    it("limits render and continue calls per subject, then per IP for callers without one", async () => {
        let now = 1_000_000;
        const limiter = new SlidingWindowLimiter(2, 3_600_000, () => now);
        const { client, calls } = await connect({ limiter, clientIp: "203.0.113.1" });
        const call = (meta?: Record<string, unknown>) =>
            client.callTool({
                name: "render_documents",
                arguments: { template: "letter", rows: [{ recipient_name: "A", body: "B" }] },
                ...(meta ? { _meta: meta } : {}),
            });

        assert.equal((await call({ "openai/subject": "a" })).isError, undefined);
        assert.equal((await call({ "openai/subject": "a" })).isError, undefined);
        const third = await call({ "openai/subject": "a" });
        assert.equal(third.isError, true);
        assert.equal(textOf(third), "Too many requests from this user in the last hour. Try again in 60 minutes.");
        // Another subject on the same IP has its own window.
        assert.equal((await call({ "openai/subject": "b" })).isError, undefined);
        // No subject: counted against the IP.
        assert.equal((await call()).isError, undefined);
        assert.equal((await call()).isError, undefined);
        assert.equal((await call()).isError, true);
        assert.equal(calls.renders.length, 5);

        now += 3_600_001;
        assert.equal((await call({ "openai/subject": "a" })).isError, undefined);
    });

    it("does not count catalogue listings", async () => {
        const limiter = new SlidingWindowLimiter(1, 3_600_000);
        const { client } = await connect({ limiter });
        for (let i = 0; i < 3; i++) {
            const result = await client.callTool({ name: "list_document_templates", arguments: {} });
            assert.equal(result.isError, undefined);
        }
        assert.equal(limiter.size, 0);
    });

    it("keeps its memory bounded", () => {
        let now = 0;
        const limiter = new SlidingWindowLimiter(5, 1000, () => now, 3);
        for (const key of ["a", "b", "c", "d", "e"]) {
            limiter.take(key);
            now += 1;
        }
        assert.equal(limiter.size, 3);
    });
});

describe("caller identity", () => {
    it("recognises only valid IPv4 addresses in Claude's exact /21, including mapped IPv4", () => {
        for (const ip of ["160.79.104.0", "160.79.111.255", "::ffff:160.79.105.2"]) assert.equal(isClaudeIp(ip), true, ip);
        for (const ip of ["160.79.103.255", "160.79.112.0", "160.79.104.999", "160.79.104.1.evil", "2001:db8::1"]) {
            assert.equal(isClaudeIp(ip), false, ip);
        }
    });
    it("detects ChatGPT from openai/* meta, and Claude or ChatGPT from the User-Agent", () => {
        assert.equal(detectSource({ "openai/subject": "x" }, undefined), "chatgpt");
        assert.equal(detectSource(undefined, "openai-mcp/1.0"), "chatgpt");
        assert.equal(detectSource(undefined, "Claude-User/1.0"), "claude");
        assert.equal(detectSource({ progressToken: 1 }, "curl/8"), "other");
    });

    it("hashes the subject and falls back to the hashed IP", () => {
        assert.equal(subjectKey({ "openai/subject": " s " }, "1.2.3.4"), `sub:${sha256("s")}`);
        assert.equal(subjectKey({ "openai/subject": "" }, "1.2.3.4"), `ip:${sha256("1.2.3.4")}`);
        assert.equal(subjectKey({ "openai/subject": 5 }, "1.2.3.4"), `ip:${sha256("1.2.3.4")}`);
        assert.equal(subjectKey(undefined, "1.2.3.4"), `ip:${sha256("1.2.3.4")}`);
    });

    it("uses ref=claude for Claude's continue links", async () => {
        const { client: fake } = fakeClient();
        const server = createAnonServer({
            client: fake,
            limiter: new SlidingWindowLimiter(30, 3_600_000),
            catalogue: new CatalogueCache(),
            clientIp: "203.0.113.9",
        });
        // The in-memory transport carries no HTTP headers, so drive the
        // handler as the HTTP transport would, with a Claude User-Agent.
        type Registered = { handler: (args: unknown, extra: unknown) => Promise<{ structuredContent: { continue_url: string } }> };
        const tool = (server as unknown as { _registeredTools: Record<string, Registered> })._registeredTools["create_continue_link"]!;
        const result = await tool.handler(
            { template: "donation_receipt", rows: [{ donor_name: "A" }] },
            { requestInfo: { headers: { "user-agent": "Claude-User" } } },
        );
        assert.equal(
            result.structuredContent.continue_url,
            `${API_URL}/templates/donation-receipt?ref=claude#handoff=tok_abc-123`,
        );
    });
});
