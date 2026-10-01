import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
    anonToolError,
    buildRenderResult,
    callerSource,
    CatalogueCache,
    checkRows,
    CidrSet,
    clientNetwork,
    createAnonServer,
    detectSource,
    floodNetwork,
    InFlightLimiter,
    isClaudeIp,
    MAX_DETAIL_CHARS,
    MAX_CELL_CHARS,
    MAX_CELL_BYTES,
    MAX_HANDOFF_BYTES,
    MAX_ROW_KEYS,
    normaliseCatalogue,
    OPENAI_EGRESS_CIDRS,
    parseCidr,
    pythonLength,
    pythonLineCount,
    pythonStrip,
    resourceHost,
    SlidingWindowLimiter,
    subjectKey,
    trustedOpenaiSubject,
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
            return { token: "tok_abc-123", rows_saved: input.rows.length, expires_at: "2026-10-08T12:00:00Z" };
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
    networkLimiter?: SlidingWindowLimiter;
    catalogue?: CatalogueCache;
    clientIp?: string;
    openaiEgress?: CidrSet;
    sessionId?: string;
    publicUrl?: string;
    demoApiKey?: string;
}

/**
 * Stands in for OpenAI's egress ranges in these tests: the default client IP
 * (TEST-NET-3) is believed when it sends an `openai/subject`; 198.51.100.0/24
 * (TEST-NET-2) is an ordinary caller whose subject is ignored.
 */
const TEST_OPENAI_EGRESS = new CidrSet(["203.0.113.0/24"]);

