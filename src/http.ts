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
 * is re-registering nine tools per request, which is microseconds.
 *
 * The stdio server in index.ts is untouched by this file.
 */

import { createHash } from "node:crypto";
import { createServer as createNodeServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { SheetRenderClient, SheetRenderError } from "./client.js";
import { createServer, runningAsExecutable, SERVER_VERSION } from "./index.js";

const DEFAULT_PORT = 8080;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_API_URL = "https://sheetrender.com";
/**
 * Request body cap. `render_pdf` carries up to 2 MB of HTML and
 * `create_dataset` up to 50,000 JSON rows; 25 MB matches the proxy in front of
 * the hosted deployment, so the two limits never disagree about a request.
 */
const DEFAULT_MAX_BODY_BYTES = 25 * 1024 * 1024;
/** Socket inactivity timeout. The transport's SSE keep-alive (15 s) resets it. */
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

export interface HttpServerOptions {
    /** SheetRender API base URL every per-request client talks to. */
    apiUrl: string;
    /** Largest request body accepted, in bytes. */
    maxBodyBytes?: number;
    /** Socket inactivity timeout, in milliseconds. */
    idleTimeoutMs?: number;
    /** Receives one structured entry per request and per error. */
    log?: (entry: LogEntry) => void;
}

export type LogEntry = Record<string, unknown> & { level: "info" | "warn" | "error"; msg: string };

export interface HttpConfig {
    port: number;
    host: string;
    apiUrl: string;
    maxBodyBytes: number;
    idleTimeoutMs: number;
}

/** Reads the hosted server's configuration from the environment. */
export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
    const port = readInteger(env, "PORT", DEFAULT_PORT, 1, 65535);
    const host = env.HOST?.trim() || DEFAULT_HOST;
    const rawBase = env.SHEETRENDER_API_URL?.trim() || DEFAULT_API_URL;
    let apiUrl: string;
    try {
        apiUrl = new URL(rawBase).toString().replace(/\/+$/, "");
    } catch {
        throw new SheetRenderError(`SHEETRENDER_API_URL is not a valid URL: ${rawBase}`);
    }
    return {
        port,
        host,
        apiUrl,
        maxBodyBytes: readInteger(env, "MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES, 1024),
        idleTimeoutMs: readInteger(env, "IDLE_TIMEOUT_MS", DEFAULT_IDLE_TIMEOUT_MS, 1000),
    };
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
        req.on("data", (chunk: Buffer) => {
            received += chunk.length;
            if (received > limit) {
                reject(new BodyTooLarge());
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
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

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * Builds the HTTP server without listening, so tests can bind it to port 0.
 *
 * Routes:
 *   GET  /healthz — liveness, no auth
 *   POST /mcp     — MCP over Streamable HTTP, bearer required
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

    const server = createNodeServer((req, res) => {
        const started = process.hrtime.bigint();
        const url = new URL(req.url ?? "/", "http://localhost");
        const method = req.method ?? "GET";
        // Filled in as the request is understood; emitted once on close.
        const fields: Record<string, unknown> = { method, path: url.pathname };

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

        handle(req, res, url, method, fields).catch((error: unknown) => {
            log({ level: "error", msg: "unhandled request error", ...fields, error: String(error) });
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

        if (url.pathname !== "/mcp") {
            sendJson(res, 404, { error: "not found" });
            return;
        }

        if (method !== "POST") {
            sendRpcError(res, 405, -32000, "Method not allowed", { Allow: "POST" });
            return;
        }

        // Auth first, before any body is read or any transport built: an
        // unauthenticated caller must not be able to make the process do work.
        const apiKey = bearerToken(req.headers.authorization);
        if (!apiKey) {
            sendRpcError(
                res,
                401,
                -32001,
                "Missing SheetRender API key. Send it as: Authorization: Bearer sr_live_...",
                { "WWW-Authenticate": 'Bearer realm="sheetrender"' },
            );
            return;
        }
        fields.key_fp = keyFingerprint(apiKey);

        let raw: Buffer;
        try {
            raw = await readBody(req, maxBodyBytes);
        } catch (error) {
            if (error instanceof BodyTooLarge) {
                sendRpcError(res, 413, -32000, `Request body exceeds ${maxBodyBytes} bytes`);
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

        const client = new SheetRenderClient({ baseUrl: apiUrl, apiKey });
        const mcp = createServer(client, { hosted: true });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        transport.onerror = (error) => {
            log({ level: "warn", msg: "transport error", ...fields, error: error.message });
        };
        res.on("close", () => {
            // Both are per-request; nothing else references them once the
            // response is gone. close() is idempotent and never throws.
            void transport.close();
            void mcp.close();
        });

        await mcp.connect(transport);
        await transport.handleRequest(req, res, parsedBody);
    }

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

    const server = createHttpServer(config);

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
    });
}

if (runningAsExecutable(import.meta.url)) {
    main().catch((error: unknown) => {
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        process.stderr.write(`sheetrender-mcp-http: fatal: ${message}\n`);
        process.exit(1);
    });
}
