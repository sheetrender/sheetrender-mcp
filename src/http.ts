#!/usr/bin/env node
/**
 * SheetRender MCP server over Streamable HTTP — the hosted endpoint at
 * https://mcp.sheetrender.com/mcp.
 *
 * Multi-tenant and stateless: every request carries the caller's SheetRender
 * API key as `Authorization: Bearer sr_...`, and every request gets its own
 * `SheetRenderClient`, `McpServer` and transport, torn down when the response
 * ends. Nothing about one caller survives into the next request, so a key can
 * never leak across tenants and any replica can answer any request. The cost
 * is re-registering the tools on every request, which is microseconds.
 *
 * With SHEETRENDER_DEMO_API_KEY set, a request with no Authorization header
 * at all gets the anonymous tool set instead (anon.ts): three tools that fill
 * the built-in templates through the demo account. That is what the ChatGPT
 * and Claude directory listings connect to. A request that does send a key
 * gets exactly the API-key tools, as before. An anonymous `initialize` is
 * answered with a random `Mcp-Session-Id`; no session is kept behind it, and
 * a later request that sends it (a Claude caller) is counted by its hash.
 *
 * The stdio server in index.ts is untouched by this file.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer as createNodeServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import {
    callerSource,
    CatalogueCache,
    CidrSet,
    createAnonServer,
    DEFAULT_CALLS_PER_HOUR,
    DEFAULT_CLAUDE_CALLS_PER_HOUR,
    DEFAULT_MAX_IN_FLIGHT,
    DEFAULT_NETWORK_CALLS_PER_HOUR,
    DEFAULT_NETWORK_MAX_IN_FLIGHT,
    DEFAULT_RPC_PER_HOUR,
    floodNetwork,
    InFlightLimiter,
    isClaudeIp,
    MAX_ANON_BATCH,
    MAX_ANON_BODY_BYTES,
    OPENAI_EGRESS_CIDRS,
    openaiSubject,
    parseCidr,
    SlidingWindowLimiter,
    subjectFingerprint,
    trustedOpenaiSubject,
} from "./anon.js";
import { ANON_TEXT } from "./anon-descriptions.js";
import { DEFAULT_API_URL, parseApiUrl, SheetRenderClient, SheetRenderError } from "./client.js";
import { createServer, runningAsExecutable, SERVER_VERSION } from "./index.js";
import { startOpenaiEgressRefresh } from "./openai-egress.js";
import { loadWidgetBundle } from "./widget-resource.js";

const DEFAULT_PORT = 8080;
const DEFAULT_HOST = "0.0.0.0";
/**
 * Request body cap. `render_pdf` carries up to 2 MB of HTML and
 * `create_dataset` up to 50,000 JSON rows; 25 MB matches the proxy in front of
 * the hosted deployment, so the two limits never disagree about a request.
 */
const DEFAULT_MAX_BODY_BYTES = 25 * 1024 * 1024;
/** Socket inactivity timeout. The transport's SSE keep-alive (15 s) resets it. */
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
/** The MCP-Protocol-Version header is logged as sent, cut to this length. */
const MAX_LOGGED_HEADER_CHARS = 40;
/**
 * Most messages a JSON-RPC batch may carry from an API key the SheetRender API
 * has accepted. MCP removed batching in protocol version 2025-06-18 and the
 * official SDK clients send one message per POST; a 2025-03-26 client could
 * batch a few responses and notifications together. Twenty is ample for that
 * while keeping a 25 MB body from dispatching thousands of messages. Anonymous
 * requests and keys not yet accepted get MAX_ANON_BATCH.
 */
export const MAX_KEYED_BATCH = 20;
/**
 * How long a key the API accepted keeps the API-key limits, renewed by every
 * accepted call. Only the limits ride on this: every tool call still sends
 * the key to the API, so a key revoked meanwhile is refused there at once.
 */
const VERIFIED_KEY_TTL_MS = 60 * 60 * 1000;
/** Most accepted keys remembered at once; the least recently accepted go first. */
const MAX_VERIFIED_KEYS = 10_000;

