/**
 * The anonymous tool set: what the hosted server offers a caller with no API
 * key, when it was started with SHEETRENDER_DEMO_API_KEY. This is the server
 * the ChatGPT and Claude directory listings point at.
 *
 * Three tools, all calling the SheetRender API with the demo key:
 *
 *   list_document_templates  GET  /api/v1/builtin-templates (cached for an hour)
 *   render_documents         POST /api/v1/builtin-templates/{key}/render
 *   create_continue_link     POST /api/v1/handoffs
 *
 * plus the MCP Apps view render_documents links to (widget-resource.ts).
 *
 * Input is rows of scalar cells only; the template HTML lives on the backend.
 * Nothing here calls a design (AI) endpoint. Each call is counted against the
 * caller's subject: ChatGPT's anonymised `openai/subject`, else the client IP.
 * The flood guard here (calls per hour) sits in front of the backend's own
 * per-subject monthly document volume, which is the real limit.
 *
 * Stdio and API-key callers never see any of this: http.ts only builds this
 * server for a request with no Authorization header, and only when a demo key
 * is configured.
 */

import { createHash } from "node:crypto";
import { isIP } from "node:net";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
    SheetRenderError,
    type BuiltinRenderResult,
    type BuiltinTemplate,
    type Cell,
    type DocumentVolume,
    type HandoffInput,
    type SheetRenderClient,
} from "./client.js";
import {
    ANON_TEXT,
    BANNED_WORDS,
    CONTINUE_ROW_LIMIT,
    RENDER_ROW_LIMIT,
    TEMPLATE_KEYS,
    TEMPLATE_NAMES,
    TEMPLATE_SLUGS,
    type TemplateKey,
} from "./anon-descriptions.js";
import { structuredResult } from "./format.js";
import { SERVER_VERSION } from "./index.js";
import {
    RESOURCE_MIME_TYPE,
    RESOURCE_URI_META_KEY,
    WIDGET_URI,
    widgetHtml,
    widgetResourceMeta,
} from "./widget-resource.js";

const SERVER_NAME = "sheetrender";

/** Largest cell, in characters: the catalogue's `limits.cell_max_chars`. */
export const MAX_CELL_CHARS = 2000;
/** UTF-8 byte bound on a text cell, matching the backend catalogue. */
export const MAX_CELL_BYTES = 2048;
/** Most columns a row may carry. The widest template has eight fields. */
export const MAX_ROW_KEYS = 50;
/** The handoff payload cap the backend enforces, checked here first. */
export const MAX_HANDOFF_BYTES = 256 * 1024;
/** Default flood guard: tool calls per subject per hour. */
export const DEFAULT_CALLS_PER_HOUR = 30;
/** Subjectless directory traffic shares one larger, isolated flood bucket. */
export const DEFAULT_CLAUDE_CALLS_PER_HOUR = 3000;
const HOUR_MS = 60 * 60 * 1000;
const CATALOGUE_TTL_MS = HOUR_MS;

// ---------------------------------------------------------------------------
// Caller identity
// ---------------------------------------------------------------------------

/** Which directory the call came from, as far as the request tells. */
export type Source = "chatgpt" | "claude" | "other";

type Meta = Record<string, unknown> | undefined;

/**
 * ChatGPT puts `openai/*` keys (subject, locale, userAgent, …) on every call's
 * `_meta`; Claude sends no such keys, so the User-Agent is the fallback for
 * both. guess: Claude's connector User-Agent contains "Claude" or "Anthropic".
 */
export function detectSource(meta: Meta, userAgent: string | undefined): Source {
    if (meta && Object.keys(meta).some((key) => key.startsWith("openai/"))) return "chatgpt";
    const ua = userAgent ?? "";
    if (/openai|chatgpt/i.test(ua)) return "chatgpt";
    if (/claude|anthropic/i.test(ua)) return "claude";
    return "other";
}

function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