async function connect(options: ConnectOptions = {}): Promise<{ client: Client; calls: Calls }> {
    const fake = options.client ? { client: options.client, calls: { renders: [], handoffs: [], catalogue: 0 } } : fakeClient();
    const server = createAnonServer({
        client: fake.client,
        limiter: options.limiter ?? new SlidingWindowLimiter(30, 3_600_000),
        claudeLimiter: options.claudeLimiter,
        networkLimiter: options.networkLimiter,
        catalogue: options.catalogue ?? new CatalogueCache(),
        clientIp: options.clientIp ?? "203.0.113.9",
        openaiEgress: options.openaiEgress ?? TEST_OPENAI_EGRESS,
        sessionId: options.sessionId,
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
        // render_documents stores files and counts against the month: not read-only.
        assert.equal(byName.get("render_documents")!.annotations!.readOnlyHint, false);
        assert.equal(byName.get("create_continue_link")!.annotations!.readOnlyHint, false);
        for (const tool of tools) {
            assert.equal(tool.annotations!.destructiveHint, false, tool.name);
            assert.equal(tool.annotations!.openWorldHint, false, tool.name);
        }
        assert.equal(byName.get("render_documents")!.annotations!.idempotentHint, false);
        assert.equal(byName.get("create_continue_link")!.annotations!.idempotentHint, false);
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
        for (const word of ["Free", "pricing", "price", "plan", "plans", "trial", "upgrade", "subscription", "discount", "free-form"]) {
            assert.match(word, BANNED_WORDS);
        }
        // Whole words only: names and ordinary words that contain one pass.
        for (const word of ["Jane Freeman", "explanation", "planned", "carefree", "planet", "priceless"]) {
            assert.doesNotMatch(word, BANNED_WORDS);
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
            max_chars: 2000,
            max_bytes: 2048,
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

    it("preserves every fixture field's integer caps, including the longer letter body", () => {
        const normalised = normaliseCatalogue(FIXTURE.templates, API_URL);
        for (const template of FIXTURE.templates) {
            const fields = template.fields!;
            assert.ok(fields.length > 0, template.key);
            for (const field of fields) {
                const label = `${template.key}.${field.key}`;
                assert.ok(Number.isInteger(field.max_chars), label);
                assert.ok(Number.isInteger(field.max_bytes), label);
                const isBody = template.key === "letter" && field.key === "body";
                assert.equal(field.max_chars, isBody ? 5000 : 2000, label);
                assert.equal(field.max_bytes, isBody ? 12288 : 2048, label);
            }
            assert.deepEqual(
                normalised.find((item) => item.key === template.key)!.fields.map((field) => ({
                    key: field.key, max_chars: field.max_chars, max_bytes: field.max_bytes,
                })),
                fields.map((field) => ({ key: field.key, max_chars: field.max_chars, max_bytes: field.max_bytes })),
            );
        }
        const body = normalised.find((template) => template.key === "letter")!.fields.find((field) => field.key === "body")!;
        assert.equal(body.max_chars, 5000);
        assert.equal(body.max_bytes, 12288);
    });

    it("defaults absent or invalid field caps independently to 2000 characters and 2048 bytes", () => {
        const invalidCaps: unknown[] = [null, 0, -1, 1.5, "5000", NaN, Infinity];
        // The catalogue arrives as JSON, so malformed runtime values need not
        // conform to BuiltinTemplateField's declared numeric cap types.
        const templates = normaliseCatalogue([{
            key: "letter",
            fields: [
                { key: "missing" },
                ...invalidCaps.map((cap, index) => ({ key: `invalid_${index}`, max_chars: cap, max_bytes: cap })),
                { key: "chars_only", max_chars: 5000, max_bytes: 0 },
                { key: "bytes_only", max_chars: -1, max_bytes: 12288 },
            ],
        }] as unknown as BuiltinTemplate[], API_URL);
        const fields = templates[0]!.fields;
        for (const field of fields.slice(0, invalidCaps.length + 1)) {
            assert.equal(field.max_chars, MAX_CELL_CHARS, field.key);
            assert.equal(field.max_bytes, MAX_CELL_BYTES, field.key);
        }
        assert.equal(fields.at(-2)!.max_chars, 5000);
        assert.equal(fields.at(-2)!.max_bytes, MAX_CELL_BYTES);
        assert.equal(fields.at(-1)!.max_chars, MAX_CELL_CHARS);
        assert.equal(fields.at(-1)!.max_bytes, 12288);
    });

    it("lists the longer character cap and every line cap in the list text", async () => {
        const { client } = await connect();
        const result = await client.callTool({ name: "list_document_templates", arguments: {} });
        const capped = textOf(result).split("\n").filter((line) => line.includes("up to"));
        assert.equal(capped.length, 3);
        assert.match(capped[0]!, /^  - body \(required, up to 5000 characters, up to 150 lines\):/);
        assert.match(capped[1]!, /^  - address \(up to 150 lines\):/);
        assert.match(capped[2]!, /^  - notes \(up to 150 lines\):/);
        assert.doesNotMatch(textOf(result), /up to 2000 characters/);
        const templates = (result.structuredContent as { templates: { key: string; fields: { key: string; max_lines?: number }[] }[] }).templates;
        const lined = templates.flatMap((t) => t.fields.filter((f) => f.max_lines !== undefined).map((f) => `${t.key}.${f.key}=${f.max_lines}`));
        assert.deepEqual(lined, ["letter.body=150", "donation_receipt.address=150", "donation_receipt.notes=150"]);
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

    it("rejects backend-authored promotional catalogue prose", async () => {
        for (const field of ["name", "description", "label", "field description"]) {
            const bad = field === "name" || field === "description"
                ? { key: "letter", [field]: "Upgrade your plan" }
                : { key: "letter", fields: [{ key: "body", [field === "label" ? "label" : "description"]: "Upgrade your plan" }] };
            const { client } = await connect({ client: fakeClient({ listBuiltinTemplates: async () => [bad] }).client });
            const result = await client.callTool({ name: "list_document_templates", arguments: {} });
            assert.equal(result.isError, true, field);
            assert.doesNotMatch(JSON.stringify(result), BANNED_WORDS);
        }
    });

    it("never checks example values, and checks prose by whole words", async () => {
        const catalogue = [{
            key: "letter",
            description: "A letter with an explanation of the planned changes.",
            fields: [
                { key: "recipient_name", label: "Recipient", example: "Jane Freeman" },
                { key: "body", description: "The body, printed carefree.", example: "Our free trial ends soon." },
            ],
        }] as BuiltinTemplate[];
        const { client } = await connect({ client: fakeClient({ listBuiltinTemplates: async () => catalogue }).client });
        const result = await client.callTool({ name: "list_document_templates", arguments: {} });
        assert.equal(result.isError, undefined, textOf(result));
        const fields = (result.structuredContent as { templates: { fields: { example: unknown }[] }[] }).templates[0]!.fields;
        assert.deepEqual(fields.map((field) => field.example), ["Jane Freeman", "Our free trial ends soon."]);
    });
});

describe("row field caps", () => {
    const capped = (maxChars: number, maxBytes: number) => normaliseCatalogue([{
        key: "letter", fields: [{ key: "body", max_chars: maxChars, max_bytes: maxBytes }],
    }], API_URL)[0]!;
    const letter = () => normaliseCatalogue(CATALOGUE, API_URL).find((t) => t.key === "letter")!;

    it("strips Python's whitespace set, not JavaScript's", () => {
        const all = "\t\n\v\f\r\x1c\x1d\x1e\x1f \x85\xa0        " +
            "        　";
        assert.equal(pythonStrip(`${all}x y${all}`), "x y");
        // U+FEFF stays (JS trim() would strip it); U+0085 and U+001C go (trim() keeps them).
        assert.equal(pythonStrip("﻿ x ﻿"), "﻿ x ﻿");
        assert.equal(pythonStrip("\x85\x1cx\x1f"), "x");
        assert.equal(pythonStrip("᠎​x"), "᠎​x");
        assert.equal(pythonStrip(" ".repeat(1_000_000) + "x" + " ".repeat(10)), "x");
    });

    it("counts code points, as Python's len() does", () => {
        assert.equal(pythonLength("😀"), 1);
        assert.equal(pythonLength("𠀀a😀"), 3);
        assert.equal(pythonLength("👩‍💻"), 3);
        assert.equal(pythonLength("\ud800x"), 2);
        assert.equal(pythonLength("x\udc00"), 2);
        assert.equal(pythonLength(""), 0);
    });

    it("counts emoji and astral characters as one character each, bounded by UTF-8 bytes", () => {
        const three = capped(3, 100);
        assert.equal(checkRows(three, [{ body: "😀😀😀" }]), undefined);
        assert.equal(checkRows(three, [{ body: "𠀀𠀁𠀂" }]), undefined);
        assert.match(checkRows(three, [{ body: "😀😀😀😀" }]) ?? "", /limit of 3 characters/);
        // Twelve bytes allow three emoji; a fourth passes the character cap but not the byte cap.
        const bytes = capped(100, 12);
        assert.equal(checkRows(bytes, [{ body: "😀😀😀" }]), undefined);
        assert.match(checkRows(bytes, [{ body: "😀😀😀😀" }]) ?? "", /or 12 UTF-8 bytes/);
        // The real letter body: 3,072 emoji are exactly 12,288 bytes.
        assert.equal(checkRows(letter(), [{ body: "😀".repeat(3072) }]), undefined);
        assert.match(checkRows(letter(), [{ body: "😀".repeat(3073) }]) ?? "", /field body:/);
        assert.equal(checkRows(letter(), [{ recipient_name: "😀".repeat(512) }]), undefined);
        assert.match(checkRows(letter(), [{ recipient_name: "😀".repeat(513) }]) ?? "", /field recipient_name:/);
    });

    it("counts U+FEFF, which Python's strip() keeps, and drops what it strips", () => {
        const three = capped(3, 100);
        assert.equal(checkRows(three, [{ body: "\x85abc\x1c" }]), undefined);
        assert.equal(checkRows(three, [{ body: " abc　" }]), undefined);
        assert.match(checkRows(three, [{ body: "﻿abc" }]) ?? "", /limit of 3 characters/);
        assert.match(checkRows(three, [{ body: "abc﻿" }]) ?? "", /limit of 3 characters/);
        // U+FEFF is three UTF-8 bytes.
        assert.equal(checkRows(capped(100, 3), [{ body: " ﻿ " }]), undefined);
        assert.match(checkRows(capped(100, 3), [{ body: "﻿a" }]) ?? "", /or 3 UTF-8 bytes/);
    });

    it("checks only the value the backend reads per field and ignores other keys", () => {
        assert.equal(checkRows(letter(), [{ body: "Hello", "BODY ": "x".repeat(5001) }]), undefined);
        assert.equal(checkRows(letter(), [{ body: "Hello", notes: "x".repeat(100_000) }]), undefined);
        assert.equal(checkRows(letter(), [{ "Recipient Name": "A", recipient_name: "B", "recipient-name": "x".repeat(2001) }]), undefined);
        // With no exact key, the first loose key wins and later ones are ignored.
        assert.match(checkRows(letter(), [{ Body: "x".repeat(5001), "BODY ": "ok" }]) ?? "", /field Body:/);
        assert.equal(checkRows(letter(), [{ "BODY ": "ok", Body: "x".repeat(5001) }]), undefined);
        assert.match(checkRows(letter(), [{ "Address Line 1": "x".repeat(2001) }]) ?? "", /field Address Line 1:/);
    });

    it("checks exact keys before loose keys, trims text and reports the first overlong row", () => {
        const template = normaliseCatalogue([{
            key: "letter",
            fields: [
                { key: "body", max_chars: 5000, max_bytes: 12288 },
                { key: "BODY ", max_chars: 2, max_bytes: 10 },
                { key: "sender_name", max_chars: 3, max_bytes: 10 },
            ],
        }], API_URL)[0]!;
        assert.equal(checkRows(template, [{
            body: ` \n${"x".repeat(5000)}\t `,
            "BODY ": " x ",
            "Sender-Name": " A ",
            extra: "x".repeat(2000),
            number: 10_000,
            boolean: true,
            empty: null,
        }]), undefined);
        assert.equal(checkRows(template, [{ "BODY ": "xxx" }]),
            "Row 1, field BODY : the text is longer than the limit of 2 characters or 10 UTF-8 bytes. Shorten it and try again.");
        assert.equal(checkRows(template, [{ body: "x" }, { "Sender-Name": "xxxx" }, { extra: "x".repeat(2001) }]),
            "Row 2, field Sender-Name: the text is longer than the limit of 3 characters or 10 UTF-8 bytes. Shorten it and try again.");
        assert.equal(checkRows(template, [{ extra: "x".repeat(2001) }]), undefined);
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
        // No sentence about the website's features: the text ends with the links.
        assert.ok(text.endsWith("Row 2, Grace Hopper: https://staging.sheetrender.test/api/previews/r_1/1.pdf"));
        assert.ok(!text.includes(ANON_TEXT.continueHow));
        assert.doesNotMatch(text, /Google Sheet|schedule|project|zip|email/i);
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
            arguments: { template: "letter", rows: [{ recipient_name: "x".repeat(2001), body: "x" }] },
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

    it("returns volume refusal messages verbatim as non-error render results", () => {
        for (const [status, message, used] of [
            ["volume_used", "This month's documents for this connection are used. The count resets on 2026-11-01.", 50],
            ["volume_short", "There are 2 documents left this month, fewer than the 3 rows sent. The count resets on 2026-11-01.", 48],
        ] as const) {
            const volume = { used, limit: 50, resets_at: "2026-11-01T00:00:00Z" };
            const result = buildRenderResult("letter", 3, { documents: [], status, message, volume }, API_URL);
            assert.equal(result.isError, false, status);
            assert.equal(textOf(result), message);
            assert.deepEqual(result.structuredContent, {
                template: "letter",
                template_name: "Letter",
                rows_received: 3,
                rows_rendered: 0,
                documents: [],
                expires_at: null,
                missing_fields: [],
                volume,
                continue: { guide_url: `${API_URL}/templates/mail-merge-letter`, how: ANON_TEXT.continueHow },
                status,
                message,
            });
            assert.doesNotMatch(textOf(result), BANNED_WORDS);
            assert.doesNotMatch(JSON.stringify(result.structuredContent), BANNED_WORDS);
        }
    });

    it("passes refusal and partial-render messages through the MCP client with valid structured output", async () => {
        for (const [status, message, used, documents] of [
            ["volume_used", "This month's documents for this connection are used. The count resets on 2026-11-01.", 50, []],
            ["volume_short", "There are 2 documents left this month, fewer than the 3 rows sent. The count resets on 2026-11-01.", 48, []],
            ["volume_short", "2 of the 3 rows were rendered. The remaining row was not rendered.", 50, RENDERED.documents!],
        ] as const) {
            const body: BuiltinRenderResult = {
                documents: [...documents], status, message,
                volume: { used, limit: 50, resets_at: "2026-11-01T00:00:00Z" },
            };
            const { client } = await connect({ client: fakeClient({ renderBuiltin: async () => body }).client });
            // listTools caches outputSchema validators in the SDK client.
            const tool = (await client.listTools()).tools.find((item) => item.name === "render_documents")!;
            assert.ok(tool.outputSchema);
            const result = await client.callTool({
                name: "render_documents", arguments: { template: "letter", rows: CERT_ROWS },
            });
            assert.ok(!result.isError, status);
            if (documents.length === 0) assert.equal(textOf(result), message);
            else assert.ok(textOf(result).startsWith(`${message}\nRendered 2 documents`));
            const structured = result.structuredContent as { message: string; status: string; rows_rendered: number };
            assert.equal(structured.message, message);
            assert.equal(structured.status, status);
            assert.equal(structured.rows_rendered, documents.length);
            assert.deepEqual(result.structuredContent, buildRenderResult("letter", CERT_ROWS.length, body, API_URL).structuredContent);
            assert.doesNotMatch(textOf(result), BANNED_WORDS);
            assert.doesNotMatch(JSON.stringify(result.structuredContent), BANNED_WORDS);
        }
    });

    it("includes the backend notice alongside partially rendered documents", () => {
        const message = "2 of the 3 rows were rendered. The remaining row was not rendered.";
        const expected = buildRenderResult("certificate", 3, RENDERED, API_URL);
        const result = buildRenderResult("certificate", 3, { ...RENDERED, status: "volume_short", message }, API_URL);
        assert.equal(result.isError, false);
        assert.deepEqual(result.structuredContent, { ...expected.structuredContent, status: "volume_short", message });
        assert.equal(textOf(result), `${message}\n${textOf(expected)}`);
    });

    it("preserves backend messages without trimming or truncating them, with and without documents", () => {
        const message = "  Some rows were not rendered.\n" + "More rows remain. ".repeat(40) + " \n";
        assert.ok(message.length > 500);
        for (const documents of [[], RENDERED.documents!]) {
            const result = buildRenderResult("certificate", 3, { ...RENDERED, documents, status: "volume_short", message }, API_URL);
            assert.equal(result.structuredContent!.message, message);
            if (documents.length === 0) assert.equal(textOf(result), message);
            else assert.ok(textOf(result).startsWith(`${message}\nRendered 2 documents`));
        }
    });

    it("enforces the UTF-8 cell cap on render and continue without truncating valid cells", async () => {
        const { client, calls } = await connect();
        for (const name of ["render_documents", "create_continue_link"]) {
            const tooLarge = await client.callTool({ name, arguments: { template: "letter", rows: [{ recipient_name: "😀".repeat(513) }] } });
            assert.equal(tooLarge.isError, true);
            const valid = await client.callTool({ name, arguments: { template: "letter", rows: [{ recipient_name: "😀".repeat(512) }] } });
            assert.equal(valid.isError, undefined);
        }
        assert.equal(calls.renders.length, 1);
        assert.equal(calls.handoffs.length, 1);
        assert.equal(calls.renders[0]![1].rows[0]!.recipient_name, "😀".repeat(512));
        assert.equal(calls.handoffs[0]!.rows[0]!.recipient_name, "😀".repeat(512));
    });

    it("accepts letter bodies at the character and UTF-8 byte limits on render and continue", async () => {
        const { client, calls } = await connect();
        const bodies = ["x".repeat(5000), "界".repeat(4096)];
        assert.equal(Buffer.byteLength(bodies[1]!, "utf8"), 12288);
        for (const name of ["render_documents", "create_continue_link"]) {
            for (const body of bodies) {
                const result = await client.callTool({
                    name, arguments: { template: "letter", rows: [{ recipient_name: "A", body }] },
                });
                assert.equal(result.isError, undefined, textOf(result));
            }
        }
        assert.deepEqual(calls.renders.map(([, input]) => input.rows[0]!.body), bodies);
        assert.deepEqual(calls.handoffs.map((input) => input.rows[0]!.body), bodies);
        assert.equal(calls.catalogue, 1);
    });

    it("refuses overlong letter bodies and other fields before rendering or continuing", async () => {
        const { client, calls } = await connect();
        for (const name of ["render_documents", "create_continue_link"]) {
            for (const [field, value, chars, bytes] of [
                ["body", "x".repeat(5001), 5000, 12288],
                ["body", "界".repeat(4097), 5000, 12288],
                ["recipient_name", "x".repeat(2001), 2000, 2048],
            ] as const) {
                const result = await client.callTool({ name, arguments: { template: "letter", rows: [{ [field]: value }] } });
                assert.equal(result.isError, true, `${name}: ${field}`);
                assert.equal(textOf(result),
                    `Row 1, field ${field}: the text is longer than the limit of ${chars} characters or ${bytes} UTF-8 bytes. Shorten it and try again.`);
                assert.doesNotMatch(JSON.stringify(result), BANNED_WORDS);
            }
        }
        assert.equal(calls.renders.length, 0);
        assert.equal(calls.handoffs.length, 0);
    });

    it("passes aliases and extra columns the backend ignores, whatever their length", async () => {
        const { client, calls } = await connect();
        const rows = [
            { body: "Hello", "BODY ": "x".repeat(5001) },
            { recipient_name: "A", body: "Hi", notes: "x".repeat(20_000) },
        ];
        for (const name of ["render_documents", "create_continue_link"]) {
            const result = await client.callTool({ name, arguments: { template: "letter", rows } });
            assert.equal(result.isError, undefined, textOf(result));
        }
        assert.deepEqual(calls.renders[0]![1].rows, rows);
        assert.deepEqual(calls.handoffs[0]!.rows, rows);
    });

    it("uses the body cap for loose keys and counts trimmed text without altering rows", async () => {
        const { client, calls } = await connect();
        const rows = [{ recipient_name: ` ${"x".repeat(2000)} `, "BODY ": `\n ${"x".repeat(5000)} \t` }];
        for (const name of ["render_documents", "create_continue_link"]) {
            const result = await client.callTool({ name, arguments: { template: "letter", rows } });
            assert.equal(result.isError, undefined, textOf(result));
            const tooLong = await client.callTool({
                name, arguments: { template: "letter", rows: [{ "BODY ": "x".repeat(5001) }] },
            });
            assert.equal(tooLong.isError, true);
            assert.match(textOf(tooLong), /limit of 5000 characters or 12288 UTF-8 bytes/);
        }
        assert.deepEqual(calls.renders.map(([, input]) => input.rows), [rows]);
        assert.deepEqual(calls.handoffs.map((input) => input.rows), [rows]);
    });

    it("passes long values to the backend when the catalogue cannot be loaded", async () => {
        let catalogueCalls = 0;
        const fake = fakeClient({ listBuiltinTemplates: async () => {
            catalogueCalls += 1;
            throw new SheetRenderError("Unavailable", 503);
        } });
        const { client } = await connect({ client: fake.client });
        const rows = [{ recipient_name: "x".repeat(2001), body: "x".repeat(5001) }];
        for (const name of ["render_documents", "create_continue_link"]) {
            const result = await client.callTool({ name, arguments: { template: "letter", rows } });
            assert.equal(result.isError, undefined, textOf(result));
        }
        assert.equal(catalogueCalls, 2);
        assert.deepEqual(fake.calls.renders.map(([, input]) => input.rows), [rows]);
        assert.deepEqual(fake.calls.handoffs.map((input) => input.rows), [rows]);
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

    it("maps both string and monthly document capacity 429 details to the busy text", () => {
        const message = "This month's documents for this connection are used. The count resets on 2026-11-01.";
        for (const detail of [message, { code: "monthly_capacity", kind: "documents", message }]) {
            const result = anonToolError(new SheetRenderError("Rendering documents failed (HTTP 429).", 429, detail), "Rendering documents");
            assert.equal(result.isError, true);
            assert.equal(textOf(result), ANON_TEXT.busy);
            assert.doesNotMatch(JSON.stringify(result), BANNED_WORDS);
        }
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
                createHandoff: async () => ({ token: "sr_live_secret", rows_saved: 1 }),
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
        const url = `${API_URL}/templates/certificate-of-completion?ref=chatgpt#handoff=tok_abc-123&rows=42`;
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

    it("preserves the backend continue URL and its saved row count", async () => {
        const url = `${API_URL}/templates/mail-merge-letter?ref=mcp#handoff=backend_token&rows=1`;
        const { client } = await connect({ client: fakeClient({
            createHandoff: async () => ({ token: "tok_abc-123", rows_saved: 1, continue_url: url }),
        }).client });
        const result = await client.callTool({
            name: "create_continue_link", arguments: { template: "letter", rows: [{ body: "A" }, { body: "B" }] },
        });
        assert.equal(result.isError, undefined, textOf(result));
        assert.deepEqual(result.structuredContent, { continue_url: url, expires_at: null, rows_saved: 1 });
        assert.equal(textOf(result), `Your 1 row is loaded on the template page: ${url}\nThe link expires in 7 days.`);
    });

    it("rebuilds absent or unsafe backend continue URLs using the backend's saved row count", async () => {
        const path = "/templates/mail-merge-letter";
        for (const continueUrl of [
            undefined,
            "not a URL",
            `https://evil.test${path}#handoff=bad`,
            `https://staging.sheetrender.test.evil.test${path}#handoff=bad`,
            `http://staging.sheetrender.test${path}#handoff=bad`,
            `https://user:pass@staging.sheetrender.test${path}#handoff=bad`,
            `${API_URL}/templates/donation-receipt#handoff=bad`,
            `${API_URL}${path}/extra#handoff=bad`,
            `${API_URL}/templates/../elsewhere#handoff=bad`,
            "javascript:alert(1)",
        ]) {
            const { client } = await connect({ client: fakeClient({
                createHandoff: async () => ({ token: "tok/a&b", rows_saved: 1, continue_url: continueUrl }),
            }).client });
            const result = await client.callTool({
                name: "create_continue_link", arguments: { template: "letter", rows: [{ body: "A" }, { body: "B" }] },
            });
            assert.equal(result.isError, undefined, textOf(result));
            const structured = result.structuredContent as Record<string, unknown>;
            assert.equal(structured.continue_url, `${API_URL}${path}?ref=mcp#handoff=tok%2Fa%26b&rows=1`);
            assert.equal(structured.rows_saved, 1);
        }
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
        const withoutTitle: HandoffInput = {
            template: "letter", rows, subject: `ip:${sha256("203.0.113.9")}`, source: "other",
        };
        // The complete envelope fits exactly; only the title crosses the cap.
        const gap = MAX_HANDOFF_BYTES - Buffer.byteLength(JSON.stringify(withoutTitle));
        rows[0]!.a += "z".repeat(gap);
        const title = "x".repeat(120);
        assert.ok(Buffer.byteLength(JSON.stringify(withoutTitle)) <= MAX_HANDOFF_BYTES);
        assert.ok(Buffer.byteLength(JSON.stringify({ ...withoutTitle, title })) > MAX_HANDOFF_BYTES);
        const accepted = await client.callTool({ name: "create_continue_link", arguments: { template: "letter", rows } });
        assert.equal(accepted.isError, undefined, textOf(accepted));
        const result = await client.callTool({ name: "create_continue_link", arguments: { template: "letter", rows, title } });
        assert.equal(result.isError, true);
        assert.match(textOf(result), /256 KB/);
        assert.equal(calls.handoffs.length, 1);
    });
});

describe("flood guard", () => {
    it("shares render and continue allowances across an IPv6 /64 and mapped IPv4 spellings", async () => {
        for (const [addresses, networks] of [
            [["2001:db8:1:2::1", "2001:0DB8:0001:0002:ffff:ffff:ffff:ffff", "2001:db8:1:3::1"],
                ["2001:db8:1:2::/64", "2001:db8:1:3::/64"]],
            [["198.51.100.7", "::ffff:198.51.100.7", "::ffff:c633:6407", "198.51.100.8"],
                ["198.51.100.7", "198.51.100.8"]],
        ]) {
            const limiter = new SlidingWindowLimiter(1, 3_600_000);
            const callers = await Promise.all(addresses.map((clientIp) => connect({ clientIp, limiter })));
            const render = (client: Client) => client.callTool({
                name: "render_documents", arguments: { template: "letter", rows: [{ body: "x" }] },
            });
            assert.equal((await render(callers[0]!.client)).isError, undefined);
            for (const caller of callers.slice(1, -1)) {
                const result = await caller.client.callTool({
                    name: "create_continue_link", arguments: { template: "letter", rows: [{ body: "x" }] },
                });
                assert.equal(result.isError, true);
                assert.equal(caller.calls.handoffs.length, 0);
            }
            assert.equal((await render(callers.at(-1)!.client)).isError, undefined);
            assert.deepEqual(callers.flatMap((caller) => caller.calls.renders.map(([, input]) => input.subject)),
                networks.map((network) => `ip:${sha256(network)}`));
            assert.equal(limiter.size, 2);
        }
    });

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
        // An `openai/subject` from Claude's network buys no separate budget,
        // even if the OpenAI list were misconfigured to cover that network.
        assert.equal((await call(a.client, "chatgpt-user")).isError, true);
        const misconfigured = await connect({
            limiter, claudeLimiter, clientIp: "160.79.104.1", openaiEgress: new CidrSet(["160.79.0.0/16"]),
        });
        assert.equal((await call(misconfigured.client, "fresh-user")).isError, true);
        assert.equal(limiter.size, 0);
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

    it("ignores a forged openai/subject from outside OpenAI's ranges", async () => {
        const limiter = new SlidingWindowLimiter(2, 3_600_000);
        const { client, calls } = await connect({ limiter, clientIp: "198.51.100.7" });
        const call = (subject: string) => client.callTool({
            name: "render_documents",
            arguments: { template: "letter", rows: [{ body: "x" }] },
            _meta: { "openai/subject": subject, "openai/locale": "en" },
        });
        // A fresh subject per call is still one caller: one IP, one bucket, one monthly subject.
        assert.equal((await call("fresh-1")).isError, undefined);
        assert.equal((await call("fresh-2")).isError, undefined);
        assert.equal((await call("fresh-3")).isError, true);
        assert.deepEqual(calls.renders.map(([, input]) => input.subject), [
            `ip:${sha256("198.51.100.7")}`,
            `ip:${sha256("198.51.100.7")}`,
        ]);
        assert.ok(calls.renders.every(([, input]) => input.source === "other" && !("pool" in input)));
        assert.equal(limiter.size, 1);
    });

    it("ignores every openai/subject when the OpenAI list is empty", async () => {
        const { client, calls } = await connect({ clientIp: "203.0.113.9", openaiEgress: new CidrSet([]) });
        await client.callTool({
            name: "render_documents",
            arguments: { template: "letter", rows: [{ body: "x" }] },
            _meta: { "openai/subject": "user-123" },
        });
        assert.equal(calls.renders[0]![1].subject, `ip:${sha256("203.0.113.9")}`);
        assert.equal(calls.renders[0]![1].source, "other");
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
        for (const ip of ["160.79.104.0", "160.79.111.255", "::ffff:160.79.105.2", "0:0:0:0:0:ffff:a04f:6902"]) assert.equal(isClaudeIp(ip), true, ip);
        for (const ip of ["160.79.103.255", "160.79.112.0", "160.79.104.999", "160.79.104.1.evil", "2001:db8::1"]) {
            assert.equal(isClaudeIp(ip), false, ip);
        }
    });
    it("requires verified identity to detect a source", () => {
        assert.equal(detectSource({ "openai/subject": "x" }, undefined), "other");
        assert.equal(detectSource(undefined, "openai-mcp/1.0"), "other");
        assert.equal(detectSource(undefined, "Claude-User/1.0"), "other");
        assert.equal(detectSource({ progressToken: 1 }, "curl/8"), "other");
        assert.equal(detectSource(undefined, "curl/8", "160.79.104.5"), "claude");
        assert.equal(detectSource({ "openai/subject": "x" }, undefined, "203.0.113.9", TEST_OPENAI_EGRESS), "chatgpt");
    });

    it("uses the backend's exact network spelling before hashing IP subjects", () => {
        for (const [address, network] of [
            ["198.51.100.7", "198.51.100.7"],
            ["::ffff:198.51.100.7", "198.51.100.7"],
            ["::FFFF:C633:6407", "198.51.100.7"],
            ["0:0:0:0:0:ffff:c633:6407", "198.51.100.7"],
            ["2001:db8:1:2:abcd:ef01:2345:6789", "2001:db8:1:2::/64"],
            ["2001:0DB8:0001:0002::1", "2001:db8:1:2::/64"],
            ["2001:db8:1:3::1", "2001:db8:1:3::/64"],
            ["2001:db8::1", "2001:db8::/64"],
            ["2001:0:0:1:ffff:ffff:ffff:ffff", "2001:0:0:1::/64"],
            ["::192.0.2.1", "::/64"],
            ["::1", "::/64"],
            ["::", "::/64"],
            ["fe80::1234%eth0", "fe80::/64"],
            ["not-an-ip", "not-an-ip"],
            ["", "unknown"],
        ]) {
            assert.equal(clientNetwork(address!), network, address);
            assert.equal(subjectKey(undefined, address!), `ip:${sha256(network!)}`, address);
        }
    });

    it("hashes a trusted subject and falls back to the hashed IP", () => {
        const egress = new CidrSet(["1.2.3.0/24"]);
        assert.equal(subjectKey({ "openai/subject": " s " }, "1.2.3.4", undefined, egress), `sub:${sha256("s")}`);
        assert.equal(subjectKey({ "openai/subject": " s " }, "::ffff:1.2.3.4", undefined, egress), `sub:${sha256("s")}`);
        assert.equal(subjectKey({ "openai/subject": " s " }, "::ffff:102:304", undefined, egress), `sub:${sha256("s")}`);
        assert.equal(subjectKey({ "openai/subject": "" }, "1.2.3.4", undefined, egress), `ip:${sha256("1.2.3.4")}`);
        assert.equal(subjectKey({ "openai/subject": 5 }, "1.2.3.4", undefined, egress), `ip:${sha256("1.2.3.4")}`);
        assert.equal(subjectKey(undefined, "1.2.3.4", undefined, egress), `ip:${sha256("1.2.3.4")}`);
        // Outside the list the subject is ignored.
        assert.equal(subjectKey({ "openai/subject": "s" }, "1.2.4.4", undefined, egress), `ip:${sha256("1.2.4.4")}`);
        assert.equal(subjectKey({ "openai/subject": "s" }, "", undefined, egress), `ip:${sha256("unknown")}`);
    });

    it("believes openai/subject by default only from OpenAI's published ranges", () => {
        assert.ok(OPENAI_EGRESS_CIDRS.length > 100);
        for (const cidr of OPENAI_EGRESS_CIDRS) assert.doesNotThrow(() => parseCidr(cidr), cidr);
        const meta = { "openai/subject": "user-123" };
        // 104.208.184.192/28 and 98.87.72.221/32 are in chatgpt-connectors.json.
        for (const ip of ["104.208.184.193", "104.208.184.207", "98.87.72.221", "::ffff:98.87.72.221"]) {
            assert.equal(trustedOpenaiSubject(meta, ip), "user-123", ip);
            assert.equal(subjectKey(meta, ip), `sub:${sha256("user-123")}`, ip);
        }
        for (const ip of ["104.208.184.208", "98.87.72.222", "203.0.113.9", "127.0.0.1", "160.79.104.5", "2001:db8::1"]) {
            assert.equal(trustedOpenaiSubject(meta, ip), undefined, ip);
            assert.equal(subjectKey(meta, ip), `ip:${sha256(ip === "2001:db8::1" ? "2001:db8::/64" : ip)}`, ip);
        }
    });

    it("matches IPv4 and IPv6 ranges and refuses malformed ones", () => {
        const set = new CidrSet(["2001:db8::/32", "192.0.2.0/24", "198.51.100.7/32"]);
        for (const ip of ["2001:db8::1", "2001:db8:ffff::1", "192.0.2.255", "::ffff:192.0.2.1", "198.51.100.7"]) {
            assert.equal(set.has(ip), true, ip);
        }
        for (const ip of ["2001:db9::1", "192.0.3.0", "198.51.100.8", "not-an-ip", "", "192.0.2.1.evil"]) {
            assert.equal(set.has(ip), false, ip);
        }
        for (const cidr of ["192.0.2.1", "192.0.2.0/33", "::/129", "x/8", "192.0.2.0/8/1", "192.0.2.0/-1", ""]) {
            assert.throws(() => parseCidr(cidr), /Not a CIDR range/, cidr);
        }
    });

    it("hashes a session for a Claude-range caller, whatever openai/subject it sends", () => {
        const sessionId = "private-session-123";
        assert.equal(subjectKey(undefined, "160.79.104.5", sessionId), `mcps:${sha256(sessionId)}`);
        assert.equal(subjectKey(undefined, "::ffff:160.79.104.5", sessionId), `mcps:${sha256(sessionId)}`);
        assert.equal(subjectKey({ "openai/subject": " " }, "160.79.104.5", sessionId), `mcps:${sha256(sessionId)}`);
        assert.equal(subjectKey({ "openai/subject": " user-123 " }, "160.79.104.5", sessionId), `mcps:${sha256(sessionId)}`);
        // Even with the Claude range wrongly listed as OpenAI's.
        assert.equal(
            subjectKey({ "openai/subject": "user-123" }, "160.79.104.5", sessionId, new CidrSet(["160.79.104.0/21"])),
            `mcps:${sha256(sessionId)}`,
        );
        assert.equal(subjectKey({ "openai/subject": "user-123" }, "160.79.104.5"), `ip:${sha256("160.79.104.5")}`);
        assert.equal(subjectKey(undefined, "160.79.104.5"), `ip:${sha256("160.79.104.5")}`);
        assert.equal(subjectKey(undefined, "160.79.104.5", ""), `ip:${sha256("160.79.104.5")}`);
        assert.equal(subjectKey(undefined, "203.0.113.9", sessionId), `ip:${sha256("203.0.113.9")}`);
    });

    it("treats every Claude-range call as Claude, whatever its _meta or User-Agent says", () => {
        assert.equal(callerSource(undefined, undefined, "160.79.104.5"), "claude");
        assert.equal(callerSource(undefined, "openai-mcp/1.0", "160.79.104.5"), "claude");
        assert.equal(callerSource({ "openai/subject": "user-123" }, "Claude-User", "160.79.104.5"), "claude");
        assert.equal(callerSource({ "openai/subject": "user-123" }, undefined, "203.0.113.9"), "other");
        assert.equal(callerSource(undefined, "Claude-User", "203.0.113.9"), "other");
        assert.equal(callerSource(undefined, undefined, "203.0.113.9"), "other");
    });

    it("labels ChatGPT only when the subject is trusted by the configured OpenAI ranges", () => {
        const meta = { "openai/subject": "user-123" };
        assert.equal(callerSource(meta, "Claude-User", "203.0.113.9", TEST_OPENAI_EGRESS), "chatgpt");
        assert.equal(callerSource(meta, "openai-mcp/1.0", "198.51.100.7", TEST_OPENAI_EGRESS), "other");
        assert.equal(callerSource(undefined, "ChatGPT", "203.0.113.9", TEST_OPENAI_EGRESS), "other");
        assert.equal(callerSource({ "openai/locale": "en" }, "ChatGPT", "203.0.113.9", TEST_OPENAI_EGRESS), "other");
        assert.equal(callerSource({ "openai/subject": " " }, "ChatGPT", "203.0.113.9", TEST_OPENAI_EGRESS), "other");
        assert.equal(callerSource(meta, undefined, "98.87.72.221"), "chatgpt");
        assert.equal(callerSource(meta, "ChatGPT", "98.87.72.221", new CidrSet([])), "other");
    });

    it("sends source other and no pool for a Claude User-Agent outside Claude's range", async () => {
        const { client: fake, calls } = fakeClient();
        const server = createAnonServer({
            client: fake, limiter: new SlidingWindowLimiter(30, 3_600_000), catalogue: new CatalogueCache(),
            clientIp: "198.51.100.7", sessionId: "forged-claude-session",
        });
        closers.push(() => server.close());
        // In-memory MCP transports have no HTTP headers; exercise the handlers directly.
        type Registered = { handler: (args: unknown, extra: unknown) => Promise<ToolResult> };
        const tools = (server as unknown as { _registeredTools: Record<string, Registered> })._registeredTools;
        for (const meta of [undefined, { "openai/subject": "forged-user", "source": "claude", "pool": "claude" }]) {
            for (const name of ["render_documents", "create_continue_link"]) {
                const result = await tools[name]!.handler(
                    { template: "letter", rows: [{ body: "x" }] },
                    { _meta: meta, requestInfo: { headers: { "user-agent": "Claude-User" } } },
                );
                assert.equal(result.isError, undefined, textOf(result));
                if (name === "create_continue_link") assert.match((result.structuredContent as Record<string, unknown>).continue_url as string, /\?ref=mcp#handoff=/);
            }
        }
        for (const input of [...calls.renders.map(([, input]) => input), ...calls.handoffs]) {
            assert.equal(input.source, "other");
            assert.equal(input.subject, `ip:${sha256("198.51.100.7")}`);
            assert.equal("pool" in input, false);
        }
        assert.equal(calls.renders.length, 2);
        assert.equal(calls.handoffs.length, 2);
    });

    it("uses the Claude session subject and source for both render and continue", async () => {
        const sessionId = "private-claude-session";
        const { client, calls } = await connect({ clientIp: "160.79.104.5", sessionId });
        const rows = [{ body: "x" }];
        // A Claude-range caller cannot leave the Claude pool by sending a ChatGPT subject.
        const forged = { "openai/subject": "forged-user" };
        const rendered = await client.callTool({ name: "render_documents", arguments: { template: "letter", rows }, _meta: forged });
        const continued = await client.callTool({ name: "create_continue_link", arguments: { template: "letter", rows }, _meta: forged });
        assert.equal(rendered.isError, undefined);
        assert.equal(continued.isError, undefined);
        assert.equal(calls.renders[0]![1].subject, `mcps:${sha256(sessionId)}`);
        assert.equal(calls.renders[0]![1].source, "claude");
        assert.equal(calls.renders[0]![1].pool, "claude");
        assert.equal(calls.handoffs[0]!.subject, `mcps:${sha256(sessionId)}`);
        assert.equal(calls.handoffs[0]!.source, "claude");
        assert.equal("pool" in calls.handoffs[0]!, false);
        assert.match((continued.structuredContent as { continue_url: string }).continue_url, /\?ref=claude#handoff=/);
        assert.ok(!JSON.stringify(calls).includes(sessionId));
        assert.ok(!JSON.stringify([rendered, continued]).includes(sessionId));
    });

    it("uses ref=claude for Claude's continue links", async () => {
        const { client: fake } = fakeClient();
        const server = createAnonServer({
            client: fake,
            limiter: new SlidingWindowLimiter(30, 3_600_000),
            catalogue: new CatalogueCache(),
            clientIp: "160.79.104.5",
        });
        closers.push(() => server.close());
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
            `${API_URL}/templates/donation-receipt?ref=claude#handoff=tok_abc-123&rows=1`,
        );
    });
});

describe("coarser flood buckets", () => {
    const render = (client: Client, meta?: Record<string, unknown>) => client.callTool({
        name: "render_documents", arguments: { template: "letter", rows: [{ body: "x" }] },
        ...(meta ? { _meta: meta } : {}),
    });

    it("groups addresses by IPv4 /24 and IPv6 /48, unwrapping mapped IPv4", () => {
        assert.equal(floodNetwork("198.51.100.7"), "198.51.100.0/24");
        assert.equal(floodNetwork("::ffff:198.51.100.200"), "198.51.100.0/24");
        assert.equal(floodNetwork("::ffff:c633:6407"), "198.51.100.0/24");
        assert.equal(floodNetwork("2001:db8:1:2::1"), "2001:db8:1::/48");
        assert.equal(floodNetwork("2001:0DB8:0001:ffff:ffff:ffff:ffff:ffff"), "2001:db8:1::/48");
        assert.equal(floodNetwork("2001:db8:2::1"), "2001:db8:2::/48");
        assert.equal(floodNetwork("::1"), "0:0:0::/48");
        assert.equal(floodNetwork(""), "unknown");
    });

    it("caps IP-counted callers per network as well as per address", async () => {
        const limiter = new SlidingWindowLimiter(30, 3_600_000);
        const networkLimiter = new SlidingWindowLimiter(2, 3_600_000);
        const a = await connect({ limiter, networkLimiter, clientIp: "198.51.100.1" });
        const b = await connect({ limiter, networkLimiter, clientIp: "198.51.100.2" });
        const c = await connect({ limiter, networkLimiter, clientIp: "198.51.100.3" });
        const elsewhere = await connect({ limiter, networkLimiter, clientIp: "198.51.101.1" });
        assert.equal((await render(a.client)).isError, undefined);
        assert.equal((await render(b.client)).isError, undefined);
        const refused = await render(c.client);
        assert.equal(refused.isError, true);
        assert.equal(textOf(refused), ANON_TEXT.tooManyNetworkCalls.replace("{minutes}", "60"));
        assert.equal(c.calls.renders.length, 0);
        // A refused call is counted in no bucket, so c's own address bucket is untouched.
        assert.equal(limiter.size, 2);
        assert.equal((await render(elsewhere.client)).isError, undefined);
        // IPv6: two /64s inside one /48 share the network bucket.
        const v6a = await connect({ limiter, networkLimiter, clientIp: "2001:db8:1:2::1" });
        const v6b = await connect({ limiter, networkLimiter, clientIp: "2001:db8:1:3::1" });
        const v6c = await connect({ limiter, networkLimiter, clientIp: "2001:db8:1:4::1" });
        assert.equal((await render(v6a.client)).isError, undefined);
        assert.equal((await render(v6b.client)).isError, undefined);
        assert.equal((await render(v6c.client)).isError, true);
    });

    it("does not apply the network bucket to trusted ChatGPT subjects or Claude's network", async () => {
        const limiter = new SlidingWindowLimiter(30, 3_600_000);
        const networkLimiter = new SlidingWindowLimiter(1, 3_600_000);
        const claudeLimiter = new SlidingWindowLimiter(100, 3_600_000, Date.now, 1);
        const chatgpt = await connect({ limiter, networkLimiter, clientIp: "203.0.113.9" });
        for (const subject of ["u1", "u2", "u3"]) {
            assert.equal((await render(chatgpt.client, { "openai/subject": subject })).isError, undefined);
        }
        const claude = await connect({ limiter, networkLimiter, claudeLimiter, clientIp: "160.79.104.1" });
        for (let i = 0; i < 3; i++) assert.equal((await render(claude.client)).isError, undefined);
        assert.equal(networkLimiter.size, 0);
    });

    it("gives each Claude session its own hourly bucket inside the shared Claude one", async () => {
        const limiter = new SlidingWindowLimiter(2, 3_600_000);
        const claudeLimiter = new SlidingWindowLimiter(3, 3_600_000, Date.now, 1);
        const one = await connect({ limiter, claudeLimiter, clientIp: "160.79.104.1", sessionId: "session-one" });
        const two = await connect({ limiter, claudeLimiter, clientIp: "160.79.104.2", sessionId: "session-two" });
        assert.equal((await render(one.client)).isError, undefined);
        assert.equal((await render(one.client)).isError, undefined);
        const own = await render(one.client);
        assert.equal(own.isError, true);
        assert.equal(textOf(own), ANON_TEXT.tooManyCalls.replace("{minutes}", "60"));
        // The refusal took nothing from the shared bucket: one more call fits.
        assert.equal((await render(two.client)).isError, undefined);
        const shared = await render(two.client);
        assert.equal(shared.isError, true);
        assert.equal(textOf(shared), ANON_TEXT.tooManySharedCalls.replace("{minutes}", "60"));
        assert.equal(limiter.size, 2);
        assert.ok(one.calls.renders.every(([, input]) => input.subject === `mcps:${sha256("session-one")}`));
    });
});

describe("line caps", () => {
    const letter = () => normaliseCatalogue(CATALOGUE, API_URL).find((t) => t.key === "letter")!;
    const lines = (count: number, separator = "\n") => Array.from({ length: count }, (_, i) => `line ${i}`).join(separator);

    it("counts lines as the backend folds them", () => {
        assert.equal(pythonLineCount(""), 1);
        assert.equal(pythonLineCount("a"), 1);
        assert.equal(pythonLineCount("a\nb"), 2);
        assert.equal(pythonLineCount("a\r\nb\rc"), 3);
        assert.equal(pythonLineCount("a b c\x85d\ve\ff"), 6);
        // Runs of blank or space-only lines fold to one blank line.
        assert.equal(pythonLineCount("a\n\n\n\nb"), 3);
        assert.equal(pythonLineCount("a\n \t\n\t\n  \nb"), 3);
        assert.equal(pythonLineCount("a\r\n\r\n\r\nb"), 3);
        // A line with other text in it is not blank.
        assert.equal(pythonLineCount("a\n.\n.\nb"), 4);
    });

    it("refuses a value over its line cap before rendering or continuing, and accepts one at it", async () => {
        const { client, calls } = await connect();
        for (const name of ["render_documents", "create_continue_link"]) {
            const over = await client.callTool({ name, arguments: { template: "letter", rows: [{ recipient_name: "A", body: lines(151) }] } });
            assert.equal(over.isError, true, name);
            assert.equal(textOf(over), "Row 1, field body: the text has more than 150 lines. Shorten it and try again.");
            // At the cap: plain, CRLF, and 75 paragraphs padded with blank
            // lines (296 raw breaks, 149 lines once folded).
            for (const body of [lines(150), lines(150, "\r\n"), lines(75, "\n\n\n\n")]) {
                const result = await client.callTool({ name, arguments: { template: "letter", rows: [{ recipient_name: "A", body }] } });
                assert.equal(result.isError, undefined, `${name}: ${textOf(result)}`);
            }
        }
        assert.equal(calls.renders.length, 3);
        assert.equal(calls.handoffs.length, 3);
    });

    it("folds blank-line padding away before counting, as the backend does", () => {
        const padded = Array.from({ length: 75 }, (_, i) => `p${i}`).join("\n \n\t\n\n");
        assert.equal(pythonLineCount(padded), 149);
        assert.equal(checkRows(letter(), [{ recipient_name: "A", body: padded }]), undefined);
        assert.match(checkRows(letter(), [{ recipient_name: "A", body: `${padded}\nx\ny` }])!, /more than 150 lines/);
    });

    it("keeps only positive integer line caps from the catalogue", () => {
        const templates = normaliseCatalogue([{
            key: "letter",
            fields: [{ key: "a", max_lines: 3 }, { key: "b", max_lines: 0 }, { key: "c", max_lines: "3" }, { key: "d" }],
        }] as unknown as BuiltinTemplate[], API_URL);
        assert.deepEqual(templates[0]!.fields.map((field) => field.max_lines), [3, undefined, undefined, undefined]);
        assert.equal("max_lines" in templates[0]!.fields[1]!, false);
        assert.equal(checkRows(templates[0]!, [{ a: "1\n2\n3" }]), undefined);
        assert.match(checkRows(templates[0]!, [{ d: "x", a: "1\n2\n3\n4" }])!, /^Row 1, field a: the text has more than 3 lines/);
    });
});

describe("backend refusals the model can act on", () => {
    const refusal = (detail: unknown, what = "Rendering documents") =>
        textOf(anonToolError(new SheetRenderError(`${what} failed (HTTP 422).`, 422, detail), what) as ToolResult);

    it("passes a 422's own message through", () => {
        assert.equal(refusal("Row 3, field 'body' has more than 150 lines"),
            "Rendering documents failed: Row 3, field 'body' has more than 150 lines");
        assert.equal(refusal("Field 'amount' has a number too large; send it as text", "Creating the continue link"),
            "Creating the continue link failed: Field 'amount' has a number too large; send it as text");
        assert.equal(refusal("None of the rows has a value for this template's fields: recipient_name, body"),
            "Rendering documents failed: None of the rows has a value for this template's fields: recipient_name, body");
    });

    it("cuts long messages, drops control characters and keeps validation lists generic", () => {
        const long = refusal(`Row 1, field 'body' ${"x".repeat(1000)}`);
        assert.equal(long.length, "Rendering documents failed: ".length + MAX_DETAIL_CHARS);
        assert.ok(long.endsWith("…"));
        assert.equal(refusal("Row 1,\n\tfield 'body'\u0000 is bad"), "Rendering documents failed: Row 1, field 'body' is bad");
        const generic = "Rendering documents failed: the rows were not accepted. Check them against the template's fields.";
        // FastAPI's validation list can name the caller's own column keys.
        assert.equal(refusal([{ loc: ["body", "rows", 0, "Ada Private"], msg: "bad" }]), generic);
        assert.equal(refusal(undefined), generic);
        assert.equal(refusal("   "), generic);
        assert.equal(refusal("<html>proxy error</html>"), generic);
        for (const leak of ["Authorization: Bearer x", "key sr_live_abc", "bad api_key", "token expired"]) {
            assert.equal(refusal(leak), generic, leak);
        }
        // Other statuses keep their fixed wording.
        const bad400 = anonToolError(new SheetRenderError("x", 400, "Invalid Content-Length"), "Rendering documents");
        assert.equal(textOf(bad400 as ToolResult), generic);
    });

    it("refuses to pass on a message that reflects the hosted credential", async () => {
        const { client } = await connect({
            demoApiKey: "xyzzy-demo-value",
            client: fakeClient({
                renderBuiltin: async () => {
                    throw new SheetRenderError("x", 422, "Row 1, field 'body' xyzzy-demo-value");
                },
            }).client,
        });
        const result = await client.callTool({ name: "render_documents", arguments: { template: "letter", rows: [{ body: "x" }] } });
        assert.equal(result.isError, true);
        assert.doesNotMatch(JSON.stringify(result), /xyzzy-demo-value/);
        assert.match(textOf(result), /failed on the SheetRender side/);
    });

    it("passes a 422 through the MCP client from both write tools", async () => {
        const { client } = await connect({
            client: fakeClient({
                renderBuiltin: async () => {
                    throw new SheetRenderError("x", 422, "Row 2, field 'date' is longer than 2000 characters");
                },
                createHandoff: async () => {
                    throw new SheetRenderError("x", 422, "At most 100 rows can be handed over");
                },
            }).client,
        });
        const rendered = await client.callTool({ name: "render_documents", arguments: { template: "letter", rows: [{ body: "x" }] } });
        assert.equal(textOf(rendered), "Rendering documents failed: Row 2, field 'date' is longer than 2000 characters");
        const linked = await client.callTool({ name: "create_continue_link", arguments: { template: "letter", rows: [{ body: "x" }] } });
        assert.equal(textOf(linked), "Creating the continue link failed: At most 100 rows can be handed over");
    });
});

describe("shared-limit volume", () => {
    const pool = (used: number, limit: number) => ({ used, limit, resets_at: "2026-11-01T00:00:00Z", scope: "pool" as const });

    it("never shows X of the pool's limit left, and says the limit is shared", () => {
        const message = "2 of the 3 rows were rendered. 1 did not fit in this month's volume, which is shared with other users. The count resets on 2026-11-01.";
        const result = buildRenderResult("certificate", 3, { ...RENDERED, status: "volume_short", message, volume: pool(10000, 10000) }, API_URL);
        const text = textOf(result as ToolResult);
        assert.ok(text.startsWith(`${message}\n`));
        assert.match(text, /This month's document limit is shared with other users; the count resets on 2026-11-01\./);
        assert.doesNotMatch(text, /\d+ of \d+ documents left/);
        assert.doesNotMatch(text, /10000|1000\b/);
        assert.deepEqual((result.structuredContent as { volume: unknown }).volume, pool(10000, 10000));
        assert.equal(result.isError, false);
    });

    it("words a shared refusal with no backend message without the pool's numbers", () => {
        const result = buildRenderResult("letter", 3, { documents: [], volume: pool(1000, 1000) }, API_URL);
        assert.equal(textOf(result as ToolResult),
            "No documents were rendered: this month's documents are used. The limit is shared with other users and resets on 2026-11-01.");
    });

    it("passes the backend's shared refusal through verbatim", async () => {
        const message = "This month's documents are used. The limit is shared with other users and resets on 2026-11-01.";
        const body: BuiltinRenderResult = { documents: [], status: "volume_used", message, volume: pool(1000, 1000) };
        const { client } = await connect({ client: fakeClient({ renderBuiltin: async () => body }).client });
        await client.listTools();
        const result = await client.callTool({ name: "render_documents", arguments: { template: "letter", rows: [{ body: "x" }] } });
        assert.ok(!result.isError);
        assert.equal(textOf(result), message);
        assert.deepEqual((result.structuredContent as { volume: unknown }).volume, pool(1000, 1000));
        assert.doesNotMatch(JSON.stringify(result), BANNED_WORDS);
    });

    it("keeps the per-user line for scope subject and for older backends", () => {
        for (const volume of [{ used: 12, limit: 50, resets_at: null, scope: "subject" as const }, { used: 12, limit: 50, resets_at: null }]) {
            const result = buildRenderResult("certificate", 3, { ...RENDERED, volume }, API_URL);
            assert.match(textOf(result as ToolResult), /38 of 50 documents left this month\./);
        }
    });
});

describe("view resource host", () => {
    it("decides the host by network address alone, since resources/read carries no subject", async () => {
        assert.equal(resourceHost("203.0.113.9", TEST_OPENAI_EGRESS), "chatgpt");
        assert.equal(resourceHost("160.79.104.1", new CidrSet(["160.79.0.0/16"])), "claude");
        assert.equal(resourceHost("198.51.100.7", TEST_OPENAI_EGRESS), "other");
        const publicUrl = "https://mcp.sheetrender.test/mcp";
        for (const [clientIp, domain] of [
            ["203.0.113.9", "https://mcp.sheetrender.test"],
            ["160.79.104.1", `${sha256(publicUrl).slice(0, 32)}.claudemcpcontent.com`],
            ["198.51.100.7", undefined],
        ] as const) {
            const { client } = await connect({ clientIp, publicUrl });
            const read = await client.readResource({ uri: "ui://sheetrender/documents.html" });
            const meta = (read.contents[0] as unknown as { _meta: { ui: { domain?: string }; "openai/widgetDomain"?: string } })._meta;
            assert.equal(meta.ui.domain, domain, clientIp);
            assert.equal(meta["openai/widgetDomain"], "https://mcp.sheetrender.test", clientIp);
        }
    });
});

describe("admission limiters", () => {
    it("checks room for several calls at once and says when it frees", () => {
        let now = 0;
        const limiter = new SlidingWindowLimiter(3, 1000, () => now);
        assert.equal(limiter.check("k", 3).allowed, true);
        limiter.takeMany("k", 2);
        now = 100;
        assert.deepEqual(limiter.check("k", 2), { allowed: false, retryAfterMs: 900 });
        assert.equal(limiter.check("k", 1).allowed, true);
        // More than the limit never fits: a whole window, never NaN.
        assert.deepEqual(new SlidingWindowLimiter(3, 1000, () => 0).check("x", 4), { allowed: false, retryAfterMs: 1000 });
    });

    it("counts requests in flight overall and per key, and releases each once", () => {
        const inFlight = new InFlightLimiter(2, 1);
        const first = inFlight.enter("a");
        assert.equal(typeof first, "function");
        assert.equal(inFlight.enter("a"), "key");
        const platform = inFlight.enter(undefined);
        assert.equal(typeof platform, "function");
        assert.equal(inFlight.enter("b"), "busy");
        (first as () => void)();
        (first as () => void)();
        assert.equal(inFlight.total, 1);
        assert.equal(typeof inFlight.enter("a"), "function");
    });
});