export interface HttpServerOptions {
    /** SheetRender API base URL every per-request client talks to. */
    apiUrl: string;
    /** Largest request body accepted, in bytes. */
    maxBodyBytes?: number;
    /** Socket inactivity timeout, in milliseconds. */
    idleTimeoutMs?: number;
    /** Receives one structured entry per request and per error. */
    log?: (entry: LogEntry) => void;
    /**
     * The demo account's API key. When set, requests without an Authorization
     * header get the anonymous tools; when unset they get a 401, as before.
     */
    demoApiKey?: string;
    /** The URL users paste for this server, e.g. https://mcp.sheetrender.com/mcp. */
    publicUrl?: string;
    /** Served at /.well-known/openai-apps-challenge for OpenAI's domain check. */
    openaiAppsChallenge?: string;
    /** Anonymous flood guard: tool calls per subject per hour. */
    anonCallsPerHour?: number;
    /** Shared hourly budget for all traffic from 160.79.104.0/21. */
    claudeCallsPerHour?: number;
    /** Anonymous flood guard for callers counted by IP: calls per IPv4 /24 or IPv6 /48 per hour. */
    anonNetworkCallsPerHour?: number;
    /**
     * Anonymous JSON-RPC messages other than tool calls (initialize,
     * tools/list, resources/read, ...) per IPv4 /24 or IPv6 /48 per hour,
     * plus every message sent with a key the API has not yet accepted.
     * ChatGPT's and Claude's egress addresses are not counted here.
     */
    anonRpcPerHour?: number;
    /** Requests being answered at once, across all callers, keyed ones included. */
    anonMaxInFlight?: number;
    /** Anonymous and not-yet-accepted-key requests being answered at once per IPv4 /24 or IPv6 /48. */
    anonNetworkMaxInFlight?: number;
    /** Ranges whose `openai/subject` is believed; OpenAI's published list by default. */
    openaiEgressCidrs?: readonly string[];
    /**
     * The set itself, when something else keeps it current (main() refreshes
     * it from OpenAI's live list). Takes precedence over `openaiEgressCidrs`.
     */
    openaiEgress?: CidrSet;
    /** Clock for the flood guard and catalogue cache; tests replace it. */
    now?: () => number;
}

export type LogEntry = Record<string, unknown> & { level: "info" | "warn" | "error"; msg: string };

export interface HttpConfig {
    port: number;
    host: string;
    apiUrl: string;
    maxBodyBytes: number;
    idleTimeoutMs: number;
    demoApiKey?: string;
    publicUrl?: string;
    openaiAppsChallenge?: string;
    anonCallsPerHour: number;
    claudeCallsPerHour: number;
    anonNetworkCallsPerHour: number;
    anonRpcPerHour: number;
    anonMaxInFlight: number;
    anonNetworkMaxInFlight: number;
    openaiEgressCidrs: readonly string[];
    /** True when OPENAI_EGRESS_CIDRS set the list; the live refresh is then off. */
    openaiEgressFromEnv: boolean;
}

/** Reads the hosted server's configuration from the environment. */
export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
    const port = readInteger(env, "PORT", DEFAULT_PORT, 1, 65535);
    const host = env.HOST?.trim() || DEFAULT_HOST;
    return {
        port,
        host,
        apiUrl: parseApiUrl(env.SHEETRENDER_API_URL?.trim() || DEFAULT_API_URL),
        maxBodyBytes: readInteger(env, "MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES, 1024),
        idleTimeoutMs: readInteger(env, "IDLE_TIMEOUT_MS", DEFAULT_IDLE_TIMEOUT_MS, 1000),
        demoApiKey: readDemoKey(env),
        publicUrl: readPublicUrl(env),
        openaiAppsChallenge: env.OPENAI_APPS_CHALLENGE?.trim() || undefined,
        anonCallsPerHour: readInteger(env, "ANON_CALLS_PER_HOUR", DEFAULT_CALLS_PER_HOUR, 1),
        claudeCallsPerHour: readInteger(env, "CLAUDE_CALLS_PER_HOUR", DEFAULT_CLAUDE_CALLS_PER_HOUR, 1),
        anonNetworkCallsPerHour: readInteger(env, "ANON_NETWORK_CALLS_PER_HOUR", DEFAULT_NETWORK_CALLS_PER_HOUR, 1),
        anonRpcPerHour: readInteger(env, "ANON_RPC_PER_HOUR", DEFAULT_RPC_PER_HOUR, 1),
        anonMaxInFlight: readInteger(env, "ANON_MAX_IN_FLIGHT", DEFAULT_MAX_IN_FLIGHT, 1),
        anonNetworkMaxInFlight: readInteger(env, "ANON_NETWORK_MAX_IN_FLIGHT", DEFAULT_NETWORK_MAX_IN_FLIGHT, 1),
        openaiEgressCidrs: readCidrs(env, "OPENAI_EGRESS_CIDRS", OPENAI_EGRESS_CIDRS),
        openaiEgressFromEnv: Boolean(env.OPENAI_EGRESS_CIDRS?.trim()),
    };
}