/** ChatGPT's anonymised user id, when the call carries a usable one. */
export function openaiSubject(meta: Meta): string | undefined {
    const subject = meta?.["openai/subject"];
    if (typeof subject !== "string") return undefined;
    const trimmed = subject.trim();
    return trimmed && trimmed.length <= 512 ? trimmed : undefined;
}

/**
 * Who a call is counted against, as the backend receives it: the subject
 * hashed (`sub:<sha256>`), else the client IP hashed (`ip:<sha256>`). Neither
 * raw value leaves this process or reaches a log.
 */
export function subjectKey(meta: Meta, clientIp: string): string {
    const subject = openaiSubject(meta);
    return subject ? `sub:${sha256(subject)}` : `ip:${sha256(clientIp || "unknown")}`;
}

/** Short fingerprint of a subject for the request log. */
export function subjectFingerprint(subject: string): string {
    return sha256(subject).slice(0, 12);
}

/** Only the verified network address qualifies; a User-Agent cannot opt in. */
export function isClaudeIp(address: string): boolean {
    const v4 = address.toLowerCase().startsWith("::ffff:") ? address.slice(7) : address;
    if (isIP(v4) !== 4) return false;
    const [a, b, c] = v4.split(".").map(Number);
    return a === 160 && b === 79 && c !== undefined && c >= 104 && c <= 111;
}

// ---------------------------------------------------------------------------
// Flood guard
// ---------------------------------------------------------------------------

export interface LimitDecision {
    allowed: boolean;
    /** Milliseconds until the oldest counted call leaves the window. */
    retryAfterMs: number;
}

/**
 * Sliding-window call counter, in memory, per process. Bounded: past
 * `maxKeys` subjects, idle ones are dropped first, then the oldest.
 */
export class SlidingWindowLimiter {
    readonly #limit: number;
    readonly #windowMs: number;
    readonly #now: () => number;
    readonly #maxKeys: number;
    readonly #hits = new Map<string, number[]>();

    constructor(limit: number, windowMs: number, now: () => number = Date.now, maxKeys = 50_000) {
        this.#limit = limit;
        this.#windowMs = windowMs;
        this.#now = now;
        this.#maxKeys = maxKeys;
    }

    take(key: string): LimitDecision {
        const now = this.#now();
        const since = now - this.#windowMs;
        const hits = (this.#hits.get(key) ?? []).filter((at) => at > since);
        if (hits.length >= this.#limit) {
            this.#hits.set(key, hits);
            return { allowed: false, retryAfterMs: Math.max(0, hits[0]! + this.#windowMs - now) };
        }
        hits.push(now);
        // Re-inserted so Map order tracks recency for the eviction below.
        this.#hits.delete(key);
        this.#hits.set(key, hits);
        if (this.#hits.size > this.#maxKeys) this.#evict(since);
        return { allowed: true, retryAfterMs: 0 };
    }

    get size(): number {
        return this.#hits.size;
    }

    #evict(since: number): void {
        for (const [key, hits] of this.#hits) {
            if (hits[hits.length - 1]! <= since) this.#hits.delete(key);
        }
        for (const key of this.#hits.keys()) {
            if (this.#hits.size <= this.#maxKeys) break;
            this.#hits.delete(key);
        }
    }
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export interface CatalogueField {
    key: string;
    label: string;
    required: boolean;
    example: Cell;
    description: string;
}

export interface CatalogueTemplate {
    key: TemplateKey;
    name: string;
    description: string;
    page: string;
    orientation: string;
    guide_url: string;
    fields: CatalogueField[];
}

/** The built-in templates' public page on the API's own site. */
export function guideUrl(apiUrl: string, key: TemplateKey): string {
    return `${new URL(apiUrl).origin}/templates/${TEMPLATE_SLUGS[key]}`;
}

function isTemplateKey(value: unknown): value is TemplateKey {
    return typeof value === "string" && (TEMPLATE_KEYS as readonly string[]).includes(value);
}

function toCell(value: unknown): Cell {
    if (typeof value === "string") return value.slice(0, MAX_CELL_CHARS);
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    return null;
}

function catalogueText(value: unknown, fallback = ""): string {
    return typeof value === "string" && value ? value.slice(0, MAX_CELL_CHARS) : fallback;
}

/**
 * The backend catalogue, reduced to the four keys render_documents accepts,
 * in a fixed order, with the guide link built from the API's origin so
 * staging links point at staging.
 */
export function normaliseCatalogue(raw: BuiltinTemplate[], apiUrl: string): CatalogueTemplate[] {
    const byKey = new Map(raw.filter((item) => item && isTemplateKey(item.key)).map((item) => [item.key, item]));
    const templates: CatalogueTemplate[] = [];
    for (const key of TEMPLATE_KEYS) {
        const item = byKey.get(key);
        if (!item) continue;
        templates.push({
            key,
            name: catalogueText(item.name, TEMPLATE_NAMES[key]),
            description: catalogueText(item.description),
            page: item.page === "letter" ? "letter" : "A4",
            orientation: item.orientation === "landscape" ? "landscape" : "portrait",
            // Built here rather than taken from the catalogue, whose links
            // always name the production site: staging must link to staging.
            guide_url: guideUrl(apiUrl, key),
            fields: (Array.isArray(item.fields) ? item.fields : [])
                .filter((field) => field && typeof field.key === "string" && field.key.length > 0 && field.key.length <= 100)
                .slice(0, MAX_ROW_KEYS)
                .map((field) => ({
                    key: field.key,
                    label: catalogueText(field.label, field.key),
                    required: field.required === true,
                    example: toCell(field.example),
                    description: catalogueText(field.description),
                })),
        });
    }
    // Catalogue prose is authored by the backend, unlike the user's row data.
    // Reject a policy regression before it reaches either the model or view.
    if (BANNED_WORDS.test(JSON.stringify(templates))) {
        throw new SheetRenderError("Listing document templates failed: the catalogue could not be used.");
    }
    return templates;
}

/**
 * One-hour cache of the catalogue, shared by every request a process serves.
 * A failed refresh serves the stale copy rather than failing the call.
 */
export class CatalogueCache {
    readonly #ttlMs: number;
    readonly #now: () => number;
    #entry?: { at: number; apiUrl: string; templates: CatalogueTemplate[] };
    #inflight?: Promise<CatalogueTemplate[]>;

    constructor(ttlMs = CATALOGUE_TTL_MS, now: () => number = Date.now) {
        this.#ttlMs = ttlMs;
        this.#now = now;
    }

    async get(client: SheetRenderClient): Promise<CatalogueTemplate[]> {
        const entry = this.#entry;
        if (entry && entry.apiUrl === client.baseUrl && this.#now() - entry.at < this.#ttlMs) {
            return entry.templates;
        }
        this.#inflight ??= (async () => {
            try {
                const templates = normaliseCatalogue(await client.listBuiltinTemplates(), client.baseUrl);
                if (templates.length === 0) {
                    throw new SheetRenderError("Listing document templates failed: the catalogue is empty.");
                }
                this.#entry = { at: this.#now(), apiUrl: client.baseUrl, templates };
                return templates;
            } catch (error) {
                if (entry && entry.apiUrl === client.baseUrl) return entry.templates;
                throw error;
            } finally {
                this.#inflight = undefined;
            }
        })();
        return this.#inflight;
    }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const cellSchema = z.union([
    z.string().max(MAX_CELL_CHARS).refine((value) => Buffer.byteLength(value.trim(), "utf8") <= MAX_CELL_BYTES, {
        message: `A text cell may contain at most ${MAX_CELL_BYTES} UTF-8 bytes.`,
    }).describe(`Text, at most ${MAX_CELL_CHARS} characters and ${MAX_CELL_BYTES} UTF-8 bytes.`),
    z.number(), z.boolean(), z.null(),
]);

const rowSchema = z
    .record(z.string().min(1).max(100), cellSchema)
    .refine((row) => Object.keys(row).length <= MAX_ROW_KEYS, {
        message: `A row may have at most ${MAX_ROW_KEYS} fields.`,
    })
    .describe("One document's values, keyed by the template's field keys.");

const templateSchema = z
    .enum(TEMPLATE_KEYS)
    .describe("Template key from list_document_templates.");

const titleSchema = z
    .string()
    .max(120)
    .describe('Optional name for this set of documents, e.g. "Q3 volunteer certificates".')
    .optional();

const fieldOutput = z.object({
    key: z.string(),
    label: z.string(),
    required: z.boolean(),
    example: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    description: z.string(),
});

const listOutputShape = {
    templates: z.array(z.object({
        key: z.string(),
        name: z.string(),
        description: z.string(),
        page: z.string(),
        orientation: z.string(),
        guide_url: z.string(),
        fields: z.array(fieldOutput),
    })),
};

const volumeOutput = z.object({
    used: z.number(),
    limit: z.number(),
    resets_at: z.string().nullable(),
});

const renderOutputShape = {
    template: z.string(),
    template_name: z.string(),
    rows_received: z.number(),
    rows_rendered: z.number(),
    documents: z.array(z.object({
        row_index: z.number(),
        label: z.string().nullable(),
        preview_png_url: z.string().nullable(),
        pdf_url: z.string().nullable(),
    })),
    expires_at: z.string().nullable(),
    missing_fields: z.array(z.object({ row_index: z.number(), fields: z.array(z.string()) })),
    volume: volumeOutput.nullable(),
    continue: z.object({ guide_url: z.string(), how: z.string() }),
};

const continueOutputShape = {
    continue_url: z.string(),
    expires_at: z.string().nullable(),
    rows_saved: z.number(),
};

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

function errorResult(text: string): CallToolResult {
    return { content: [{ type: "text", text }], isError: true };
}

/**
 * Backend failures use local wording only. Upstream bodies and network causes
 * can contain credentials, row values or account copy, even on a 400/422.
 */
export function anonToolError(error: unknown, what: string): CallToolResult {
    if (error instanceof SheetRenderError) {
        const detail = error.detail;
        const accountCapacity = error.status === 403 && detail && typeof detail === "object" &&
            "code" in detail && detail.code === "plan_limit";
        if (error.status === 429 || accountCapacity) {
            return errorResult(what === "Creating the continue link" ? ANON_TEXT.continueBusy : ANON_TEXT.busy);
        }
        if (error.status === 400 || error.status === 422) {
            return errorResult(`${what} failed: the rows were not accepted. Check them against the template's fields.`);
        }
        if (error.status === 413) {
            return errorResult(`${what} failed: the data is too large. Send fewer rows or shorter values.`);
        }
    }
    return errorResult(`${what} failed on the SheetRender side. Try again shortly.`);
}

/** Preview/download URLs must stay on the API origin, without credentials. */
function absoluteUrl(raw: unknown, apiUrl: string): string | null {
    if (typeof raw !== "string" || !raw) return null;
    try {
        const url = new URL(raw, `${apiUrl}/`);
        return (url.protocol === "https:" || url.protocol === "http:") &&
                url.origin === new URL(apiUrl).origin && !url.username && !url.password &&
                url.pathname.startsWith("/api/previews/")
            ? url.href : null;
    } catch {
        return null;
    }
}

function readVolume(result: BuiltinRenderResult): DocumentVolume | null {
    const raw = result.volume ?? result.monthly_volume ?? result.daily_volume;
    if (!raw || typeof raw.used !== "number" || typeof raw.limit !== "number") return null;
    return { used: raw.used, limit: raw.limit, resets_at: typeof raw.resets_at === "string" ? raw.resets_at : null };
}

function isoDate(value: string | null): string | undefined {
    if (!value) return undefined;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
}

function plural(count: number, one: string, many: string): string {
    return `${count} ${count === 1 ? one : many}`;
}

/** structuredContent and model text for one render_documents call. */
export function buildRenderResult(
    key: TemplateKey,
    rowsReceived: number,
    result: BuiltinRenderResult,
    apiUrl: string,
): CallToolResult {
    const documents = (Array.isArray(result.documents) ? result.documents : []).map((doc, position) => ({
        row_index: Number.isInteger(doc.row_index) ? doc.row_index : position,
        label: typeof doc.label === "string" && doc.label ? doc.label : null,
        preview_png_url: absoluteUrl(doc.preview_png_url, apiUrl),
        pdf_url: absoluteUrl(doc.pdf_url, apiUrl),
    }));
    const missing = (Array.isArray(result.missing_fields) ? result.missing_fields : [])
        .filter((entry) => entry && Number.isInteger(entry.row_index) && Array.isArray(entry.fields))
        .map((entry) => ({ row_index: entry.row_index, fields: entry.fields.filter((f) => typeof f === "string") }));
    const volume = readVolume(result);
    const expiresAt = typeof result.expires_at === "string" ? result.expires_at : null;
    const guide = guideUrl(apiUrl, key);
    const name = TEMPLATE_NAMES[key];

    const structured = {
        template: key,
        template_name: name,
        rows_received: rowsReceived,
        rows_rendered: documents.length,
        documents,
        expires_at: expiresAt,
        missing_fields: missing,
        volume,
        continue: { guide_url: guide, how: ANON_TEXT.continueHow },
    };

    const resets = isoDate(volume?.resets_at ?? null);
    if (documents.length === 0 && volume && volume.used >= volume.limit) {
        return structuredResult(
            `No documents were rendered: this month's ${volume.limit} documents are used.` +
                (resets ? ` The count resets on ${resets}.` : ""),
            structured,
        );
    }

    const lines: string[] = [
        `Rendered ${plural(documents.length, "document", "documents")} from ` +
            `${plural(rowsReceived, "row", "rows")} with the ${name} template.`,
    ];
    if (missing.length > 0) {
        lines.push(
            "Rows missing required fields (counting from 1): " +
                missing.map((entry) => `row ${entry.row_index + 1} (${entry.fields.join(", ")})`).join(", ") + ".",
        );
    }
    if (volume) {
        lines.push(
            `${Math.max(0, volume.limit - volume.used)} of ${volume.limit} documents left this month` +
                (resets ? `; the count resets on ${resets}.` : "."),
        );
    }
    if (documents.length > 0) {
        lines.push(`PDF links${expiresAt ? ` (they expire at ${expiresAt})` : ""}:`);
        for (const doc of documents) {
            lines.push(`- Row ${doc.row_index + 1}${doc.label ? `, ${doc.label}` : ""}: ${doc.pdf_url ?? "(no link)"}`);
        }
    }
    lines.push(ANON_TEXT.continueHow);
    return structuredResult(lines.join("\n"), structured);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface AnonServerOptions {
    /** A client carrying the demo API key, one per HTTP request. */
    client: SheetRenderClient;
    /** Shared across requests: the flood guard. */
    limiter: SlidingWindowLimiter;
    /** Separate shared bucket for subjectless requests from Claude's network. */
    claudeLimiter?: SlidingWindowLimiter;
    /** Shared across requests: the catalogue cache. */
    catalogue: CatalogueCache;
    /** The caller's IP, the limiter key when there is no subject. */
    clientIp: string;
    /** The URL users paste for this server; sets the view's sandbox origin. */
    publicUrl?: string;
    /** Reject an upstream reply that reflects the hosted credential. */
    demoApiKey?: string;
}

const NOAUTH = [{ type: "noauth" }];

type RequestExtra = {
    _meta?: Record<string, unknown>;
    requestInfo?: { headers?: Record<string, string | string[] | undefined> };
};

function userAgentOf(extra: RequestExtra): string | undefined {
    const value = extra.requestInfo?.headers?.["user-agent"];
    return Array.isArray(value) ? value[0] : value;
}

/** The handoff page parameter that records where a signup came from. */
function refFor(source: Source): string {
    return source === "other" ? "mcp" : source;
}

/**
 * Builds the anonymous MCP server for one HTTP request.
 */
export function createAnonServer(options: AnonServerOptions): McpServer {
    const { client, limiter, claudeLimiter, catalogue, clientIp, publicUrl } = options;
    const apiUrl = client.baseUrl;
    const apiOrigin = new URL(apiUrl).origin;

    const server = new McpServer(
        { name: SERVER_NAME, version: SERVER_VERSION },
        { instructions: ANON_TEXT.instructions },
    );

    function safeResult(result: CallToolResult): CallToolResult {
        const secret = options.demoApiKey;
        if (secret) {
            const body = JSON.stringify(result);
            if (body.includes(secret) || body.includes(encodeURIComponent(secret))) {
                throw new SheetRenderError("The document service returned an unusable response.");
            }
        }
        return result;
    }

    /** The flood guard, or the result to return when the caller is over it. */
    function guard(extra: RequestExtra): CallToolResult | undefined {
        const shared = !openaiSubject(extra._meta) && isClaudeIp(clientIp) && claudeLimiter !== undefined;
        const decision = shared
            ? claudeLimiter.take("claude:160.79.104.0/21")
            : limiter.take(subjectKey(extra._meta, clientIp));
        if (decision.allowed) return undefined;
        const minutes = Math.max(1, Math.ceil(decision.retryAfterMs / 60_000));
        const message = shared ? ANON_TEXT.tooManySharedCalls : ANON_TEXT.tooManyCalls;
        return errorResult(message.replace("{minutes}", String(minutes)));
    }

    server.registerTool(
        "list_document_templates",
        {
            title: ANON_TEXT.listTitle,
            description: ANON_TEXT.list,
            inputSchema: {},
            outputSchema: listOutputShape,
            annotations: {
                title: ANON_TEXT.listTitle,
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            _meta: { securitySchemes: NOAUTH },
        },
        async () => {
            try {
                const templates = await catalogue.get(client);
                const text = templates.map((template) => {
                    const fields = template.fields.map((field) =>
                        `  - ${field.key}${field.required ? " (required)" : ""}` +
                        (field.description ? `: ${field.description}` : "")
                    );
                    return [
                        `${template.key}: ${template.name} (${template.page}, ${template.orientation}). ` +
                        template.description,
                        ...fields,
                        `  guide: ${template.guide_url}`,
                    ].join("\n").replace(/ +\n/g, "\n");
                }).join("\n\n");
                return safeResult(structuredResult(
                    `${plural(templates.length, "template", "templates")}:\n${text}`,
                    { templates },
                ));
            } catch (error) {
                return anonToolError(error, "Listing document templates");
            }
        },
    );

    server.registerTool(
        "render_documents",
        {
            title: ANON_TEXT.renderTitle,
            description: ANON_TEXT.render,
            inputSchema: {
                template: templateSchema,
                rows: z
                    .array(rowSchema)
                    .min(1)
                    .max(RENDER_ROW_LIMIT)
                    .describe(`One object per document, at most ${RENDER_ROW_LIMIT} per call.`),
                title: titleSchema,
            },
            outputSchema: renderOutputShape,
            annotations: {
                title: ANON_TEXT.renderTitle,
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
            },
            _meta: {
                ui: { resourceUri: WIDGET_URI },
                [RESOURCE_URI_META_KEY]: WIDGET_URI,
                "openai/outputTemplate": WIDGET_URI,
                "openai/toolInvocation/invoking": ANON_TEXT.invoking,
                "openai/toolInvocation/invoked": ANON_TEXT.invoked,
                securitySchemes: NOAUTH,
            },
        },
        async ({ template, rows, title }, extra) => {
            const limited = guard(extra);
            if (limited) return limited;
            try {
                const source = detectSource(extra._meta, userAgentOf(extra));
                const result = await client.renderBuiltin(template, {
                    rows: rows as Record<string, Cell>[],
                    title,
                    subject: subjectKey(extra._meta, clientIp),
                    source,
                });
                return safeResult(buildRenderResult(template, rows.length, result, apiUrl));
            } catch (error) {
                return anonToolError(error, "Rendering documents");
            }
        },
    );

    server.registerTool(
        "create_continue_link",
        {
            title: ANON_TEXT.continueTitle,
            description: ANON_TEXT.continue,
            inputSchema: {
                template: templateSchema,
                rows: z
                    .array(rowSchema)
                    .min(1)
                    .max(CONTINUE_ROW_LIMIT)
                    .describe(`The user's rows, keyed by field key, at most ${CONTINUE_ROW_LIMIT}.`),
                title: titleSchema,
            },
            outputSchema: continueOutputShape,
            annotations: {
                title: ANON_TEXT.continueTitle,
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
            },
            _meta: {
                ui: { visibility: ["model", "app"] },
                "openai/widgetAccessible": true,
                "openai/toolInvocation/invoking": ANON_TEXT.continueInvoking,
                "openai/toolInvocation/invoked": ANON_TEXT.continueInvoked,
                securitySchemes: NOAUTH,
            },
        },
        async ({ template, rows, title }, extra) => {
            const limited = guard(extra);
            if (limited) return limited;
            try {
                const source = detectSource(extra._meta, userAgentOf(extra));
                const input: HandoffInput = {
                    template,
                    rows: rows as Record<string, Cell>[],
                    title,
                    subject: subjectKey(extra._meta, clientIp),
                    source,
                };
                // The backend caps the whole body, including identity and title.
                if (Buffer.byteLength(JSON.stringify(input)) > MAX_HANDOFF_BYTES) {
                    return errorResult(
                        "The data is too large to keep (256 KB at most). Send fewer rows or shorter values.",
                    );
                }
                const handoff = await client.createHandoff(input);
                if (typeof handoff.token !== "string" || !handoff.token) {
                    throw new SheetRenderError("Creating the continue link failed: no token came back.");
                }
                // The token rides in the fragment, so it never reaches a
                // server log or a Referer header.
                const url = `${apiOrigin}/templates/${TEMPLATE_SLUGS[template]}` +
                    `?ref=${refFor(source)}#handoff=${encodeURIComponent(handoff.token)}`;
                const expiresAt = typeof handoff.expires_at === "string" ? handoff.expires_at : null;
                return safeResult(structuredResult(
                    `Your ${plural(rows.length, "row is", "rows are")} loaded on the template page: ${url}\n` +
                        "The link expires in 7 days.",
                    { continue_url: url, expires_at: expiresAt, rows_saved: rows.length },
                ));
            } catch (error) {
                return anonToolError(error, "Creating the continue link");
            }
        },
    );

    server.registerResource(
        "documents-view",
        WIDGET_URI,
        {
            title: "Rendered documents",
            description: "Preview strip for render_documents.",
            mimeType: RESOURCE_MIME_TYPE,
            _meta: widgetResourceMeta({ apiOrigin, publicUrl, host: "other" }),
        },
        async (uri, extra) => {
            const host = detectSource(extra._meta as Meta, userAgentOf(extra as RequestExtra));
            return {
                contents: [{
                    uri: uri.href,
                    mimeType: RESOURCE_MIME_TYPE,
                    text: widgetHtml(apiOrigin),
                    _meta: widgetResourceMeta({ apiOrigin, publicUrl, host }),
                }],
            };
        },
    );

    exposeSecuritySchemes(server);
    return server;
}

/**
 * Copies each tool's `_meta.securitySchemes` to the top-level
 * `securitySchemes` field in tools/list, where ChatGPT documents it. The SDK's
 * registerTool has no such option, so the list handler it installed is
 * wrapped. If the SDK's internals move, the copy in `_meta` still stands.
 */
function exposeSecuritySchemes(server: McpServer): void {
    type Handler = (request: unknown, extra: unknown) => unknown;
    const handlers = (server.server as unknown as { _requestHandlers?: Map<string, Handler> })._requestHandlers;
    const original = handlers?.get("tools/list");
    if (!handlers || !original) return;
    handlers.set("tools/list", async (request, extra) => {
        const result = await original(request, extra) as { tools?: Record<string, unknown>[] };
        for (const tool of result.tools ?? []) {
            const schemes = (tool._meta as Record<string, unknown> | undefined)?.securitySchemes;
            if (schemes) tool.securitySchemes = schemes;
        }
        return result;
    });
}