/**
 * A comma- or space-separated CIDR list replacing `fallback`; `none` empties
 * it. OPENAI_EGRESS_CIDRS tracks https://openai.com/chatgpt-connectors.json
 * between releases; with it set to `none` no `openai/subject` is believed.
 */
function readCidrs(env: NodeJS.ProcessEnv, name: string, fallback: readonly string[]): readonly string[] {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    if (raw.toLowerCase() === "none") return [];
    const cidrs = raw.split(/[\s,]+/).filter(Boolean);
    for (const cidr of cidrs) {
        try {
            parseCidr(cidr);
        } catch {
            throw new SheetRenderError(`${name} must list CIDR ranges, got ${cidr.slice(0, 100)}`);
        }
    }
    return cidrs;
}

function readDemoKey(env: NodeJS.ProcessEnv): string | undefined {
    const key = env.SHEETRENDER_DEMO_API_KEY?.trim();
    if (!key) return undefined;
    if (!key.startsWith(API_KEY_PREFIX)) {
        throw new SheetRenderError("SHEETRENDER_DEMO_API_KEY must be a SheetRender API key (sr_...)");
    }
    return key;
}

/**
 * MCP_PUBLIC_URL has to be byte for byte the URL users paste: Claude hashes it
 * into the view's sandbox origin. It is validated, not normalised.
 */
function readPublicUrl(env: NodeJS.ProcessEnv): string | undefined {
    const raw = env.MCP_PUBLIC_URL?.trim();
    if (!raw) return undefined;
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new SheetRenderError(`MCP_PUBLIC_URL is not a valid URL: ${raw}`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new SheetRenderError(`MCP_PUBLIC_URL must be an http(s) URL, got ${raw}`);
    }
    return raw;
}

function readInteger(
    env: NodeJS.ProcessEnv,
    name: string,
    fallback: number,
    min: number,
    max = Number.MAX_SAFE_INTEGER,
): number {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new SheetRenderError(`${name} must be an integer between ${min} and ${max}, got ${raw}`);
    }
    return value;
}

/** Default logger: one JSON object per line on stdout. */
export function logJson(entry: LogEntry): void {
    process.stdout.write(JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n");
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

class BodyTooLarge extends Error {}

/** Reads the whole body, failing fast once it passes `limit` bytes. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const declared = Number(req.headers["content-length"]);
        if (Number.isFinite(declared) && declared > limit) {
            reject(new BodyTooLarge());
            return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        const onData = (chunk: Buffer) => {
            received += chunk.length;
            if (received > limit) {
                // Stop reading but leave the socket alone: req.destroy() here
                // would reset the connection before the 413 could be written.
                // The 413 carries `Connection: close`, which ends the upload.
                req.off("data", onData);
                req.pause();
                reject(new BodyTooLarge());
                return;
            }
            chunks.push(chunk);
        };
        req.on("data", onData);
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(body));
}

function sendRpcError(
    res: ServerResponse,
    status: number,
    code: number,
    message: string,
    headers: Record<string, string> = {},
): void {
    sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null }, headers);
}

/** Every SheetRender API key starts with this, e.g. `sr_live_...`. */
const API_KEY_PREFIX = "sr_";

/** The bearer token from an Authorization header, or undefined when absent. */
export function bearerToken(header: string | string[] | undefined): string | undefined {
    if (typeof header !== "string") return undefined;
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
    return match?.[1];
}

/**
 * A stable, non-reversible handle on an API key for the request log. Twelve
 * hex characters are enough to tell tenants apart while leaving the key itself
 * unrecoverable from the logs.
 */
export function keyFingerprint(key: string): string {
    return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

/** The JSON-RPC method and tool name a request body carries, for the log. */
function describeRpc(body: unknown): { rpc?: string; tool?: string } {
    const first = Array.isArray(body) ? body[0] : body;
    if (!first || typeof first !== "object") return {};
    const message = first as { method?: unknown; params?: { name?: unknown } };
    const rpc = typeof message.method === "string" ? message.method : undefined;
    const tool = rpc === "tools/call" && typeof message.params?.name === "string"
        ? message.params.name
        : undefined;
    return { rpc, tool };
}

/**
 * The anonymous call's log fields: a subject fingerprint, the detected source
 * and the row count. Never the subject itself and never a row.
 */
function describeAnonCall(
    body: unknown,
    userAgent: string | undefined,
    ip: string,
    openaiEgress: CidrSet,
): Record<string, unknown> {
    const first = Array.isArray(body) ? body[0] : body;
    if (!first || typeof first !== "object") return {};
    const params = (first as { params?: { _meta?: unknown; arguments?: { rows?: unknown } } }).params;
    const meta = params?._meta && typeof params._meta === "object"
        ? params._meta as Record<string, unknown>
        : undefined;
    const fields: Record<string, unknown> = { source: callerSource(meta, userAgent, ip, openaiEgress) };
    const subject = trustedOpenaiSubject(meta, ip, openaiEgress);
    if (subject) fields.subject_fp = subjectFingerprint(subject);
    // A subject from outside OpenAI's ranges is ignored. Logged so a stale
    // list shows up as ChatGPT traffic counted by IP.
    else if (openaiSubject(meta)) fields.subject_untrusted = true;
    const rows = params?.arguments?.rows;
    if (Array.isArray(rows)) fields.rows = rows.length;
    return fields;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Counts anonymous calls that carried an `openai/subject` from outside the
 * trusted OpenAI ranges, and logs the count at most once an hour. A steady
 * count is the sign of a stale list: ChatGPT traffic from a new egress
 * address, counted by IP. The first one after a quiet hour logs at once.
 */
export class UntrustedSubjectTally {
    readonly #log: (entry: LogEntry) => void;
    readonly #now: () => number;
    #count = 0;
    #loggedAt = -Infinity;

    constructor(log: (entry: LogEntry) => void, now: () => number = Date.now) {
        this.#log = log;
        this.#now = now;
    }

    note(): void {
        this.#count++;
        this.flush();
    }

    /** Logs the count if there is one and the last summary is an hour old. */
    flush(): void {
        const now = this.#now();
        if (this.#count === 0 || now - this.#loggedAt < HOUR_MS) return;
        this.#log({
            level: "warn",
            msg: "openai/subject from outside the OpenAI ranges",
            count: this.#count,
            hint: "if steady, OpenAI's egress list may be stale; those calls are counted by IP",
        });
        this.#count = 0;
        this.#loggedAt = now;
    }
}

/**
 * API keys the SheetRender API recently answered a 2xx for, held as SHA-256
 * hashes, never the key. Starting with `sr_` proves nothing, so until a key is
 * in here its requests get the anonymous bounds (batch, body size, in-flight,
 * messages per network); only the API can say a key is real, and it does so
 * on the first tool call that succeeds.
 */
export class VerifiedKeys {
    readonly #ttlMs: number;
    readonly #maxKeys: number;
    readonly #now: () => number;
    /** Hash -> expiry. Map order tracks recency for eviction. */
    readonly #until = new Map<string, number>();

    constructor(ttlMs = VERIFIED_KEY_TTL_MS, maxKeys = MAX_VERIFIED_KEYS, now: () => number = Date.now) {
        this.#ttlMs = ttlMs;
        this.#maxKeys = maxKeys;
        this.#now = now;
    }

    has(key: string): boolean {
        const hash = hashKey(key);
        const until = this.#until.get(hash);
        if (until === undefined) return false;
        if (until > this.#now()) return true;
        this.#until.delete(hash);
        return false;
    }

    add(key: string): void {
        const hash = hashKey(key);
        this.#until.delete(hash);
        this.#until.set(hash, this.#now() + this.#ttlMs);
        for (const oldest of this.#until.keys()) {
            if (this.#until.size <= this.#maxKeys) break;
            this.#until.delete(oldest);
        }
    }

    get size(): number {
        return this.#until.size;
    }
}

function hashKey(key: string): string {
    return createHash("sha256").update(key).digest("hex");
}

/**
 * A fresh `Mcp-Session-Id`: 256 random bits. Nothing is stored against it, so
 * any instance can serve the conversation it names.
 */
export function newSessionId(): string {
    return randomBytes(32).toString("hex");
}

/** True when a request body (one message or a batch) is, or contains, `initialize`. */
function isInitialize(body: unknown): boolean {
    return (Array.isArray(body) ? body : [body]).some((message) =>
        Boolean(message) && typeof message === "object" && (message as { method?: unknown }).method === "initialize"
    );
}

/** The session id a request carries, if it is a usable header value. */
function sessionIdOf(req: IncomingMessage): string | undefined {
    const value = req.headers["mcp-session-id"];
    return typeof value === "string" && /^[\x21-\x7e]{1,256}$/.test(value) ? value : undefined;
}

const PRIVATE_V4 = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/;

/** True for a peer address that can only be a proxy on our own network. */
function isPrivateAddress(address: string): boolean {
    const v4 = address.toLowerCase().startsWith("::ffff:") ? address.slice(7) : address;
    if (isIP(v4) === 4) return PRIVATE_V4.test(v4);
    return isIP(address) === 6 && (address === "::1" || /^f[cd]/i.test(address) || /^fe[89ab]/i.test(address));
}

/**
 * The caller's IP. The socket peer, unless the peer is a private address (the
 * reverse proxy in front of the container), in which case the right-most
 * X-Forwarded-For entry — the one that proxy appended — is the caller.
 * Entries further left are client-supplied and ignored.
 */
export function clientIp(req: IncomingMessage): string {
    const peer = req.socket.remoteAddress ?? "";
    if (!isPrivateAddress(peer)) return peer;
    const header = req.headers["x-forwarded-for"];
    const value = Array.isArray(header) ? header[header.length - 1] : header;
    const last = value?.split(",").pop()?.trim();
    // Do not fall back to an earlier, caller-supplied entry when the trusted
    // proxy's final entry is empty or malformed.
    const address = last && isIP(last) ? last : peer;
    // Keep hexadecimal mapped IPv4 intact for the identity code to unwrap.
    return address.toLowerCase().startsWith("::ffff:") && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * Builds the HTTP server without listening, so tests can bind it to port 0.
 *
 * Routes:
 *   GET  /healthz                            — liveness, no auth
 *   GET  /.well-known/openai-apps-challenge  — OpenAI's domain check token, 404 when unset
 *   POST /mcp                                — MCP over Streamable HTTP; bearer required,
 *                                              or none for the anonymous tools when a
 *                                              demo key is configured
 *
 * Only POST reaches the transport. With no sessions there is nothing for a
 * GET (the standalone notification stream) or a DELETE (session teardown) to
 * act on — and the SDK would still open an SSE stream for the GET, one whose
 * keep-alive comments reset the idle timeout, so an idle client could pin a
 * connection open indefinitely. Both get a 405 before any work is done.
 */
export function createHttpServer(options: HttpServerOptions): Server {
    const apiUrl = options.apiUrl.replace(/\/+$/, "");
    const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const log = options.log ?? logJson;
    const demoApiKey = options.demoApiKey;
    const limiter = new SlidingWindowLimiter(
        options.anonCallsPerHour ?? DEFAULT_CALLS_PER_HOUR,
        60 * 60 * 1000,
        options.now,
    );
    const claudeLimiter = new SlidingWindowLimiter(
        options.claudeCallsPerHour ?? DEFAULT_CLAUDE_CALLS_PER_HOUR,
        60 * 60 * 1000,
        options.now,
        1,
    );
    const networkLimiter = new SlidingWindowLimiter(
        options.anonNetworkCallsPerHour ?? DEFAULT_NETWORK_CALLS_PER_HOUR,
        60 * 60 * 1000,
        options.now,
    );
    // Every anonymous message that is not a tool call (those have guard() in
    // anon.ts), per network, outside ChatGPT's and Claude's egress.
    const rpcLimiter = new SlidingWindowLimiter(
        options.anonRpcPerHour ?? DEFAULT_RPC_PER_HOUR,
        60 * 60 * 1000,
        options.now,
    );
    // Bounds the responses being generated at once, so no burst of cheap
    // requests can queue an unbounded amount of output in memory.
    const inFlight = new InFlightLimiter(
        options.anonMaxInFlight ?? DEFAULT_MAX_IN_FLIGHT,
        options.anonNetworkMaxInFlight ?? DEFAULT_NETWORK_MAX_IN_FLIGHT,
    );
    const verifiedKeys = new VerifiedKeys(undefined, undefined, options.now);
    const catalogue = new CatalogueCache(undefined, options.now);
    const openaiEgress = options.openaiEgress ?? new CidrSet(options.openaiEgressCidrs ?? OPENAI_EGRESS_CIDRS);
    const untrusted = new UntrustedSubjectTally(log, options.now);
    // Flushes a count left over when the calls stop; it still logs at most hourly.
    const untrustedTimer = setInterval(() => untrusted.flush(), 5 * 60 * 1000);
    untrustedTimer.unref();

    const server = createNodeServer((req, res) => {
        const started = process.hrtime.bigint();
        const method = req.method ?? "GET";
        // Filled in as the request is understood; emitted once on close.
        const fields: Record<string, unknown> = { method, path: req.url ?? "/" };

        res.on("close", () => {
            const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
            log({
                level: res.statusCode >= 500 ? "error" : "info",
                msg: "request",
                ...fields,
                status: res.statusCode,
                duration_ms: Math.round(durationMs * 10) / 10,
            });
        });

        // A request target such as "//" does not parse, and a throw out here
        // is outside handle()'s catch: it would take the whole process down.
        let url: URL;
        try {
            url = new URL(req.url ?? "/", "http://localhost");
        } catch {
            sendJson(res, 400, { error: "bad request" });
            return;
        }
        fields.path = url.pathname;
        const protocolVersion = req.headers["mcp-protocol-version"];
        if (typeof protocolVersion === "string") fields.protocol_version = protocolVersion.slice(0, MAX_LOGGED_HEADER_CHARS);

        handle(req, res, url, method, fields).catch((error: unknown) => {
            log({ level: "error", msg: "unhandled request error", ...fields,
                error: fields.anonymous ? "Anonymous request failed" : String(error) });
            if (!res.headersSent) sendRpcError(res, 500, -32603, "Internal server error");
            else res.end();
        });
    });

    async function handle(
        req: IncomingMessage,
        res: ServerResponse,
        url: URL,
        method: string,
        fields: Record<string, unknown>,
    ): Promise<void> {
        if (url.pathname === "/healthz") {
            if (method !== "GET" && method !== "HEAD") {
                sendJson(res, 405, { error: "method not allowed" }, { Allow: "GET, HEAD" });
                return;
            }
            sendJson(res, 200, { status: "ok", version: SERVER_VERSION });
            return;
        }

        if (url.pathname === "/.well-known/openai-apps-challenge") {
            if (method !== "GET" && method !== "HEAD") {
                sendJson(res, 405, { error: "method not allowed" }, { Allow: "GET, HEAD" });
                return;
            }
            if (!options.openaiAppsChallenge) {
                sendJson(res, 404, { error: "not found" });
                return;
            }
            res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
            res.end(method === "HEAD" ? undefined : options.openaiAppsChallenge);
            return;
        }

        if (url.pathname !== "/mcp") {
            sendJson(res, 404, { error: "not found" });
            return;
        }

        if (method !== "POST") {
            sendRpcError(res, 405, -32000, "Method not allowed", { Allow: "POST" });
            return;
        }

        // Auth first, before any body is read or any transport built. Only
        // the SheetRender API can say whether a key is valid, and it does so
        // on the first tool call; the prefix check keeps a caller with no key
        // at all from making the process read and parse a body.
        // No Authorization header at all, and a demo key to serve it with: the
        // anonymous tools. A header that is present but wrong is still a 401,
        // so a client that meant to send a key learns it is broken.
        const anonymous = req.headers.authorization === undefined && demoApiKey !== undefined;
        const apiKey = anonymous ? demoApiKey : bearerToken(req.headers.authorization);
        if (!apiKey?.startsWith(API_KEY_PREFIX)) {
            sendRpcError(
                res,
                401,
                -32001,
                "Missing or malformed SheetRender API key. Send it as: " +
                    "Authorization: Bearer sr_live_...",
                { "WWW-Authenticate": 'Bearer realm="sheetrender"' },
            );
            return;
        }
        if (anonymous) fields.anonymous = true;
        else fields.key_fp = keyFingerprint(apiKey);

        const ip = clientIp(req);
        // A key counts as real only once the API has answered a call made
        // with it. Until then the request gets exactly the anonymous bounds
        // below, so a made-up `sr_` key gains nothing over sending none.
        const verified = !anonymous && verifiedKeys.has(apiKey);
        if (!anonymous) fields.key_verified = verified;
        const bounded = !verified;
        // ChatGPT's and Claude's egress addresses each carry many users: they
        // count only toward the overall bounds. Everyone else is counted by
        // network (IPv4 /24, IPv6 /48), as the tool calls' network bucket is.
        const networkKey = bounded && !isClaudeIp(ip) && !openaiEgress.has(ip)
            ? `net:${floodNetwork(ip)}`
            : undefined;
        // Every request holds a slot while it is answered, keyed or not: the
        // overall cap bounds the process's memory whoever is asking.
        const slot = inFlight.enter(networkKey);
        if (typeof slot === "string") {
            fields.refused = slot === "key" ? "network_in_flight" : "in_flight";
            // `Connection: close`: the body is never read.
            sendRpcError(
                res,
                slot === "key" ? 429 : 503,
                -32000,
                slot === "key" ? ANON_TEXT.tooManyNetworkInFlight : ANON_TEXT.serverBusy,
                { "Retry-After": "5", Connection: "close" },
            );
            return;
        }
        res.on("close", slot);

        // Anonymous calls get the backend's render body cap: 25 rows at their
        // field caps. create_continue_link checks the handoff cap itself. A key
        // not yet accepted gets the same; the full allowance (render_pdf's HTML,
        // create_dataset's rows) comes with the first call the API accepts.
        const limit = bounded ? Math.min(maxBodyBytes, MAX_ANON_BODY_BYTES) : maxBodyBytes;
        let raw: Buffer;
        try {
            raw = await readBody(req, limit);
        } catch (error) {
            if (error instanceof BodyTooLarge) {
                fields.refused = "body";
                const message = !anonymous && limit < maxBodyBytes
                    ? `Request body exceeds ${limit} bytes. Bodies up to ${maxBodyBytes} bytes are accepted ` +
                        "once the SheetRender API has accepted this key: make a small call first " +
                        "(list_templates), then retry."
                    : `Request body exceeds ${limit} bytes`;
                // `Connection: close` so the rest of the upload is dropped
                // rather than drained once the response has been sent.
                sendRpcError(res, 413, -32000, message, { Connection: "close" });
                return;
            }
            throw error;
        }
        let parsedBody: unknown;
        try {
            parsedBody = JSON.parse(raw.toString("utf8"));
        } catch {
            sendRpcError(res, 400, -32700, "Parse error: Invalid JSON");
            return;
        }
        Object.assign(fields, describeRpc(parsedBody));
        const messages: unknown[] = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
        // The SDK would dispatch every entry at once and queue every answer.
        const maxBatch = bounded ? MAX_ANON_BATCH : MAX_KEYED_BATCH;
        if (messages.length > maxBatch) {
            fields.refused = "batch";
            sendRpcError(res, 400, -32600, `Invalid Request: at most ${maxBatch} messages per batch`);
            return;
        }
        // Anonymous tool calls have their own buckets (guard() in anon.ts), so
        // only the other messages count here. A key not yet accepted counts
        // every message, tool calls too: each would otherwise be a free call
        // to the API that ends in a 401.
        const counted = anonymous
            ? messages.filter((message) =>
                !(message && typeof message === "object" && (message as { method?: unknown }).method === "tools/call")
            ).length
            : messages.length;
        if (networkKey !== undefined && counted > 0) {
            const decision = rpcLimiter.check(networkKey, counted);
            if (!decision.allowed) {
                fields.refused = "network_rpc";
                const minutes = Math.max(1, Math.ceil(decision.retryAfterMs / 60_000));
                sendRpcError(res, 429, -32000, ANON_TEXT.tooManyNetworkCalls.replace("{minutes}", String(minutes)), {
                    "Retry-After": String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))),
                });
                return;
            }
            rpcLimiter.takeMany(networkKey, counted);
        }
        const userAgent = req.headers["user-agent"];
        if (anonymous) {
            Object.assign(fields, describeAnonCall(parsedBody, userAgent, ip, openaiEgress));
            if (fields.subject_untrusted) untrusted.note();
        }

        // Aborted when the response closes, so a caller that disconnects mid
        // render does not leave the upstream request running to its timeout.
        const disconnected = new AbortController();
        const client = new SheetRenderClient({
            baseUrl: apiUrl,
            apiKey,
            signal: disconnected.signal,
            // Every route the API-key tools call needs the key, so a 2xx is the
            // API vouching for it. Never for the demo key: anonymous requests
            // stay bounded whatever the API answers.
            onAccepted: anonymous ? undefined : () => verifiedKeys.add(apiKey),
        });
        const mcp = anonymous
            ? createAnonServer({
                client,
                limiter,
                claudeLimiter,
                networkLimiter,
                catalogue,
                clientIp: ip,
                openaiEgress,
                sessionId: sessionIdOf(req),
                publicUrl: options.publicUrl,
                demoApiKey,
            })
            : createServer(client, { hosted: true });
        // Left stateless on purpose: with a generator the SDK would check every
        // later request's id against this one transport instance, and the next
        // request lands on a fresh transport, perhaps on another replica. So the
        // id is issued here and read from the request header in anon.ts.
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        if (anonymous && isInitialize(parsedBody)) res.setHeader("Mcp-Session-Id", newSessionId());
        transport.onerror = (error) => {
            log({ level: "warn", msg: "transport error", ...fields,
                error: anonymous ? "Anonymous transport failed" : error.message });
        };
        res.on("close", () => {
            // Both are per-request; nothing else references them once the
            // response is gone. close() is idempotent and never throws.
            disconnected.abort();
            void transport.close();
            void mcp.close();
        });

        await mcp.connect(transport);
        await transport.handleRequest(req, res, parsedBody);
    }

    server.on("close", () => clearInterval(untrustedTimer));

    // Idle sockets are dropped after `idleTimeoutMs`; an SSE response in
    // flight is kept alive by the transport's periodic keep-alive comments.
    // headersTimeout has to exceed keepAliveTimeout or node warns at startup.
    server.timeout = idleTimeoutMs;
    server.keepAliveTimeout = idleTimeoutMs;
    server.headersTimeout = idleTimeoutMs + 5_000;

    return server;
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    let config: HttpConfig;
    try {
        config = loadHttpConfig();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`sheetrender-mcp-http: ${message}\n`);
        process.exit(1);
    }

    if (config.demoApiKey) {
        // The anonymous tools' view is inlined from the built bundle; refuse
        // to start without it rather than serve a broken view.
        try {
            loadWidgetBundle();
        } catch (error) {
            process.stderr.write(`sheetrender-mcp-http: ${error instanceof Error ? error.message : String(error)}\n`);
            process.exit(1);
        }
    }

    // OpenAI's list is fetched now and daily unless OPENAI_EGRESS_CIDRS pins
    // it. Until the first fetch lands, and whenever one fails, the set keeps
    // what it has: the built-in copy, then the last good fetch.
    const openaiEgress = new CidrSet(config.openaiEgressCidrs);
    if (config.demoApiKey && !config.openaiEgressFromEnv) startOpenaiEgressRefresh(openaiEgress, { log: logJson });

    const server = createHttpServer({ ...config, openaiEgress });

    let closing = false;
    const shutdown = (signal: NodeJS.Signals) => {
        if (closing) return;
        closing = true;
        logJson({ level: "info", msg: "shutting down", signal });
        // Stop accepting, let in-flight responses finish, then exit. The
        // fallback timer covers a client that never closes its SSE stream.
        server.close(() => process.exit(0));
        server.closeIdleConnections();
        setTimeout(() => process.exit(0), 10_000).unref();
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("unhandledRejection", (reason: unknown) => {
        logJson({ level: "error", msg: "unhandled rejection", error: String(reason) });
    });

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => resolve());
    });
    logJson({
        level: "info",
        msg: "listening",
        version: SERVER_VERSION,
        host: config.host,
        port: config.port,
        api_url: config.apiUrl,
        max_body_bytes: config.maxBodyBytes,
        idle_timeout_ms: config.idleTimeoutMs,
        anonymous_tools: config.demoApiKey !== undefined,
        public_url: config.publicUrl ?? null,
        openai_apps_challenge: config.openaiAppsChallenge !== undefined,
        anon_calls_per_hour: config.anonCallsPerHour,
        claude_calls_per_hour: config.claudeCallsPerHour,
        anon_network_calls_per_hour: config.anonNetworkCallsPerHour,
        anon_rpc_per_hour: config.anonRpcPerHour,
        anon_max_in_flight: config.anonMaxInFlight,
        anon_network_max_in_flight: config.anonNetworkMaxInFlight,
        openai_egress_cidrs: config.openaiEgressCidrs.length,
        openai_egress_source: config.openaiEgressFromEnv ? "env" : config.demoApiKey ? "live" : "built-in",
    });
}

if (runningAsExecutable(import.meta.url)) {
    main().catch((error: unknown) => {
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        process.stderr.write(`sheetrender-mcp-http: fatal: ${message}\n`);
        process.exit(1);
    });
}
