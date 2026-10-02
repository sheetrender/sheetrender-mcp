import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createNodeServer, type IncomingMessage, type Server } from "node:http";
import { connect as connectSocket, type AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ClientRequestSchema, JSONRPCRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { CidrSet, MAX_ANON_BATCH, MAX_ANON_BODY_BYTES, OPENAI_EGRESS_CIDRS, subjectFingerprint } from "../src/anon.js";
import { ANON_TEXT, BANNED_WORDS } from "../src/anon-descriptions.js";
import { PROTECTED_TOOL_SCOPES, PROTECTED_RESOURCE_PATH } from "../src/auth.js";
import { describeTools } from "../src/descriptions.js";
import {
    bearerToken,
    clientIp,
    createHttpServer,
    keyFingerprint,
    loadHttpConfig,
    MAX_KEYED_BATCH,
    newSessionId,
    UntrustedSubjectTally,
    VerifiedKeys,
    type LogEntry,
} from "../src/http.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
    while (closers.length) await closers.pop()!();
});

function listen(server: Server): Promise<string> {
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as AddressInfo;
            resolve(`http://127.0.0.1:${port}`);
        });
    });
}

function closeServer(server: Server): Promise<void> {
    return new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
    });
}

/**
 * A stand-in SheetRender API. Records the Authorization header of every call
 * and answers the templates listing, which is the cheapest tool to drive.
 */
async function fakeBackend(): Promise<{ url: string; authHeaders: string[] }> {
    const authHeaders: string[] = [];
    const server = createNodeServer((req, res) => {
        authHeaders.push(req.headers.authorization ?? "<none>");
        if (req.url === "/api/v1/templates") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify([
                { id: "tpl_1", name: "Invoice", created_at: null, updated_at: "2026-08-01T00:00:00Z" },
            ]));
            return;
        }
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "Not Found" }));
    });
    const url = await listen(server);
    closers.push(() => closeServer(server));
    return { url, authHeaders };
}

/**
 * A stand-in API that, like the real one, answers 401 to every key but
 * `validKey`, and an empty template list to that one.
 */
async function keyCheckingBackend(validKey: string): Promise<{ url: string; authHeaders: string[] }> {
    const authHeaders: string[] = [];
    const server = createNodeServer((req, res) => {
        req.resume();
        authHeaders.push(req.headers.authorization ?? "<none>");
        const ok = req.headers.authorization === `Bearer ${validKey}`;
        res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json" });
        res.end(ok ? "[]" : JSON.stringify({ detail: "Invalid API key" }));
    });
    const url = await listen(server);
    closers.push(() => closeServer(server));
    return { url, authHeaders };
}

/** The cheapest API-key tool call: one GET of the account's templates. */
const LIST_TEMPLATES_CALL = {
    jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_templates", arguments: {} },
};

/**
 * A stand-in API for the large-body tests: 401 to every key but sr_live_real,
 * and every dataset upload held until release(), so its request stays in flight.
 */
async function heldUploadBackend(): Promise<{ url: string; release: () => void; uploads: () => number }> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let uploads = 0;
    const server = createNodeServer((req, res) => {
        req.resume();
        const answer = (status: number, body: unknown) => {
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(JSON.stringify(body));
        };
        if (req.headers.authorization !== "Bearer sr_live_real") answer(401, { detail: "Invalid API key" });
        else if (!req.url?.endsWith("/datasets/rows")) answer(200, []);
        else {
            uploads++;
            void held.then(() => answer(201, { id: "ds_1", name: "rows", row_count: 40, columns: ["text"] }));
        }
    });
    const url = await listen(server);
    closers.push(() => closeServer(server));
    return { url, release, uploads: () => uploads };
}

/** A create_dataset call whose body is over 2 MB: 40 rows of 64 KB. */
function largeUpload(mcpUrl: string, apiKey: string): Promise<Response> {
    const rows = Array.from({ length: 40 }, () => ({ text: "x".repeat(64 * 1024) }));
    return fetch(`${mcpUrl}/mcp`, {
        method: "POST",
        headers: { ...MCP_HEADERS, Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
            jsonrpc: "2.0", id: 1, method: "tools/call",
            params: { name: "create_dataset", arguments: { template_id: "tpl_1", rows } },
        }),
    });
}

async function startMcp(
    apiUrl: string,
    extra: Partial<Parameters<typeof createHttpServer>[0]> = {},
): Promise<{ url: string; logs: LogEntry[] }> {
    const logs: LogEntry[] = [];
    const server = createHttpServer({ apiUrl, log: (entry) => logs.push(entry), ...extra });
    const url = await listen(server);
    closers.push(() => closeServer(server));
    return { url, logs };
}

/** An MCP client talking to the hosted server with the given bearer token. */
async function connect(mcpUrl: string, apiKey: string): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(`${mcpUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
    });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    closers.push(() => client.close());
    return client;
}

const MCP_HEADERS = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
};

const INITIALIZE = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
    },
});

describe("healthz", () => {
    it("answers 200 without credentials", async () => {
        const { url } = await startMcp("http://127.0.0.1:1");
        const response = await fetch(`${url}/healthz`);
        assert.equal(response.status, 200);
        const body = await response.json() as { status: string; version: string };
        assert.equal(body.status, "ok");
        assert.equal(typeof body.version, "string");
    });

    it("is not logged as an error and never carries a key fingerprint", async () => {
        const { url, logs } = await startMcp("http://127.0.0.1:1");
        await fetch(`${url}/healthz`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const entry = logs.find((line) => line.msg === "request");
        assert.ok(entry);
        assert.equal(entry.level, "info");
        assert.equal(entry.status, 200);
        assert.equal("key_fp" in entry, false);
    });
});

describe("authentication", () => {
    it("rejects an MCP request without a bearer token with 401", async () => {
        const { url } = await startMcp("http://127.0.0.1:1");
        const response = await fetch(`${url}/mcp`, {
            method: "POST",
            headers: MCP_HEADERS,
            body: INITIALIZE,
        });
        assert.equal(response.status, 401);
        assert.match(response.headers.get("www-authenticate") ?? "", /^Bearer/);
        const body = await response.json() as { error: { code: number; message: string } };
        assert.equal(body.error.code, -32001);
        assert.match(body.error.message, /Authorization: Bearer/);
    });

    it("rejects a bearer token that is not a SheetRender key before reading the body", async () => {
        const { url, logs } = await startMcp("http://127.0.0.1:1");
        const response = await fetch(`${url}/mcp`, {
            method: "POST",
            headers: { ...MCP_HEADERS, Authorization: "Bearer junk" },
            body: INITIALIZE,
        });
        assert.equal(response.status, 401);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const entry = logs.find((line) => line.msg === "request");
        assert.ok(entry);
        assert.equal("rpc" in entry, false);
    });

    it("rejects a non-bearer Authorization scheme", async () => {
        const { url } = await startMcp("http://127.0.0.1:1");
        const response = await fetch(`${url}/mcp`, {
            method: "POST",
            headers: { ...MCP_HEADERS, Authorization: "Basic abc" },
            body: INITIALIZE,
        });
        assert.equal(response.status, 401);
    });

    it("answers GET and DELETE with 405 rather than opening a session stream", async () => {
        const { url } = await startMcp("http://127.0.0.1:1");
        for (const method of ["GET", "DELETE"]) {
            const response = await fetch(`${url}/mcp`, {
                method,
                headers: { Accept: "text/event-stream", Authorization: "Bearer sr_test_get" },
            });
            assert.equal(response.status, 405, method);
            assert.equal(response.headers.get("allow"), "POST");
        }
    });

    it("parses the bearer scheme case-insensitively and rejects other shapes", () => {
        assert.equal(bearerToken("Bearer sr_live_abc"), "sr_live_abc");
        assert.equal(bearerToken("bearer sr_live_abc"), "sr_live_abc");
        assert.equal(bearerToken("Bearer"), undefined);
        assert.equal(bearerToken("Basic sr_live_abc"), undefined);
        assert.equal(bearerToken(undefined), undefined);
        assert.equal(bearerToken(["Bearer a", "Bearer b"]), undefined);
    });
});

describe("MCP over HTTP", () => {
    it("lists the hosted tool set — everything except the local-file upload", async () => {
        const backend = await fakeBackend();
        const { url } = await startMcp(backend.url);
        const client = await connect(url, "sr_test_list");
        const { tools } = await client.listTools();
        assert.deepEqual(tools.map((tool) => tool.name).sort(), [
            "create_batch_job",
            "create_dataset",
            "design_template",
            "get_design",
            "get_document",
            "get_job",
            "list_datasets",
            "list_templates",
            "render_pdf",
            "render_template",
        ]);
        // Listing tools never touches the backend.
        assert.deepEqual(backend.authHeaders, []);
        // There is no disk the caller can reach, so no tool may promise a path.
        for (const tool of tools) {
            assert.doesNotMatch(tool.description ?? "", /temp-file path|path to the saved file|upload_dataset/, tool.name);
        }
    });

    it("passes each request's own bearer through to the backend", async () => {
        const backend = await fakeBackend();
        const { url } = await startMcp(backend.url);

        const first = await connect(url, "sr_test_first");
        const result = await first.callTool({ name: "list_templates", arguments: {} });
        const text = (result.content as { text: string }[])[0]!.text;
        assert.match(text, /Invoice/);
        assert.match(text, /tpl_1/);

        const second = await connect(url, "sr_test_second");
        await second.callTool({ name: "list_templates", arguments: {} });
        // Then the first caller again: the key must not have stuck to the process.
        await first.callTool({ name: "list_templates", arguments: {} });

        assert.deepEqual(backend.authHeaders, [
            "Bearer sr_test_first",
            "Bearer sr_test_second",
            "Bearer sr_test_first",
        ]);
    });

    it("logs the method, tool and a key fingerprint but never the key", async () => {
        const backend = await fakeBackend();
        const { url, logs } = await startMcp(backend.url);
        const client = await connect(url, "sr_test_logged");
        await client.callTool({ name: "list_templates", arguments: {} });
        await new Promise((resolve) => setTimeout(resolve, 20));

        const call = logs.find((line) => line.msg === "request" && line.tool === "list_templates");
        assert.ok(call, JSON.stringify(logs));
        assert.equal(call.rpc, "tools/call");
        assert.equal(call.status, 200);
        assert.equal(call.key_fp, keyFingerprint("sr_test_logged"));
        assert.equal(typeof call.duration_ms, "number");
        assert.equal(JSON.stringify(logs).includes("sr_test_logged"), false);
    });

    it("aborts the upstream request when the caller disconnects", async () => {
        // A backend that never answers, and reports when its caller hangs up.
        let hungUp: () => void = () => {};
        const upstreamClosed = new Promise<void>((resolve) => hungUp = resolve);
        const backend = createNodeServer((_req, res) => res.on("close", hungUp));
        const apiUrl = await listen(backend);
        closers.push(() => closeServer(backend));
        const { url } = await startMcp(apiUrl);

        const caller = new AbortController();
        const pending = fetch(`${url}/mcp`, {
            method: "POST",
            headers: { ...MCP_HEADERS, Authorization: "Bearer sr_test_gone" },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name: "list_templates", arguments: {} },
            }),
            signal: caller.signal,
        }).then((response) => response.text()).catch(() => undefined);
        setTimeout(() => caller.abort(), 100);
        await pending;

        const timedOut = new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 2000));
        assert.equal(await Promise.race([upstreamClosed.then(() => "closed"), timedOut]), "closed");
    });

    it("answers 413 past the body limit before touching the transport", async () => {
        const { url } = await startMcp("http://127.0.0.1:1", { maxBodyBytes: 2048 });
        const response = await fetch(`${url}/mcp`, {
            method: "POST",
            headers: { ...MCP_HEADERS, Authorization: "Bearer sr_test_big" },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name: "render_pdf", arguments: { html: "x".repeat(4096) } },
            }),
        });
        assert.equal(response.status, 413);
    });

    it("answers 413, not a reset connection, when a chunked body passes the limit", async () => {
        const { url } = await startMcp("http://127.0.0.1:1", { maxBodyBytes: 2048 });
        const chunk = new TextEncoder().encode("x".repeat(1024));
        let sent = 0;
        // A stream body has no Content-Length, so only the running count can
        // catch it.
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (sent++ < 64) controller.enqueue(chunk);
                else controller.close();
            },
        });
        const response = await fetch(`${url}/mcp`, {
            method: "POST",
            headers: { ...MCP_HEADERS, Authorization: "Bearer sr_test_chunked" },
            body,
            duplex: "half",
        } as RequestInit);
        assert.equal(response.status, 413);
    });

    it("answers 400 for a body that is not JSON", async () => {
        const { url } = await startMcp("http://127.0.0.1:1");
        const response = await fetch(`${url}/mcp`, {
            method: "POST",
            headers: { ...MCP_HEADERS, Authorization: "Bearer sr_test_bad" },
            body: "{not json",
        });
        assert.equal(response.status, 400);
        const body = await response.json() as { error: { code: number } };
        assert.equal(body.error.code, -32700);
    });

    it("answers 400 for a request target that is not a URL, and keeps serving", async () => {
        const { url } = await startMcp("http://127.0.0.1:1");
        const { port } = new URL(url);
        // fetch() normalises its URL, so the raw target goes over a socket.
        const statusLine = await new Promise<string>((resolve, reject) => {
            const socket = connectSocket(Number(port), "127.0.0.1", () => {
                socket.write("GET // HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
            });
            let received = "";
            socket.on("data", (data) => received += data.toString());
            socket.on("close", () => resolve(received.split("\r\n")[0]));
            socket.on("error", reject);
        });
        assert.match(statusLine, /^HTTP\/1\.1 400 /);

        const health = await fetch(`${url}/healthz`);
        assert.equal(health.status, 200);
    });

    it("404s anything that is not /mcp or /healthz", async () => {
        const { url } = await startMcp("http://127.0.0.1:1");
        const response = await fetch(`${url}/`);
        assert.equal(response.status, 404);
    });
});

// ---------------------------------------------------------------------------
// Anonymous mode (SHEETRENDER_DEMO_API_KEY)
// ---------------------------------------------------------------------------

/** The backend's real catalogue, so the per-field caps apply as in production. */
const CATALOGUE_JSON = readFileSync(new URL("../../src-test/fixtures/builtin_catalogue.json", import.meta.url), "utf8");

/**
 * A stand-in for the built-in template routes. Records each call's path,
 * Authorization header and JSON body.
 */
async function fakeBuiltinBackend(): Promise<{ url: string; calls: { path: string; auth: string; body: unknown }[] }> {
    const calls: { path: string; auth: string; body: unknown }[] = [];
    const server = createNodeServer((req, res) => {
        // Buffers, not string concatenation, which splits multi-byte characters across chunks.
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const body = raw ? JSON.parse(raw) as { rows?: unknown[] } : undefined;
            calls.push({ path: req.url ?? "", auth: req.headers.authorization ?? "<none>", body });
            res.writeHead(200, { "Content-Type": "application/json" });
            if (req.url === "/api/v1/builtin-templates") {
                res.end(CATALOGUE_JSON);
            } else if (req.url === "/api/v1/builtin-templates/letter/render") {
                res.end(JSON.stringify({
                    documents: [{ row_index: 0, label: "A", preview_png_url: "/api/previews/x/0.png", pdf_url: "/api/previews/x/0.pdf" }],
                    missing_fields: [],
                    volume: { used: 1, limit: 50, resets_at: "2026-11-01T00:00:00Z" },
                    expires_at: "2026-10-01T14:00:00Z",
                }));
            } else if (req.url === "/api/v1/handoffs") {
                res.end(JSON.stringify({ token: "tok_http", rows_saved: body?.rows?.length ?? 0, expires_at: "2026-10-08T12:00:00Z" }));
            } else {
                res.writeHead(404);
                res.end(JSON.stringify({ detail: "Not Found" }));
            }
        });
    });
    const url = await listen(server);
    closers.push(() => closeServer(server));
    return { url, calls };
}

async function startAnon(
    apiUrl: string,
    extra: Partial<Parameters<typeof createHttpServer>[0]> = {},
): Promise<{ url: string; logs: LogEntry[] }> {
    const logs: LogEntry[] = [];
    const server = createHttpServer({
        apiUrl,
        log: (entry) => logs.push(entry),
        demoApiKey: "sr_live_demo",
        publicUrl: "https://mcp.sheetrender.test/mcp",
        // Stands in for OpenAI's egress ranges: only callers forwarded as
        // 203.0.113.x have their `openai/subject` believed.
        openaiEgressCidrs: ["203.0.113.0/24"],
        ...extra,
    });
    const url = await listen(server);
    closers.push(() => closeServer(server));
    return { url, logs };
}

async function connectAnon(mcpUrl: string, headers: Record<string, string> = {}): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(`${mcpUrl}/mcp`), { requestInit: { headers } });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    closers.push(() => client.close());
    return client;
}

/** One raw JSON-RPC call, answered as JSON or a single SSE event. */
async function rawRpc(mcpUrl: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: unknown; headers: Headers }> {
    // These fixtures test routing and limits, so protocol validation must not
    // reject them before the intended handler. Malformed-message tests use fetch.
    assert.doesNotThrow(() => JSONRPCRequestSchema.parse(body), "rawRpc fixture must be valid JSON-RPC");
    assert.doesNotThrow(() => ClientRequestSchema.parse(body), "rawRpc fixture must be a valid MCP request");
    const response = await fetch(`${mcpUrl}/mcp`, {
        method: "POST",
        headers: { ...MCP_HEADERS, ...headers },
        body: JSON.stringify(body),
    });
    const text = await response.text();
    const data = text.startsWith("{") ? text : text.split("\n").find((line) => line.startsWith("data: "))?.slice(6) ?? "null";
    return { status: response.status, json: JSON.parse(data), headers: response.headers };
}

/** A POST of any body, batches included, with no fixture validation. */
function postRaw(mcpUrl: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${mcpUrl}/mcp`, { method: "POST", headers: { ...MCP_HEADERS, ...headers }, body: JSON.stringify(body) });
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
        if (Date.now() > deadline) throw new Error("timed out waiting");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

describe("anonymous mode", () => {
    it("generates distinct session ids with 64 hexadecimal characters", () => {
        const first = newSessionId();
        const second = newSessionId();
        assert.match(first, /^[a-f0-9]{64}$/);
        assert.match(second, /^[a-f0-9]{64}$/);
        assert.notEqual(first, second);
    });

    it("issues a fresh session header on anonymous initialize but none with an API key", async () => {
        const { url } = await startAnon("http://127.0.0.1:1");
        const first = await rawRpc(url, JSON.parse(INITIALIZE));
        const second = await rawRpc(url, JSON.parse(INITIALIZE));
        for (const response of [first, second]) {
            assert.equal(response.status, 200);
            assert.ok((response.json as { result: { protocolVersion: string } }).result.protocolVersion);
            assert.match(response.headers.get("Mcp-Session-Id") ?? "", /^[a-f0-9]{64}$/);
        }
        assert.notEqual(first.headers.get("Mcp-Session-Id"), second.headers.get("Mcp-Session-Id"));
        const keyed = await rawRpc(url, JSON.parse(INITIALIZE), { Authorization: "Bearer sr_test_session" });
        assert.equal(keyed.status, 200);
        assert.ok((keyed.json as { result: { protocolVersion: string } }).result.protocolVersion);
        assert.equal(keyed.headers.get("Mcp-Session-Id"), null);
    });

    it("accepts later tool calls with an unknown session id or no session id", async () => {
        const backend = await fakeBuiltinBackend();
        const { url } = await startAnon(backend.url);
        const initialized = await rawRpc(url, JSON.parse(INITIALIZE));
        assert.equal(initialized.status, 200);
        const unknown = "unknown-session-never-issued";
        assert.notEqual(initialized.headers.get("Mcp-Session-Id"), unknown);
        const headers: Record<string, string>[] = [{ "Mcp-Session-Id": unknown }, {}];
        for (const header of headers) {
            const response = await rawRpc(url, {
                jsonrpc: "2.0", id: 2, method: "tools/call",
                params: { name: "render_documents", arguments: { template: "letter", rows: [{ body: "x" }] } },
            }, header);
            assert.equal(response.status, 200);
            const result = (response.json as { result: { isError?: boolean; structuredContent: { rows_rendered: number } } }).result;
            assert.ok(!result.isError);
            assert.equal(result.structuredContent.rows_rendered, 1);
        }
        assert.equal(backend.calls.filter((call) => call.path === "/api/v1/builtin-templates/letter/render").length, 2);
    });

    it("routes session subjects and the Claude pool for every Claude-range caller", async () => {
        const backend = await fakeBuiltinBackend();
        const { url, logs } = await startAnon(backend.url);
        const hash = (value: string) => createHash("sha256").update(value).digest("hex");
        const claudeSession = newSessionId();
        const chatgptSession = newSessionId();
        const otherSession = newSessionId();
        const results: unknown[] = [];
        for (const caller of [
            {
                ip: "160.79.104.5", sessionId: claudeSession, meta: undefined,
                subject: `mcps:${hash(claudeSession)}`, source: "claude", pool: "claude",
            },
            {
                ip: "160.79.104.5", sessionId: undefined, meta: undefined,
                subject: `ip:${hash("160.79.104.5")}`, source: "claude", pool: "claude",
            },
            {
                // A ChatGPT subject sent from Claude's network is ignored.
                ip: "160.79.104.5", sessionId: chatgptSession, meta: { "openai/subject": "chatgpt-session-user" },
                subject: `mcps:${hash(chatgptSession)}`, source: "claude", pool: "claude",
            },
            {
                ip: "198.51.100.7", sessionId: otherSession, meta: undefined,
                subject: `ip:${hash("198.51.100.7")}`, source: "other", pool: undefined,
            },
        ]) {
            const headers: Record<string, string> = { "X-Forwarded-For": caller.ip, "User-Agent": "test-client" };
            if (caller.sessionId !== undefined) headers["Mcp-Session-Id"] = caller.sessionId;
            for (const name of ["render_documents", "create_continue_link"]) {
                const response = await rawRpc(url, {
                    jsonrpc: "2.0", id: 3, method: "tools/call",
                    params: { name, arguments: { template: "letter", rows: [{ body: "x" }] }, _meta: caller.meta },
                }, headers);
                assert.equal(response.status, 200, `${caller.source}: ${name}`);
                const result = (response.json as { result: { isError?: boolean; structuredContent: Record<string, unknown> } }).result;
                assert.ok(!result.isError, JSON.stringify(response.json));
                results.push(result);
                const isRender = name === "render_documents";
                const path = isRender ? "/api/v1/builtin-templates/letter/render" : "/api/v1/handoffs";
                const request = backend.calls.filter((call) => call.path === path).at(-1)!;
                assert.ok(request, `${caller.source}: ${path}`);
                const sent = request.body as Record<string, unknown>;
                assert.equal(sent.subject, caller.subject);
                assert.equal(sent.source, caller.source);
                if (isRender && caller.pool) {
                    assert.equal(sent.pool, "claude");
                } else {
                    assert.equal("pool" in sent, false);
                }
                if (isRender) {
                    assert.equal(result.structuredContent.rows_rendered, 1);
                } else {
                    const continueUrl = new URL(result.structuredContent.continue_url as string);
                    assert.equal(continueUrl.searchParams.get("ref"), caller.source === "other" ? "mcp" : caller.source);
                }
            }
        }
        assert.equal(backend.calls.filter((call) => call.path === "/api/v1/builtin-templates/letter/render").length, 4);
        assert.equal(backend.calls.filter((call) => call.path === "/api/v1/handoffs").length, 4);
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(logs.filter((entry) => entry.msg === "request" && entry.rpc === "tools/call").length, 8);
        for (const sessionId of [claudeSession, chatgptSession, otherSession]) {
            assert.ok(!JSON.stringify(logs).includes(sessionId), "logs contain a raw session id");
            assert.ok(!JSON.stringify(backend.calls).includes(sessionId), "backend request bodies or paths contain a raw session id");
            assert.ok(!JSON.stringify(results).includes(sessionId), "tool results contain a raw session id");
        }
    });

    it("cannot cross tool registries in either direction, even with a forged metadata key", async () => {
        const backend = await fakeBuiltinBackend();
        const { url } = await startAnon(backend.url);
        for (const [name, headers] of [
            ["render_pdf", {}],
            ["render_documents", { Authorization: "Bearer sr_test_user" }],
        ] as const) {
            const { status, json } = await rawRpc(url, {
                jsonrpc: "2.0", id: 1, method: "tools/call",
                params: { name, arguments: { html: "<p>x</p>", template: "letter", rows: [{ body: "x" }] },
                    _meta: { authorization: "Bearer sr_test_user" } },
            }, headers);
            assert.equal(status, 200);
            const result = (json as { result: { isError?: boolean; content: { text: string }[] } }).result;
            assert.equal(result.isError, true);
            assert.ok(result.content.some((item) => item.text.includes(`Tool ${name} not found`)));
        }
        assert.deepEqual(backend.calls, []);
    });
    it("serves the three anonymous tools to a caller without a key", async () => {
        const backend = await fakeBuiltinBackend();
        const { url } = await startAnon(backend.url);
        const client = await connectAnon(url);
        const { tools } = await client.listTools();
        assert.deepEqual(tools.map((tool) => tool.name).sort(), [
            "create_continue_link",
            "list_document_templates",
            "render_documents",
        ]);
    });

    it("keeps the API-key tools, unchanged, for a caller that sends a key", async () => {
        const backend = await fakeBackend();
        const { url } = await startAnon(backend.url);
        const client = await connect(url, "sr_test_keyed");
        const names = (await client.listTools()).tools.map((tool) => tool.name);
        assert.ok(names.includes("render_pdf"));
        assert.ok(!names.includes("render_documents"));
        await client.callTool({ name: "list_templates", arguments: {} });
        assert.deepEqual(backend.authHeaders, ["Bearer sr_test_keyed"]);
    });

    it("still answers 401 to a malformed key, and to no key when no demo key is set", async () => {
        const anon = await startAnon("http://127.0.0.1:1");
        for (const authorization of ["Bearer junk", "", "Basic sr_test_key", "Bearer"]) {
            const malformed = await fetch(`${anon.url}/mcp`, {
                method: "POST",
                headers: { ...MCP_HEADERS, Authorization: authorization },
                body: INITIALIZE,
            });
            assert.equal(malformed.status, 401, authorization);
        }
        const plain = await startMcp("http://127.0.0.1:1");
        const none = await fetch(`${plain.url}/mcp`, { method: "POST", headers: MCP_HEADERS, body: INITIALIZE });
        assert.equal(none.status, 401);
    });

    it("renders with the demo key, a hashed subject, and logs no rows or raw subject", async () => {
        const backend = await fakeBuiltinBackend();
        const { url, logs } = await startAnon(backend.url);
        const { status, json } = await rawRpc(url, {
            jsonrpc: "2.0",
            id: 7,
            method: "tools/call",
            params: {
                name: "render_documents",
                arguments: { template: "letter", rows: [{ recipient_name: "Ada Secret", body: "Hi" }] },
                _meta: { "openai/subject": "subject-xyz" },
            },
        }, { "X-Forwarded-For": "203.0.113.50" });
        assert.equal(status, 200);
        const result = (json as { result: { structuredContent: { rows_rendered: number; documents: { pdf_url: string }[] } } }).result;
        assert.equal(result.structuredContent.rows_rendered, 1);
        assert.equal(result.structuredContent.documents[0]!.pdf_url, `${backend.url}/api/previews/x/0.pdf`);

        const render = backend.calls.find((call) => call.path === "/api/v1/builtin-templates/letter/render")!;
        assert.equal(render.auth, "Bearer sr_live_demo");
        const sent = render.body as { subject: string; source: string };
        assert.equal(sent.subject, `sub:${createHash("sha256").update("subject-xyz").digest("hex")}`);
        assert.equal(sent.source, "chatgpt");

        await new Promise((resolve) => setTimeout(resolve, 20));
        const entry = logs.find((line) => line.msg === "request" && line.tool === "render_documents");
        assert.ok(entry, JSON.stringify(logs));
        assert.equal(entry.anonymous, true);
        assert.equal(entry.source, "chatgpt");
        assert.equal(entry.rows, 1);
        assert.equal(entry.subject_fp, subjectFingerprint("subject-xyz"));
        assert.notEqual(entry.subject_fp, createHash("sha256").update("subject-xyz").digest("hex").slice(0, 12));
        assert.equal("key_fp" in entry, false);
        const logged = JSON.stringify(logs);
        assert.equal(logged.includes("Ada Secret"), false);
        assert.equal(logged.includes("subject-xyz"), false);
        assert.equal(logged.includes("sr_live_demo"), false);
    });

    it("lists securitySchemes at the top level of each tool too, where ChatGPT reads it", async () => {
        const { url } = await startAnon("http://127.0.0.1:1");
        const { json } = await rawRpc(url, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
        const tools = (json as { result: { tools: { name: string; securitySchemes?: unknown }[] } }).result.tools;
        assert.equal(tools.length, 3);
        for (const tool of tools) assert.deepEqual(tool.securitySchemes, [{ type: "noauth" }], tool.name);
    });

    it("limits by the forwarded client IP when there is no subject", async () => {
        const backend = await fakeBuiltinBackend();
        const { url } = await startAnon(backend.url, { anonCallsPerHour: 1 });
        const call = (forwardedFor: string) => rawRpc(url, {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "render_documents", arguments: { template: "letter", rows: [{ body: "x" }] } },
        }, { "X-Forwarded-For": forwardedFor });
        type Result = { result: { isError?: boolean } };
        assert.equal(((await call("198.51.100.1")).json as Result).result.isError, undefined);
        assert.equal(((await call("198.51.100.1")).json as Result).result.isError, true);
        // The proxy appends the real peer last; a spoofed left-hand entry changes nothing.
        assert.equal(((await call("10.9.9.9, 198.51.100.1")).json as Result).result.isError, true);
        assert.equal(((await call("198.51.100.2")).json as Result).result.isError, undefined);
        const renders = backend.calls.filter((c) => c.path.endsWith("/render"));
        assert.deepEqual(
            renders.map((c) => (c.body as { subject: string }).subject),
            [
                `ip:${createHash("sha256").update("198.51.100.1").digest("hex")}`,
                `ip:${createHash("sha256").update("198.51.100.2").digest("hex")}`,
            ],
        );
    });

    it("shares the configurable Claude range bucket without changing other callers", async () => {
        const backend = await fakeBuiltinBackend();
        const { url, logs } = await startAnon(backend.url, { anonCallsPerHour: 1, claudeCallsPerHour: 2 });
        const call = (ip: string, meta?: Record<string, unknown>) => rawRpc(url, {
            jsonrpc: "2.0", id: 1, method: "tools/call", params: {
                name: "render_documents", arguments: { template: "letter", rows: [{ body: "x" }] }, _meta: meta,
            },
        }, { "X-Forwarded-For": ip, "User-Agent": "Claude-User" });
        const failed = async (ip: string, meta?: Record<string, unknown>) =>
            ((await call(ip, meta)).json as { result: { isError?: boolean } }).result.isError;
        assert.equal(await failed("160.79.104.1"), undefined);
        assert.equal(await failed("160.79.111.255"), undefined);
        assert.equal(await failed("160.79.105.9"), true);
        // A ChatGPT subject from Claude's network is still the shared bucket.
        assert.equal(await failed("160.79.104.1", { "openai/subject": "chatgpt-user" }), true);
        // A Claude User-Agent outside the verified range cannot claim its budget.
        assert.equal(await failed("203.0.113.8"), undefined);
        assert.equal(await failed("203.0.113.8"), true);
        const renders = backend.calls.filter((call) => call.path.endsWith("/render"));
        assert.deepEqual(renders.map((call) => (call.body as { source: string }).source), ["claude", "claude", "other"]);
        assert.equal("pool" in (renders[2]!.body as Record<string, unknown>), false);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const entries = logs.filter((entry) => entry.msg === "request" && entry.tool === "render_documents");
        assert.deepEqual(entries.map((entry) => entry.source), ["claude", "claude", "claude", "claude", "other", "other"]);
    });

    it("shares HTTP flood buckets across IPv6 /64 addresses and mapped IPv4 spellings", async () => {
        const backend = await fakeBuiltinBackend();
        const { url } = await startAnon(backend.url, { anonCallsPerHour: 1 });
        const call = (ip: string) => rawRpc(url, {
            jsonrpc: "2.0", id: 1, method: "tools/call",
            params: { name: "render_documents", arguments: { template: "letter", rows: [{ body: "x" }] } },
        }, { "X-Forwarded-For": ip });
        for (const [ip, refused] of [
            ["2001:db8:1:2::1", false],
            ["2001:db8:1:2::2", true],
            ["2001:0DB8:0001:0002:ffff:ffff:ffff:ffff", true],
            ["2001:db8:1:3::1", false],
            ["198.51.100.7", false],
            ["::ffff:198.51.100.7", true],
            ["::ffff:c633:6407", true],
            ["198.51.100.8", false],
        ] as const) {
            const result = (await call(ip)).json as { result: { isError?: boolean } };
            assert.equal(Boolean(result.result.isError), refused, ip);
        }
        const renders = backend.calls.filter((call) => call.path.endsWith("/render"));
        assert.deepEqual(renders.map((call) => (call.body as { subject: string }).subject),
            ["2001:db8:1:2::/64", "2001:db8:1:3::/64", "198.51.100.7", "198.51.100.8"]
                .map((network) => `ip:${createHash("sha256").update(network).digest("hex")}`));
    });

    it("renders 25 letters at their field caps through the HTTP body cap", async () => {
        const backend = await fakeBuiltinBackend();
        const { url } = await startAnon(backend.url);
        // Every field at its cap: 5,000-character or 12,288-byte bodies, and
        // the other seven fields at 2,046 UTF-8 bytes of CJK text.
        const cjk = "名".repeat(682);
        const rows = Array.from({ length: 25 }, (_, i) => ({
            recipient_name: cjk, date: cjk, sender_name: cjk, sender_title: cjk,
            address_line_1: cjk, address_line_2: cjk, subject: cjk,
            body: i % 2 ? "界".repeat(4096) : "x".repeat(5000),
        }));
        const body = {
            jsonrpc: "2.0", id: 9, method: "tools/call",
            params: { name: "render_documents", arguments: { template: "letter", rows } },
        };
        // Once as UTF-8, once with every non-ASCII character escaped as a
        // Python client sends it (json.dumps' default), which is twice the bytes.
        const utf8 = JSON.stringify(body);
        const escaped = utf8.replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
        assert.ok(Buffer.byteLength(utf8) > 2 * 256 * 1024, String(Buffer.byteLength(utf8)));
        assert.ok(Buffer.byteLength(escaped) > 1024 * 1024, String(Buffer.byteLength(escaped)));
        for (const payload of [utf8, escaped]) {
            const response = await fetch(`${url}/mcp`, { method: "POST", headers: MCP_HEADERS, body: payload });
            assert.equal(response.status, 200);
            const text = await response.text();
            const data = text.startsWith("{") ? text : text.split("\n").find((line) => line.startsWith("data: "))!.slice(6);
            const result = (JSON.parse(data) as { result: { isError?: boolean; content: { text: string }[] } }).result;
            assert.ok(!result.isError, result.content[0]?.text);
        }
        const renders = backend.calls.filter((call) => call.path === "/api/v1/builtin-templates/letter/render");
        assert.equal(renders.length, 2);
        for (const render of renders) assert.deepEqual((render.body as { rows: unknown }).rows, rows);
    });

    it("ignores a forged openai/subject over HTTP and logs it as untrusted", async () => {
        const backend = await fakeBuiltinBackend();
        const { url, logs } = await startAnon(backend.url, { anonCallsPerHour: 1 });
        const call = (subject: string) => rawRpc(url, {
            jsonrpc: "2.0", id: 1, method: "tools/call", params: {
                name: "render_documents", arguments: { template: "letter", rows: [{ body: "x" }] },
                _meta: { "openai/subject": subject },
            },
        }, { "X-Forwarded-For": "198.51.100.9", "User-Agent": "ChatGPT" });
        type Result = { result: { isError?: boolean } };
        assert.equal(((await call("fresh-1")).json as Result).result.isError, undefined);
        assert.equal(((await call("fresh-2")).json as Result).result.isError, true);
        const render = backend.calls.find((c) => c.path.endsWith("/render"))!;
        assert.equal((render.body as { subject: string }).subject, `ip:${createHash("sha256").update("198.51.100.9").digest("hex")}`);
        assert.equal((render.body as { source: string }).source, "other");
        assert.equal("pool" in (render.body as Record<string, unknown>), false);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const entries = logs.filter((entry) => entry.msg === "request" && entry.tool === "render_documents");
        assert.equal(entries.length, 2);
        for (const entry of entries) {
            assert.equal(entry.source, "other");
            assert.equal(entry.subject_untrusted, true);
            assert.equal("subject_fp" in entry, false);
        }
        assert.equal(JSON.stringify(logs).includes("fresh-1"), false);
    });

    it("caps IP-counted callers per /24 over HTTP, and not callers with a trusted subject", async () => {
        const backend = await fakeBuiltinBackend();
        const { url } = await startAnon(backend.url, { anonNetworkCallsPerHour: 2 });
        const call = (ip: string, meta?: Record<string, unknown>) => rawRpc(url, {
            jsonrpc: "2.0", id: 1, method: "tools/call", params: {
                name: "render_documents", arguments: { template: "letter", rows: [{ body: "x" }] }, _meta: meta,
            },
        }, { "X-Forwarded-For": ip });
        type Result = { result: { isError?: boolean; content: { text: string }[] } };
        assert.equal(((await call("198.51.100.1")).json as Result).result.isError, undefined);
        assert.equal(((await call("198.51.100.2")).json as Result).result.isError, undefined);
        const refused = ((await call("198.51.100.3")).json as Result).result;
        assert.equal(refused.isError, true);
        assert.equal(refused.content[0]!.text, ANON_TEXT.tooManyNetworkCalls.replace("{minutes}", "60"));
        assert.equal(((await call("198.51.101.3")).json as Result).result.isError, undefined);
        for (const subject of ["a", "b", "c"]) {
            const result = ((await call("203.0.113.5", { "openai/subject": subject })).json as Result).result;
            assert.equal(result.isError, undefined, subject);
        }
    });

    it("uses a live OpenAI set when one is passed in", async () => {
        const backend = await fakeBuiltinBackend();
        const openaiEgress = new CidrSet(["192.0.2.0/24"]);
        const { url } = await startAnon(backend.url, { openaiEgress });
        const call = () => rawRpc(url, {
            jsonrpc: "2.0", id: 1, method: "tools/call", params: {
                name: "render_documents", arguments: { template: "letter", rows: [{ body: "x" }] },
                _meta: { "openai/subject": "user-1" },
            },
        }, { "X-Forwarded-For": "198.51.100.40" });
        await call();
        openaiEgress.replace(["198.51.100.0/24"]);
        await call();
        const renders = backend.calls.filter((c) => c.path.endsWith("/render"));
        assert.deepEqual(renders.map((c) => (c.body as { source: string }).source), ["other", "chatgpt"]);
    });

    it("logs a summary of ignored openai/subject calls at most once an hour", async () => {
        const backend = await fakeBuiltinBackend();
        let now = 1_000_000;
        const { url, logs } = await startAnon(backend.url, { now: () => now });
        const call = () => rawRpc(url, {
            jsonrpc: "2.0", id: 1, method: "tools/call", params: {
                name: "render_documents", arguments: { template: "letter", rows: [{ body: "x" }] },
                _meta: { "openai/subject": "someone" },
            },
        }, { "X-Forwarded-For": "198.51.100.77" });
        const summaries = () => logs.filter((entry) => entry.msg === "openai/subject from outside the OpenAI ranges");
        await call();
        await call();
        await call();
        assert.deepEqual(summaries().map((entry) => entry.count), [1]);
        now += 60 * 60 * 1000;
        await call();
        assert.deepEqual(summaries().map((entry) => entry.count), [1, 3]);
        assert.equal(summaries()[0]!.level, "warn");
        assert.equal(JSON.stringify(logs).includes("someone"), false);
    });

    it("logs source other when configured OpenAI ranges do not trust a published OpenAI IP", async () => {
        const backend = await fakeBuiltinBackend();
        const { url, logs } = await startAnon(backend.url, { openaiEgressCidrs: [] });
        const response = await rawRpc(url, {
            jsonrpc: "2.0", id: 1, method: "tools/call",
            params: {
                name: "render_documents", arguments: { template: "letter", rows: [{ body: "x" }] },
                _meta: { "openai/subject": "untrusted-user" },
            },
        }, { "X-Forwarded-For": "98.87.72.221", "User-Agent": "ChatGPT" });
        assert.ok(!(response.json as { result: { isError?: boolean } }).result.isError);
        const render = backend.calls.find((call) => call.path.endsWith("/render"))!;
        assert.equal((render.body as { source: string }).source, "other");
        await new Promise((resolve) => setTimeout(resolve, 20));
        const entry = logs.find((entry) => entry.msg === "request" && entry.tool === "render_documents")!;
        assert.ok(entry);
        assert.equal(entry.source, "other");
        assert.equal(entry.subject_untrusted, true);
        assert.equal("subject_fp" in entry, false);
    });

    it("caps anonymous and unconfirmed-key bodies at 2 MB, and gives a key the API accepted the full cap", async () => {
        const limit = MAX_ANON_BODY_BYTES;
        assert.equal(limit, 2 * 1024 * 1024);
        const paddedRequest = (bytes: number) => {
            // Extension metadata is permitted; unknown JSON-RPC envelope keys
            // are rejected by the SDK before tools/list can answer.
            const body = { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "test/padding": "" } } };
            body.params._meta["test/padding"] = "x".repeat(bytes - Buffer.byteLength(JSON.stringify(body)));
            assert.equal(Buffer.byteLength(JSON.stringify(body)), bytes);
            return body;
        };
        const atLimit = paddedRequest(limit);
        const overLimit = paddedRequest(limit + 1);
        const { url } = await startAnon("http://127.0.0.1:1");
        const accepted = await rawRpc(url, atLimit);
        assert.equal(accepted.status, 200);
        assert.ok((accepted.json as { result: { tools: { name: string }[] } }).result.tools.some((tool) => tool.name === "render_documents"));
        assert.equal((await rawRpc(url, overLimit)).status, 413);
        // Any `sr_` string selects the API-key tools, but proves nothing: a
        // made-up key gets the anonymous cap, and is told how to get more.
        const madeUpKey = await rawRpc(url, overLimit, { Authorization: "Bearer sr_test_key" });
        assert.equal(madeUpKey.status, 413);
        assert.match((madeUpKey.json as { error: { message: string } }).error.message, /accepted this key/);
        // Once the API has answered a call made with the key, the full cap applies.
        const backend = await keyCheckingBackend("sr_live_real");
        const keyedServer = await startMcp(backend.url);
        const real = { Authorization: "Bearer sr_live_real" };
        assert.equal((await rawRpc(keyedServer.url, overLimit, real)).status, 413);
        await rawRpc(keyedServer.url, LIST_TEMPLATES_CALL, real);
        const keyed = await rawRpc(keyedServer.url, overLimit, real);
        assert.equal(keyed.status, 200);
        const names = (keyed.json as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name);
        assert.ok(names.includes("render_pdf"));
        assert.ok(!names.includes("render_documents"));
        // A key the API refused stays bounded.
        const refused = { Authorization: "Bearer sr_live_revoked" };
        await rawRpc(keyedServer.url, LIST_TEMPLATES_CALL, refused);
        assert.equal((await rawRpc(keyedServer.url, overLimit, refused)).status, 413);
    });

    it("refuses an anonymous batch past 4 messages before dispatching any of it", async () => {
        const { url } = await startAnon("http://127.0.0.1:1");
        const widgetReads = (count: number) => Array.from({ length: count }, (_, index) => ({
            jsonrpc: "2.0", id: index + 1, method: "resources/read", params: { uri: "ui://sheetrender/documents.html" },
        }));
        const events = (text: string) => text.split("\n").filter((line) => line.startsWith("data: {")).length;
        // 50 widget reads fit in a few KB but would answer with ~50 copies of the bundle.
        const big = await postRaw(url, widgetReads(50));
        const text = await big.text();
        assert.equal(big.status, 400, `answered with ${events(text)} messages`);
        assert.equal((JSON.parse(text) as { error: { code: number } }).error.code, -32600);
        const small = await postRaw(url, widgetReads(4));
        assert.equal(small.status, 200);
        assert.equal(events(await small.text()), 4);
        // A made-up key gets the same cap: the keyed server answers tools/list
        // locally, so 50 of them would never meet an authentication check.
        const listTools = (count: number) =>
            Array.from({ length: count }, (_, index) => ({ jsonrpc: "2.0", id: index + 1, method: "tools/list" }));
        const madeUp = await postRaw(url, listTools(50), { Authorization: "Bearer sr_test_key" });
        const madeUpText = await madeUp.text();
        assert.equal(madeUp.status, 400, `answered with ${events(madeUpText)} messages`);
        assert.equal((JSON.parse(madeUpText) as { error: { code: number } }).error.code, -32600);
        assert.equal((await postRaw(url, listTools(MAX_ANON_BATCH + 1), { Authorization: "Bearer sr_test_key" })).status, 400);
        const fits = await postRaw(url, listTools(MAX_ANON_BATCH), { Authorization: "Bearer sr_test_key" });
        assert.equal(fits.status, 200);
        assert.equal(events(await fits.text()), MAX_ANON_BATCH);
    });

    it("handles one body over 2 MB at a time, refusing the next with 503 before reading it", async () => {
        const backend = await heldUploadBackend();
        const { url, logs } = await startMcp(backend.url);
        const real = { Authorization: "Bearer sr_live_real" };
        await rawRpc(url, LIST_TEMPLATES_CALL, real);
        const upload = largeUpload(url, "sr_live_real");
        await waitUntil(() => backend.uploads() === 1);

        const padded = (bytes: number) => {
            const body = { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "test/padding": "" } } };
            body.params._meta["test/padding"] = "x".repeat(bytes - Buffer.byteLength(JSON.stringify(body)));
            return JSON.stringify(body);
        };
        const large = padded(MAX_ANON_BODY_BYTES + 1024);
        const sendLarge = () => fetch(`${url}/mcp`, { method: "POST", headers: { ...MCP_HEADERS, ...real }, body: large });
        // Declared by Content-Length: refused before any of it is read.
        const declared = await sendLarge();
        assert.equal(declared.status, 503);
        assert.equal(declared.headers.get("retry-after"), "5");
        assert.equal((await declared.json() as { error: { message: string } }).error.message, ANON_TEXT.serverBusy);
        // Streamed with no Content-Length: refused as it passes 2 MB.
        const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
        let sent = 0;
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (sent++ < 64) controller.enqueue(chunk);
                else controller.close();
            },
        });
        const streamed = await fetch(`${url}/mcp`, {
            method: "POST", headers: { ...MCP_HEADERS, ...real }, body: stream, duplex: "half",
        } as RequestInit);
        assert.equal(streamed.status, 503);
        await streamed.text();
        // Small requests are not held up.
        assert.equal((await rawRpc(url, { jsonrpc: "2.0", id: 1, method: "tools/list" }, real)).status, 200);
        assert.equal(backend.uploads(), 1);

        backend.release();
        const done = await upload;
        assert.equal(done.status, 200);
        await done.text();
        // The slot is back once that response has ended.
        await waitUntil(async () => {
            const response = await sendLarge();
            await response.text();
            return response.status === 200;
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(logs.filter((entry) => entry.msg === "request" && entry.refused === "large_body_in_flight").length, 2);
    });

    it("lets LARGE_BODY_MAX_IN_FLIGHT allow more large bodies at once", async () => {
        const backend = await heldUploadBackend();
        const { url } = await startMcp(backend.url, { largeBodyMaxInFlight: 2 });
        await rawRpc(url, LIST_TEMPLATES_CALL, { Authorization: "Bearer sr_live_real" });
        const uploads = [largeUpload(url, "sr_live_real"), largeUpload(url, "sr_live_real")];
        await waitUntil(() => backend.uploads() === 2);
        const third = await largeUpload(url, "sr_live_real");
        assert.equal(third.status, 503);
        await third.text();
        backend.release();
        for (const pending of uploads) {
            const response = await pending;
            assert.equal(response.status, 200);
            await response.text();
        }
    });

    it("lets a key the API accepted batch up to 20 messages, and no further", async () => {
        assert.equal(MAX_KEYED_BATCH, 20);
        const backend = await keyCheckingBackend("sr_live_real");
        const { url } = await startMcp(backend.url);
        const listTools = (count: number) =>
            Array.from({ length: count }, (_, index) => ({ jsonrpc: "2.0", id: index + 1, method: "tools/list" }));
        const events = (text: string) => text.split("\n").filter((line) => line.startsWith("data: {")).length;
        const real = { Authorization: "Bearer sr_live_real" };
        assert.equal((await postRaw(url, listTools(MAX_ANON_BATCH + 1), real)).status, 400, "not yet accepted");
        await rawRpc(url, LIST_TEMPLATES_CALL, real);
        const full = await postRaw(url, listTools(MAX_KEYED_BATCH), real);
        assert.equal(full.status, 200);
        assert.equal(events(await full.text()), MAX_KEYED_BATCH);
        const over = await postRaw(url, listTools(MAX_KEYED_BATCH + 1), real);
        assert.equal(over.status, 400);
        assert.match((await over.json() as { error: { message: string } }).error.message, /at most 20 messages/);
        // The key the API turned away gets nothing from having asked.
        const refused = { Authorization: "Bearer sr_live_revoked" };
        await rawRpc(url, LIST_TEMPLATES_CALL, refused);
        assert.equal((await postRaw(url, listTools(MAX_ANON_BATCH + 1), refused)).status, 400);
        assert.deepEqual(backend.authHeaders, ["Bearer sr_live_real", "Bearer sr_live_revoked"]);
    });

    it("counts every message from an unconfirmed key toward the network budget, tool calls too", async () => {
        const backend = await keyCheckingBackend("sr_live_real");
        const { url, logs } = await startMcp(backend.url, { anonRpcPerHour: 3 });
        const list = (key: string, ip: string) =>
            postRaw(url, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { Authorization: `Bearer ${key}`, "X-Forwarded-For": ip });
        for (let i = 0; i < 3; i++) assert.equal((await list("sr_fake_a", "198.51.100.1")).status, 200);
        const refused = await list("sr_fake_a", "198.51.100.1");
        assert.equal(refused.status, 429);
        assert.equal(refused.headers.get("retry-after"), "3600");
        // A fresh made-up key from the same /24 is the same caller.
        assert.equal((await list("sr_fake_b", "198.51.100.2")).status, 429);
        // Tool calls count as well: each would be a free trip to the API.
        const call = (key: string, ip: string) =>
            rawRpc(url, LIST_TEMPLATES_CALL, { Authorization: `Bearer ${key}`, "X-Forwarded-For": ip });
        for (let i = 0; i < 3; i++) assert.equal((await call("sr_fake_c", "198.51.101.1")).status, 200);
        assert.equal((await call("sr_fake_c", "198.51.101.1")).status, 429);
        assert.equal(backend.authHeaders.filter((header) => header.startsWith("Bearer sr_fake")).length, 3);
        // A batch needs room for all of its messages.
        const batch = await postRaw(url, [
            { jsonrpc: "2.0", id: 1, method: "tools/list" },
            { jsonrpc: "2.0", id: 2, method: "tools/list" },
            { jsonrpc: "2.0", id: 3, method: "tools/list" },
            { jsonrpc: "2.0", id: 4, method: "tools/list" },
        ], { Authorization: "Bearer sr_fake_d", "X-Forwarded-For": "198.51.102.1" });
        assert.equal(batch.status, 429);
        // A key the API accepted is no longer counted once confirmed.
        assert.equal((await call("sr_live_real", "198.51.103.1")).status, 200);
        for (let i = 0; i < 5; i++) assert.equal((await list("sr_live_real", "198.51.103.1")).status, 200);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const entries = logs.filter((entry) => entry.msg === "request");
        assert.ok(entries.some((entry) => entry.key_verified === false && entry.refused === "network_rpc"));
        assert.ok(entries.some((entry) => entry.key_verified === true));
        assert.equal(JSON.stringify(logs).includes("sr_fake"), false);
        assert.equal(JSON.stringify(logs).includes("sr_live_real"), false);
    });

    it("holds every keyed request to the overall in-flight cap, and unconfirmed keys to the network cap", async () => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        let renders = 0;
        const backend = createNodeServer((req, res) => {
            req.resume();
            const ok = req.headers.authorization === "Bearer sr_live_real";
            const answer = () => {
                if (!ok) {
                    res.writeHead(401, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ detail: "Invalid API key" }));
                } else if (req.url === "/api/v1/renders") {
                    res.writeHead(200, { "Content-Type": "application/pdf" });
                    res.end("%PDF-1.4\n%%EOF\n");
                } else {
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end("[]");
                }
            };
            if (req.url !== "/api/v1/renders") {
                answer();
                return;
            }
            // Renders are held until release(), so their requests stay in flight.
            renders++;
            void held.then(answer);
        });
        const apiUrl = await listen(backend);
        closers.push(() => closeServer(backend));
        const { url } = await startMcp(apiUrl, { anonMaxInFlight: 2, anonNetworkMaxInFlight: 1 });
        const headers = (key: string, ip: string) => ({ Authorization: `Bearer ${key}`, "X-Forwarded-For": ip });
        const list = (key: string, ip: string) => postRaw(url, { jsonrpc: "2.0", id: 1, method: "tools/list" }, headers(key, ip));
        const render = (key: string, ip: string) => postRaw(url, {
            jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "render_pdf", arguments: { html: "<p>x</p>" } },
        }, headers(key, ip));

        assert.equal((await rawRpc(url, LIST_TEMPLATES_CALL, headers("sr_live_real", "198.51.100.9"))).status, 200);
        // A made-up key holds its network's one slot...
        const fake = render("sr_fake_1", "198.51.100.1");
        await waitUntil(() => renders === 1);
        // ...and a fresh made-up key from that network is refused,
        const sameNetwork = await list("sr_fake_2", "198.51.100.2");
        assert.equal(sameNetwork.status, 429);
        assert.equal(sameNetwork.headers.get("retry-after"), "5");
        // while a key the API accepted is not held to the network cap.
        assert.equal((await list("sr_live_real", "198.51.100.3")).status, 200);
        const real = render("sr_live_real", "198.51.101.1");
        await waitUntil(() => renders === 2);
        // Two in flight overall: every caller is refused, the confirmed key included.
        const busy = await list("sr_fake_3", "198.51.102.1");
        assert.equal(busy.status, 503);
        assert.equal(busy.headers.get("retry-after"), "5");
        assert.equal((await list("sr_live_real", "198.51.102.2")).status, 503);
        assert.equal(renders, 2, "a refused request never reaches the backend");
        release();
        for (const pending of [fake, real]) {
            const response = await pending;
            assert.equal(response.status, 200);
            await response.text();
        }
        await waitUntil(async () => (await list("sr_fake_4", "198.51.100.4")).status === 200);
    });

    it("counts resources/read and other non-tool messages per network, but not the platforms' traffic", async () => {
        const backend = await fakeBuiltinBackend();
        const { url } = await startAnon(backend.url, { anonRpcPerHour: 3, anonCallsPerHour: 100 });
        const read = (ip: string) => postRaw(url, {
            jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "ui://sheetrender/documents.html" },
        }, { "X-Forwarded-For": ip });
        for (let i = 0; i < 3; i++) assert.equal((await read("198.51.100.1")).status, 200);
        const refused = await read("198.51.100.1");
        assert.equal(refused.status, 429);
        assert.equal(refused.headers.get("retry-after"), "3600");
        assert.equal(
            (await refused.json() as { error: { message: string } }).error.message,
            ANON_TEXT.tooManyNetworkCalls.replace("{minutes}", "60"),
        );
        // The same /24 is the same caller; a batch needs room for every message.
        assert.equal((await read("198.51.100.2")).status, 429);
        assert.equal((await read("198.51.101.2")).status, 200);
        const batch = await postRaw(url, [
            { jsonrpc: "2.0", id: 1, method: "tools/list" },
            { jsonrpc: "2.0", id: 2, method: "tools/list" },
            { jsonrpc: "2.0", id: 3, method: "tools/list" },
        ], { "X-Forwarded-For": "198.51.101.3" });
        assert.equal(batch.status, 429);
        // Tool calls keep their own per-user guard and do not use this bucket up.
        const render = await rawRpc(url, {
            jsonrpc: "2.0", id: 1, method: "tools/call",
            params: { name: "render_documents", arguments: { template: "letter", rows: [{ body: "x" }] } },
        }, { "X-Forwarded-For": "198.51.100.9" });
        assert.equal((render.json as { result: { isError?: boolean } }).result.isError, undefined);
        // ChatGPT's and Claude's egress carry many users each; their tool calls are guarded per user.
        for (let i = 0; i < 5; i++) {
            assert.equal((await read("203.0.113.7")).status, 200, "OpenAI egress");
            assert.equal((await read("160.79.104.7")).status, 200, "Claude egress");
        }
    });

    it("bounds anonymous requests in flight, overall and per network, and frees the slot when one ends", async () => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        let received = 0;
        const backend = createNodeServer((req, res) => {
            req.resume();
            const answer = (body: string) => {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(body);
            };
            if (!req.url?.endsWith("/render")) {
                answer(CATALOGUE_JSON);
                return;
            }
            // Renders are held until release(), so their requests stay in flight.
            received++;
            void held.then(() => answer(JSON.stringify({
                documents: [{ row_index: 0, label: "A", preview_png_url: "/api/previews/x/0.png", pdf_url: "/api/previews/x/0.pdf" }],
                missing_fields: [],
                volume: { used: 1, limit: 50, resets_at: "2026-11-01T00:00:00Z" },
                expires_at: "2026-10-01T14:00:00Z",
            })));
        });
        const apiUrl = await listen(backend);
        closers.push(() => closeServer(backend));
        const { url } = await startAnon(apiUrl, { anonMaxInFlight: 2, anonNetworkMaxInFlight: 1 });
        const render = (ip: string) => postRaw(url, {
            jsonrpc: "2.0", id: 1, method: "tools/call",
            params: { name: "render_documents", arguments: { template: "letter", rows: [{ body: "x" }] } },
        }, { "X-Forwarded-For": ip });
        const first = render("198.51.100.1");
        await waitUntil(() => received === 1);
        // One in flight per /24 network.
        const sameNetwork = await render("198.51.100.2");
        assert.equal(sameNetwork.status, 429);
        assert.equal(sameNetwork.headers.get("retry-after"), "5");
        const second = render("198.51.101.1");
        await waitUntil(() => received === 2);
        // Two in flight overall.
        const busy = await render("198.51.102.1");
        assert.equal(busy.status, 503);
        assert.equal(busy.headers.get("retry-after"), "5");
        assert.equal(received, 2, "a refused request never reaches the backend");
        // A made-up key does not get around either bound.
        const keyedList = (ip: string) => postRaw(url, { jsonrpc: "2.0", id: 1, method: "tools/list" },
            { Authorization: "Bearer sr_test_key", "X-Forwarded-For": ip });
        assert.equal((await keyedList("198.51.100.3")).status, 429);
        assert.equal((await keyedList("198.51.103.1")).status, 503);
        release();
        for (const pending of [first, second]) {
            const response = await pending;
            assert.equal(response.status, 200);
            assert.match(await response.text(), /row_index|documents/i);
        }
        await waitUntil(async () => (await render("198.51.102.1")).status === 200);
    });

    it("keeps reflected credentials out of errors, logs, tool replies and widget HTML", async () => {
        const backend = createNodeServer((_req, res) => {
            res.writeHead(422, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ detail: "Authorization: Bearer sr_live_demo, private rows, invalid input" }));
        });
        const apiUrl = await listen(backend);
        closers.push(() => closeServer(backend));
        const { url, logs } = await startAnon(apiUrl);
        const { json } = await rawRpc(url, {
            jsonrpc: "2.0", id: 1, method: "tools/call",
            params: { name: "render_documents", arguments: { template: "letter", rows: [{ body: "x" }] } },
        });
        const client = await connectAnon(url);
        const widget = await client.readResource({ uri: "ui://sheetrender/documents.html" });
        assert.doesNotMatch(JSON.stringify({ json, logs, widget }), /sr_live_demo|private rows|Authorization: Bearer/);
        assert.equal((json as { result: { isError: boolean } }).result.isError, true);
    });
});

describe("client IP trust boundary", () => {
    const request = (peer: string, xff?: string | string[]) => ({
        socket: { remoteAddress: peer }, headers: { "x-forwarded-for": xff },
    }) as unknown as IncomingMessage;

    it("ignores forwarded addresses from public peers and trusts only the private proxy's final valid IP", () => {
        assert.equal(clientIp(request("203.0.113.4", "160.79.104.1")), "203.0.113.4");
        assert.equal(clientIp(request("::ffff:203.0.113.4", "160.79.104.1")), "::ffff:203.0.113.4");
        assert.equal(clientIp(request("172.18.0.2", "160.79.104.1, 198.51.100.1")), "198.51.100.1");
        assert.equal(clientIp(request("::ffff:172.18.0.2", ["1.2.3.4", "1.2.3.5, 198.51.100.2"])), "198.51.100.2");
        assert.equal(clientIp(request("fd00::1", "2001:db8::1")), "2001:db8::1");
        assert.equal(clientIp(request("172.18.0.2", "160.79.104.1, ")), "172.18.0.2");
        assert.equal(clientIp(request("172.18.0.2", "160.79.104.1, not-an-ip")), "172.18.0.2");
        assert.equal(clientIp(request("172.18.0.2", "160.79.104.999")), "172.18.0.2");
        assert.equal(clientIp(request("172.18.0.2", "::ffff:160.79.104.1")), "160.79.104.1");
    });
});

describe("openai-apps-challenge", () => {
    it("serves the configured token as plain text", async () => {
        const { url } = await startMcp("http://127.0.0.1:1", { openaiAppsChallenge: "challenge-token-123" });
        const response = await fetch(`${url}/.well-known/openai-apps-challenge`);
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type") ?? "", /^text\/plain/);
        assert.equal(await response.text(), "challenge-token-123");
        assert.equal(response.headers.get("cache-control"), "no-store");
        const head = await fetch(`${url}/.well-known/openai-apps-challenge`, { method: "HEAD" });
        assert.equal(head.status, 200);
        assert.equal(await head.text(), "");
        const post = await fetch(`${url}/.well-known/openai-apps-challenge`, { method: "POST" });
        assert.equal(post.status, 405);
    });

    it("404s when no token is configured", async () => {
        const { url } = await startMcp("http://127.0.0.1:1");
        const response = await fetch(`${url}/.well-known/openai-apps-challenge`);
        assert.equal(response.status, 404);
    });
});

describe("loadHttpConfig", () => {
    it("reads the anonymous-mode settings and refuses a demo key that is not an API key", () => {
        const config = loadHttpConfig({
            SHEETRENDER_DEMO_API_KEY: "sr_live_demo",
            MCP_PUBLIC_URL: "https://mcp.sheetrender.com/mcp",
            OPENAI_APPS_CHALLENGE: " tok ",
        } as NodeJS.ProcessEnv);
        assert.equal(config.demoApiKey, "sr_live_demo");
        assert.equal(config.publicUrl, "https://mcp.sheetrender.com/mcp");
        assert.equal(config.openaiAppsChallenge, "tok");
        assert.equal(config.anonCallsPerHour, 30);
        assert.equal(config.claudeCallsPerHour, 3000);
        assert.equal(config.anonNetworkCallsPerHour, 300);
        assert.equal(loadHttpConfig({ CLAUDE_CALLS_PER_HOUR: "6000" }).claudeCallsPerHour, 6000);
        assert.equal(loadHttpConfig({ ANON_NETWORK_CALLS_PER_HOUR: "120" }).anonNetworkCallsPerHour, 120);
        assert.equal(config.anonRpcPerHour, 600);
        assert.equal(config.anonMaxInFlight, 64);
        assert.equal(config.anonNetworkMaxInFlight, 8);
        assert.equal(loadHttpConfig({ ANON_RPC_PER_HOUR: "50" }).anonRpcPerHour, 50);
        assert.equal(loadHttpConfig({ ANON_MAX_IN_FLIGHT: "16" }).anonMaxInFlight, 16);
        assert.equal(loadHttpConfig({ ANON_NETWORK_MAX_IN_FLIGHT: "2" }).anonNetworkMaxInFlight, 2);
        assert.equal(config.largeBodyMaxInFlight, 1);
        assert.equal(loadHttpConfig({ LARGE_BODY_MAX_IN_FLIGHT: "3" }).largeBodyMaxInFlight, 3);
        assert.throws(() => loadHttpConfig({ LARGE_BODY_MAX_IN_FLIGHT: "0" }), /LARGE_BODY_MAX_IN_FLIGHT/);
        for (const value of ["0", "-1", "1.5", "not a number"]) {
            assert.throws(() => loadHttpConfig({ CLAUDE_CALLS_PER_HOUR: value }), /CLAUDE_CALLS_PER_HOUR/);
            assert.throws(() => loadHttpConfig({ ANON_NETWORK_CALLS_PER_HOUR: value }), /ANON_NETWORK_CALLS_PER_HOUR/);
            assert.throws(() => loadHttpConfig({ ANON_MAX_IN_FLIGHT: value }), /ANON_MAX_IN_FLIGHT/);
        }
        const off = loadHttpConfig({} as NodeJS.ProcessEnv);
        assert.equal(off.demoApiKey, undefined);
        assert.throws(() => loadHttpConfig({ SHEETRENDER_DEMO_API_KEY: "nope" } as NodeJS.ProcessEnv), /sr_/);
        assert.throws(() => loadHttpConfig({ MCP_PUBLIC_URL: "not a url" } as NodeJS.ProcessEnv), /MCP_PUBLIC_URL/);
    });

    it("reads OPENAI_EGRESS_CIDRS, defaulting to OpenAI's published list", () => {
        assert.deepEqual(loadHttpConfig({}).openaiEgressCidrs, OPENAI_EGRESS_CIDRS);
        assert.deepEqual(loadHttpConfig({ OPENAI_EGRESS_CIDRS: "  " }).openaiEgressCidrs, OPENAI_EGRESS_CIDRS);
        assert.deepEqual(
            loadHttpConfig({ OPENAI_EGRESS_CIDRS: " 192.0.2.0/24, 198.51.100.7/32\n2001:db8::/32 " }).openaiEgressCidrs,
            ["192.0.2.0/24", "198.51.100.7/32", "2001:db8::/32"],
        );
        assert.deepEqual(loadHttpConfig({ OPENAI_EGRESS_CIDRS: "none" }).openaiEgressCidrs, []);
        // Set at all (even to none), the env list wins and the live refresh stays off.
        assert.equal(loadHttpConfig({}).openaiEgressFromEnv, false);
        assert.equal(loadHttpConfig({ OPENAI_EGRESS_CIDRS: "  " }).openaiEgressFromEnv, false);
        assert.equal(loadHttpConfig({ OPENAI_EGRESS_CIDRS: "none" }).openaiEgressFromEnv, true);
        assert.equal(loadHttpConfig({ OPENAI_EGRESS_CIDRS: "192.0.2.0/24" }).openaiEgressFromEnv, true);
        for (const value of ["192.0.2.1", "192.0.2.0/24, nope/8", "10.0.0.0/33"]) {
            assert.throws(() => loadHttpConfig({ OPENAI_EGRESS_CIDRS: value }), /OPENAI_EGRESS_CIDRS/, value);
        }
    });
});

describe("UntrustedSubjectTally", () => {
    it("logs the first one at once, then a count at most hourly, and nothing for a quiet hour", () => {
        const logs: LogEntry[] = [];
        let now = 0;
        const tally = new UntrustedSubjectTally((entry) => logs.push(entry), () => now);
        tally.flush();
        assert.equal(logs.length, 0);
        tally.note();
        tally.note();
        assert.deepEqual(logs.map((entry) => entry.count), [1]);
        now += 30 * 60 * 1000;
        tally.flush();
        assert.equal(logs.length, 1);
        now += 30 * 60 * 1000;
        tally.flush();
        assert.deepEqual(logs.map((entry) => entry.count), [1, 1]);
        now += 2 * 60 * 60 * 1000;
        tally.flush();
        assert.equal(logs.length, 2);
    });
});

describe("VerifiedKeys", () => {
    it("remembers an accepted key until its time runs out, renewed by each acceptance", () => {
        let now = 0;
        const keys = new VerifiedKeys(1000, 10, () => now);
        assert.equal(keys.has("sr_live_a"), false);
        keys.add("sr_live_a");
        now = 900;
        assert.equal(keys.has("sr_live_a"), true);
        keys.add("sr_live_a");
        now = 1800;
        assert.equal(keys.has("sr_live_a"), true);
        now = 1900;
        assert.equal(keys.has("sr_live_a"), false);
        assert.equal(keys.size, 0);
    });

    it("keeps at most its limit, dropping the least recently accepted", () => {
        const keys = new VerifiedKeys(60_000, 2);
        keys.add("sr_live_a");
        keys.add("sr_live_b");
        keys.add("sr_live_a");
        keys.add("sr_live_c");
        assert.equal(keys.size, 2);
        assert.equal(keys.has("sr_live_b"), false);
        assert.equal(keys.has("sr_live_a"), true);
        assert.equal(keys.has("sr_live_c"), true);
    });
});

const OAUTH_TOKEN = `sro_${"a".repeat(43)}`;
const FAKE_OAUTH_TOKEN = `sro_${"f".repeat(43)}`;
const OAUTH_OPTIONS = {
    oauthIssuer: "https://staging.sheetrender.test",
    introspectSecret: "test-introspection-secret-keep-out-of-logs",
    publicUrl: "https://mcp.staging.sheetrender.test/mcp",
    demoApiKey: "sr_live_demo",
};
const SIGN_IN_CHALLENGE = `Bearer resource_metadata="https://mcp.staging.sheetrender.test${PROTECTED_RESOURCE_PATH}", scope="profile render design jobs", error="invalid_token", error_description="Requires a signed-in SheetRender account."`;
const OAUTH_HEADERS = { Authorization: `Bearer ${OAUTH_TOKEN}` };
const TOOLS_LIST = { jsonrpc: "2.0", id: 1, method: "tools/list" };
const PROFILE_CALL = { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "get_profile", arguments: {} } };

interface OAuthBackendState {
    mode: "active" | "inactive" | "down" | "wrong-audience";
    scope: string;
    holdIntrospection?: Promise<void>;
    holdSchedules?: Promise<void>;
}

/** Serves the fixed introspection contract and just the public routes these tests call. */
async function oauthBackend() {
    const state: OAuthBackendState = { mode: "active", scope: "profile render design jobs" };
    const calls: { method: string; path: string; auth: string; body: unknown }[] = [];
    const profile = { id: "account-uuid", name: "Ada" as string | null, email: "ada@example.test" as string | null };
    const schedule = {
        id: "schedule-1", template_id: "tpl_1", template_name: "Letter", dataset_id: "ds_1", dataset_name: "rows",
        name: "Weekly letters", cadence: "weekly", hour_utc: 9, weekday: 0, day_of_month: null,
        enabled: true, paused_reason: null, delivery_email: null, next_run_at: "2026-10-05T09:00:00Z",
        last_run_at: null, created_at: "2026-10-02T12:00:00Z",
    };
    const server = createNodeServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const path = req.url ?? "";
            const raw = Buffer.concat(chunks).toString("utf8");
            const body: unknown = path === "/api/oauth/introspect" ? new URLSearchParams(raw).get("token") : raw ? JSON.parse(raw) : undefined;
            calls.push({ method: req.method ?? "", path, auth: req.headers.authorization ?? "", body });
            const answer = (status: number, payload: unknown) => {
                res.writeHead(status, { "Content-Type": "application/json" });
                res.end(JSON.stringify(payload));
            };
            void (async () => {
                if (path === "/api/oauth/introspect") {
                    assert.match(req.headers["content-type"] ?? "", /^application\/x-www-form-urlencoded/);
                    if (req.headers.authorization !== `Bearer ${OAUTH_OPTIONS.introspectSecret}`) return answer(401, {});
                    await state.holdIntrospection;
                    if (state.mode === "down") return answer(503, { detail: `${OAUTH_TOKEN} ${OAUTH_OPTIONS.introspectSecret}` });
                    if (state.mode === "inactive" || body !== OAUTH_TOKEN) return answer(200, { active: false });
                    return answer(200, {
                        active: true, scope: state.scope, client_id: "test-client", sub: profile.id,
                        aud: [state.mode === "wrong-audience" ? "https://other.test/mcp" : OAUTH_OPTIONS.publicUrl, `${OAUTH_OPTIONS.oauthIssuer}/api`],
                        exp: Math.floor(Date.now() / 1000) + 3600, token_type: "Bearer",
                    });
                }
                if (path === "/api/v1/builtin-templates") return answer(200, JSON.parse(CATALOGUE_JSON));
                if (path === "/api/v1/builtin-templates/letter/render") {
                    assert.equal(req.headers.authorization, "Bearer sr_live_demo");
                    return answer(200, { documents: [], volume: { used: 1, limit: 50, resets_at: null } });
                }
                if (![ `Bearer ${OAUTH_TOKEN}`, "Bearer sr_live_real" ].includes(req.headers.authorization ?? "")) {
                    return answer(401, { detail: "Invalid credential" });
                }
                if (state.mode === "inactive" && req.headers.authorization === `Bearer ${OAUTH_TOKEN}`) {
                    return answer(401, { detail: "Invalid credential" });
                }
                if (path === "/api/v1/templates") return answer(200, []);
                if (path === "/api/v1/me") return answer(200, profile);
                if (path === "/api/v1/schedules") {
                    await state.holdSchedules;
                    return answer(req.method === "POST" ? 201 : 200, req.method === "POST" ? schedule : [schedule]);
                }
                answer(404, { detail: "Not Found" });
            })();
        });
    });
    const url = await listen(server);
    closers.push(() => closeServer(server));
    return { url, calls, state, profile, schedule };
}

describe("hosted OAuth", () => {
    it("serves both protected-resource documents with credentialless CORS and no header-derived hosts", async () => {
        const { url } = await startMcp("http://127.0.0.1:1", OAUTH_OPTIONS);
        const origin = "https://browser-client.test";
        const assertCors = (response: Response) => {
            assert.equal(response.headers.get("access-control-allow-origin"), "*");
            assert.equal(response.headers.get("access-control-allow-methods"), "GET, HEAD, OPTIONS");
            assert.equal(response.headers.has("access-control-allow-credentials"), false);
            assert.equal(response.headers.has("set-cookie"), false);
        };
        for (const path of [PROTECTED_RESOURCE_PATH, "/.well-known/oauth-protected-resource"]) {
            const response = await fetch(`${url}${path}`, { headers: { Origin: origin, "X-Forwarded-Host": "attacker.test" } });
            assert.equal(response.status, 200);
            assertCors(response);
            assert.deepEqual(await response.json(), {
                resource: OAUTH_OPTIONS.publicUrl,
                authorization_servers: [OAUTH_OPTIONS.oauthIssuer],
                scopes_supported: ["profile", "render", "design", "jobs"],
                bearer_methods_supported: ["header"],
            });
            const head = await fetch(`${url}${path}`, { method: "HEAD", headers: { Origin: origin } });
            assert.equal(head.status, 200);
            assertCors(head);
            assert.equal(await head.text(), "");
            const preflight = await fetch(`${url}${path}`, {
                method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "GET" },
            });
            assert.equal(preflight.status, 204);
            assertCors(preflight);
            assert.equal(await preflight.text(), "");
            const rejected = await fetch(`${url}${path}`, { method: "POST", headers: { Origin: origin } });
            assert.equal(rejected.status, 405);
            assert.equal(rejected.headers.get("allow"), "GET, HEAD, OPTIONS");
            assertCors(rejected);
            await rejected.text();
        }
        for (const path of ["/healthz", "/mcp"]) {
            const response = await fetch(`${url}${path}`, { method: "OPTIONS", headers: { Origin: origin } });
            assert.equal(response.status, 405);
            assert.equal(response.headers.has("access-control-allow-origin"), false);
            await response.text();
        }
        const config = loadHttpConfig({
            OAUTH_ISSUER: OAUTH_OPTIONS.oauthIssuer,
            MCP_INTROSPECT_SECRET: OAUTH_OPTIONS.introspectSecret,
            MCP_PUBLIC_URL: OAUTH_OPTIONS.publicUrl,
        });
        assert.equal(config.oauthIssuer, OAUTH_OPTIONS.oauthIssuer);
        assert.equal(config.introspectSecret, OAUTH_OPTIONS.introspectSecret);
    });

    it("keeps the old registry and rejection behavior whenever either OAuth setting is absent", async () => {
        for (const settings of [{ oauthIssuer: undefined }, { introspectSecret: undefined }]) {
            const { url } = await startMcp("http://127.0.0.1:1", { ...OAUTH_OPTIONS, ...settings });
            for (const path of [PROTECTED_RESOURCE_PATH, "/.well-known/oauth-protected-resource"]) {
                for (const method of ["GET", "OPTIONS"]) {
                    const response = await fetch(`${url}${path}`, { method, headers: { Origin: "https://browser-client.test" } });
                    assert.equal(response.status, 404);
                    assert.equal(response.headers.has("access-control-allow-origin"), false);
                    await response.text();
                }
            }
            const anon = await connectAnon(url);
            assert.deepEqual((await anon.listTools()).tools.map((tool) => tool.name).sort(), [
                "create_continue_link", "list_document_templates", "render_documents",
            ]);
            const refused = await rawRpc(url, PROFILE_CALL, OAUTH_HEADERS);
            assert.equal(refused.status, 401);
            assert.equal(refused.headers.get("www-authenticate"), 'Bearer realm="sheetrender"');
            const keyed = await connect(url, "sr_live_real");
            assert.ok((await keyed.listTools()).tools.some((tool) => tool.name === "render_pdf"));
        }
    });

    it("challenges every account tool before the SDK, preserving the request id and all four scopes", async () => {
        const backend = await oauthBackend();
        const { url } = await startMcp(backend.url, OAUTH_OPTIONS);
        for (const name of Object.keys(PROTECTED_TOOL_SCOPES)) {
            const response = await rawRpc(url, { ...PROFILE_CALL, params: { name, arguments: {} } }, { "User-Agent": "Claude" });
            assert.equal(response.status, 401, name);
            assert.equal(response.headers.get("www-authenticate"), SIGN_IN_CHALLENGE);
            const body = response.json as { id: number; error: { code: number; data: { error: string } } };
            assert.equal(body.id, PROFILE_CALL.id);
            assert.equal(body.error.code, -32001);
            assert.equal(body.error.data.error, "invalid_token");
        }
        assert.equal(backend.calls.length, 0);
    });

    it("returns ChatGPT's tool error for metadata or User-Agent, without trusting either or a session id", async () => {
        const backend = await oauthBackend();
        const { url } = await startMcp(backend.url, OAUTH_OPTIONS);
        for (const caller of [
            { meta: { "openai/subject": "forged" }, agent: "Claude" },
            { meta: {}, agent: "ChatGPT/1.0" },
        ]) {
            const response = await rawRpc(url, { ...PROFILE_CALL, params: { ...PROFILE_CALL.params, _meta: caller.meta } }, {
                "User-Agent": caller.agent, "Mcp-Session-Id": "forged-session", "X-Forwarded-For": "198.51.100.1",
            });
            assert.equal(response.status, 200);
            const body = response.json as { id: number; result: { isError: boolean; _meta: Record<string, unknown> } };
            assert.equal(body.id, PROFILE_CALL.id);
            assert.equal(body.result.isError, true);
            assert.deepEqual(body.result._meta["mcp/www_authenticate"], [SIGN_IN_CHALLENGE]);
        }
        assert.equal(backend.calls.length, 0);
    });

    it("returns insufficient_scope as HTTP 403 or ChatGPT metadata, without calling the protected API", async () => {
        const backend = await oauthBackend();
        backend.state.scope = "render";
        const { url } = await startMcp(backend.url, OAUTH_OPTIONS);
        const response = await rawRpc(url, PROFILE_CALL, OAUTH_HEADERS);
        assert.equal(response.status, 403);
        assert.match(response.headers.get("www-authenticate") ?? "", /error="insufficient_scope", scope="profile"/);
        assert.equal((response.json as { error: { data: { error: string } } }).error.data.error, "insufficient_scope");
        const chatgpt = await rawRpc(url, { ...PROFILE_CALL, params: { name: "list_schedules", arguments: {}, _meta: { "openai/locale": "en" } } }, OAUTH_HEADERS);
        assert.equal(chatgpt.status, 200);
        const result = (chatgpt.json as { result: { isError: boolean; _meta: Record<string, string[]> } }).result;
        assert.equal(result.isError, true);
        assert.deepEqual(result._meta["mcp/www_authenticate"], [
            `Bearer resource_metadata="https://mcp.staging.sheetrender.test${PROTECTED_RESOURCE_PATH}", error="insufficient_scope", scope="jobs", error_description="SheetRender sign-in needs the jobs scope for this tool."`,
        ]);
        assert.equal(backend.calls.length, 1);
        assert.equal(backend.calls[0].path, "/api/oauth/introspect");
        assert.equal((await rawRpc(url, LIST_TEMPLATES_CALL, OAUTH_HEADERS)).status, 200);
    });

    it("keeps all 15 tool definitions identical before and after sign-in and declares their scopes", async () => {
        const backend = await oauthBackend();
        const { url } = await startMcp(backend.url, OAUTH_OPTIONS);
        type Tool = { name: string; description: string; securitySchemes: unknown; _meta: Record<string, unknown>; annotations: { readOnlyHint: boolean; destructiveHint: boolean } };
        const listing = async (headers: Record<string, string>) => {
            const result = await rawRpc(url, TOOLS_LIST, headers);
            assert.equal(result.status, 200);
            return (result.json as { result: { tools: Tool[] } }).result.tools;
        };
        const before = await listing({});
        assert.deepEqual(await listing(OAUTH_HEADERS), before);
        assert.deepEqual(await listing({ Authorization: `Bearer ${FAKE_OAUTH_TOKEN}` }), before);
        assert.equal(backend.calls.length, 0, "discovery must not depend on introspection");
        await rawRpc(url, PROFILE_CALL, OAUTH_HEADERS);
        assert.deepEqual(await listing(OAUTH_HEADERS), before);
        backend.state.mode = "down";
        assert.deepEqual(await listing({ Authorization: `Bearer ${FAKE_OAUTH_TOKEN}` }), before);
        assert.deepEqual(before.map((tool) => tool.name).sort(), [
            ...Object.keys(PROTECTED_TOOL_SCOPES), "list_document_templates", "render_documents", "create_continue_link",
        ].sort());
        for (const tool of before) {
            const scope = PROTECTED_TOOL_SCOPES[tool.name as keyof typeof PROTECTED_TOOL_SCOPES];
            assert.deepEqual(tool.securitySchemes, scope ? [{ type: "oauth2", scopes: [scope] }] : [{ type: "noauth" }]);
            assert.deepEqual(tool._meta.securitySchemes, tool.securitySchemes);
            if (scope) assert.ok(tool.description.startsWith("Requires a signed-in SheetRender account."));
            assert.equal(typeof tool.annotations.readOnlyHint, "boolean");
            assert.equal(tool.annotations.destructiveHint, false);
            assert.equal(BANNED_WORDS.test(tool.description), false, tool.name);
        }
        assert.equal(before.find((tool) => tool.name === "get_profile")?._meta["openai/profile"], true);
        for (const text of Object.values(describeTools(true, true))) assert.equal(BANNED_WORDS.test(text), false);
        for (const name of ["render_pdf", "upload_dataset"]) {
            const denied = await rawRpc(url, { ...PROFILE_CALL, params: { name, arguments: {} } }, OAUTH_HEADERS);
            assert.equal((denied.json as { result: { isError: boolean } }).result.isError, true);
        }
        assert.deepEqual(backend.calls.filter((entry) => entry.path !== "/api/oauth/introspect").map((entry) => entry.path), ["/api/v1/me"]);
    });

    it("forwards the OAuth bearer to profile and schedule endpoints and preserves schedule fields", async () => {
        const backend = await oauthBackend();
        const { url } = await startMcp(backend.url, OAUTH_OPTIONS);
        const client = await connect(url, OAUTH_TOKEN);
        const profile = await client.callTool({ name: "get_profile", arguments: {} });
        assert.deepEqual(profile.structuredContent, backend.profile);
        backend.profile.name = null;
        backend.profile.email = null;
        const unnamed = await client.callTool({ name: "get_profile", arguments: {} });
        assert.deepEqual(unnamed.structuredContent, backend.profile);
        const input = { template_id: "tpl_1", dataset_id: "ds_1", cadence: "weekly", name: "Weekly letters", hour_utc: 17, weekday: 4, delivery_email: "ada@example.test" };
        const created = await client.callTool({ name: "create_schedule", arguments: input });
        assert.deepEqual(created.structuredContent, backend.schedule);
        const listed = await client.callTool({ name: "list_schedules", arguments: {} });
        assert.deepEqual(listed.structuredContent, { schedules: [backend.schedule] });
        assert.deepEqual(backend.calls.filter((entry) => entry.path !== "/api/oauth/introspect"), [
            { method: "GET", path: "/api/v1/me", auth: `Bearer ${OAUTH_TOKEN}`, body: undefined },
            { method: "GET", path: "/api/v1/me", auth: `Bearer ${OAUTH_TOKEN}`, body: undefined },
            { method: "POST", path: "/api/v1/schedules", auth: `Bearer ${OAUTH_TOKEN}`, body: input },
            { method: "GET", path: "/api/v1/schedules", auth: `Bearer ${OAUTH_TOKEN}`, body: undefined },
        ]);
        assert.equal(backend.calls.filter((entry) => entry.path === "/api/oauth/introspect").length, 1);
        for (const patch of [{ cadence: "never" }, { hour_utc: 24 }, { weekday: 7 }, { day_of_month: 0 }, { recipient_column: "email" }]) {
            const invalid = await client.callTool({ name: "create_schedule", arguments: { ...input, ...patch } });
            assert.equal(invalid.isError, true);
        }
        assert.equal(backend.calls.filter((entry) => entry.method === "POST" && entry.path === "/api/v1/schedules").length, 1);
    });

    it("honors API re-validation of the forwarded bearer even while positive introspection is cached", async () => {
        const backend = await oauthBackend();
        const now = Date.now();
        const { url } = await startMcp(backend.url, { ...OAUTH_OPTIONS, now: () => now });
        const client = await connect(url, OAUTH_TOKEN);
        const first = await client.callTool({ name: "get_profile", arguments: {} });
        assert.deepEqual(first.structuredContent, backend.profile);
        backend.state.mode = "inactive";
        const revoked = await client.callTool({ name: "get_profile", arguments: {} });
        assert.equal(revoked.isError, true);
        assert.equal(revoked.structuredContent, undefined);
        assert.equal(backend.calls.filter((entry) => entry.path === "/api/oauth/introspect").length, 1);
        const forwarded = backend.calls.filter((entry) => entry.path !== "/api/oauth/introspect");
        assert.deepEqual(forwarded.map((entry) => [entry.path, entry.auth]), [
            ["/api/v1/me", `Bearer ${OAUTH_TOKEN}`],
            ["/api/v1/me", `Bearer ${OAUTH_TOKEN}`],
        ]);
    });

    it("fails closed when introspection goes down after cache expiry and keeps tokens out of logs", async () => {
        const backend = await oauthBackend();
        let now = Date.now();
        const { url, logs } = await startMcp(backend.url, { ...OAUTH_OPTIONS, now: () => now });
        assert.equal((await rawRpc(url, PROFILE_CALL, OAUTH_HEADERS)).status, 200);
        backend.state.mode = "down";
        now += 59_999;
        assert.equal((await rawRpc(url, PROFILE_CALL, OAUTH_HEADERS)).status, 200);
        now++;
        const failed = await rawRpc(url, PROFILE_CALL, OAUTH_HEADERS);
        assert.equal(failed.status, 503);
        assert.equal(failed.headers.get("retry-after"), "5");
        assert.match(JSON.stringify(failed.json), /temporarily unavailable/);
        assert.equal(backend.calls.filter((entry) => entry.path === "/api/v1/me").length, 2);
        backend.state.mode = "active";
        assert.equal((await rawRpc(url, PROFILE_CALL, OAUTH_HEADERS)).status, 200);
        const reflectedName = { ...PROFILE_CALL, params: { name: OAUTH_TOKEN, arguments: {} } };
        await rawRpc(url, reflectedName, OAUTH_HEADERS);
        await waitUntil(() => logs.some((entry) => entry.refused === "introspection_unavailable"));
        for (const secret of [OAUTH_TOKEN, OAUTH_OPTIONS.introspectSecret]) {
            assert.equal(JSON.stringify({ logs, error: failed.json }).includes(secret), false);
        }
    });

    it("rejects inactive and wrong-audience tokens, and never accepts forged identity metadata", async () => {
        for (const mode of ["inactive", "wrong-audience"] as const) {
            const backend = await oauthBackend();
            backend.state.mode = mode;
            const { url } = await startMcp(backend.url, OAUTH_OPTIONS);
            const denied = await rawRpc(url, PROFILE_CALL, { ...OAUTH_HEADERS, "Mcp-Session-Id": "known-user" });
            assert.equal(denied.status, 401);
            assert.equal(backend.calls.length, 1);
            assert.equal(backend.calls[0].path, "/api/oauth/introspect");
        }
    });

    it("keeps fake tokens under anonymous body and batch limits, lifting only cached active tokens", async () => {
        const backend = await oauthBackend();
        let now = Date.now();
        const { url } = await startMcp(backend.url, { ...OAUTH_OPTIONS, now: () => now });
        const large = { ...TOOLS_LIST, params: { _meta: { padding: "x".repeat(MAX_ANON_BODY_BYTES) } } };
        const fake = { Authorization: `Bearer ${FAKE_OAUTH_TOKEN}` };
        const batch = Array.from({ length: MAX_ANON_BATCH + 1 }, (_, id) => ({ ...TOOLS_LIST, id }));
        const callers: Record<string, string>[] = [{}, fake, OAUTH_HEADERS];
        for (const headers of callers) {
            assert.equal((await postRaw(url, large, headers)).status, 413);
            assert.equal((await postRaw(url, batch, headers)).status, 400);
        }
        assert.equal(backend.calls.length, 0, "admission runs before introspection");
        assert.equal((await rawRpc(url, PROFILE_CALL, fake)).status, 401);
        assert.equal((await postRaw(url, large, fake)).status, 413);
        await rawRpc(url, PROFILE_CALL, OAUTH_HEADERS);
        const accepted = await postRaw(url, large, OAUTH_HEADERS);
        assert.equal(accepted.status, 200);
        await accepted.text();
        const acceptedBatch = await postRaw(url, batch, OAUTH_HEADERS);
        assert.equal(acceptedBatch.status, 200);
        await acceptedBatch.text();
        assert.equal((await postRaw(url, Array.from({ length: MAX_KEYED_BATCH + 1 }, (_, id) => ({ ...TOOLS_LIST, id })), OAUTH_HEADERS)).status, 400);
        now += 60_000;
        assert.equal((await postRaw(url, large, OAUTH_HEADERS)).status, 413, "API success must not extend OAuth cache life");
    });

    it("charges rotating fake tokens and protected keyless calls to network budgets before introspection", async () => {
        const backend = await oauthBackend();
        const { url } = await startMcp(backend.url, { ...OAUTH_OPTIONS, anonRpcPerHour: 2 });
        for (let i = 0; i < 2; i++) {
            const result = await rawRpc(url, PROFILE_CALL, { Authorization: `Bearer sro_${String(i).repeat(43)}`, "X-Forwarded-For": "198.51.100.1" });
            assert.equal(result.status, 401);
        }
        const refused = await rawRpc(url, PROFILE_CALL, { Authorization: `Bearer ${FAKE_OAUTH_TOKEN}`, "X-Forwarded-For": "198.51.100.2" });
        assert.equal(refused.status, 429);
        assert.equal(backend.calls.length, 2);
        assert.equal((await rawRpc(url, PROFILE_CALL, { "X-Forwarded-For": "198.51.100.3" })).status, 429);
        const real = { ...OAUTH_HEADERS, "X-Forwarded-For": "198.51.101.1" };
        assert.equal((await rawRpc(url, PROFILE_CALL, real)).status, 200);
        for (let i = 0; i < 4; i++) assert.equal((await rawRpc(url, TOOLS_LIST, real)).status, 200);
    });

    it("bounds introspection in flight and keeps active callers under the global cap", async () => {
        const backend = await oauthBackend();
        let release!: () => void;
        backend.state.holdIntrospection = new Promise<void>((resolve) => { release = resolve; });
        const { url } = await startMcp(backend.url, { ...OAUTH_OPTIONS, anonMaxInFlight: 2, anonNetworkMaxInFlight: 1 });
        const first = rawRpc(url, PROFILE_CALL, { ...OAUTH_HEADERS, "X-Forwarded-For": "198.51.100.1" });
        try {
            await waitUntil(() => backend.calls.length === 1);
            assert.equal((await rawRpc(url, TOOLS_LIST, { "X-Forwarded-For": "198.51.100.2" })).status, 429);
            const second = rawRpc(url, PROFILE_CALL, { Authorization: `Bearer ${FAKE_OAUTH_TOKEN}`, "X-Forwarded-For": "198.51.101.1" });
            await waitUntil(() => backend.calls.length === 2);
            assert.equal((await rawRpc(url, TOOLS_LIST, { "X-Forwarded-For": "198.51.102.1" })).status, 503);
            release();
            assert.equal((await first).status, 200);
            assert.equal((await second).status, 401);
        } finally { release(); }
        let finish!: () => void;
        backend.state.holdSchedules = new Promise<void>((resolve) => { finish = resolve; });
        const scheduleCall = { ...PROFILE_CALL, params: { name: "list_schedules", arguments: {} } };
        const activeCalls = [rawRpc(url, scheduleCall, OAUTH_HEADERS), rawRpc(url, scheduleCall, OAUTH_HEADERS)];
        try {
            await waitUntil(() => backend.calls.filter((entry) => entry.path === "/api/v1/schedules").length === 2);
            assert.equal((await rawRpc(url, TOOLS_LIST, OAUTH_HEADERS)).status, 503);
        } finally { finish(); }
        for (const pending of activeCalls) assert.equal((await pending).status, 200);
    });

    it("keeps demo credentials, the widget and per-subject limits on anonymous tools with an active token", async () => {
        const backend = await oauthBackend();
        const { url } = await startMcp(backend.url, { ...OAUTH_OPTIONS, anonCallsPerHour: 1 });
        const client = await connect(url, OAUTH_TOKEN);
        assert.notEqual((await client.callTool({ name: "get_profile", arguments: {} })).isError, true);
        backend.state.mode = "down";
        const first = await client.callTool({ name: "render_documents", arguments: { template: "letter", rows: [{ body: "hello" }] } });
        assert.notEqual(first.isError, true);
        const second = await client.callTool({ name: "render_documents", arguments: { template: "letter", rows: [{ body: "again" }] } });
        assert.equal(second.isError, true);
        assert.equal(backend.calls.filter((entry) => entry.path === "/api/v1/builtin-templates/letter/render").length, 1);
        assert.ok(backend.calls.filter((entry) => entry.path.startsWith("/api/v1/builtin-templates")).every((entry) => entry.auth === "Bearer sr_live_demo"));
        const widget = await client.readResource({ uri: "ui://sheetrender/documents.html" });
        assert.equal(widget.contents[0].mimeType, "text/html;profile=mcp-app");
    });

    it("preserves the API-key path with OAuth enabled and never introspects API keys", async () => {
        const backend = await oauthBackend();
        const { url } = await startMcp(backend.url, OAUTH_OPTIONS);
        const client = await connect(url, "sr_live_real");
        const names = (await client.listTools()).tools.map((tool) => tool.name);
        assert.ok(names.includes("render_pdf"));
        assert.equal(names.includes("get_profile"), false);
        assert.equal(names.includes("render_documents"), false);
        const result = await client.callTool({ name: "list_templates", arguments: {} });
        assert.notEqual(result.isError, true);
        assert.deepEqual(backend.calls.map((entry) => [entry.path, entry.auth]), [["/api/v1/templates", "Bearer sr_live_real"]]);
        const refused = await rawRpc(url, LIST_TEMPLATES_CALL, { Authorization: "Bearer sr_fake_key" });
        assert.equal(refused.status, 200);
        assert.equal((refused.json as { result: { isError: boolean } }).result.isError, true);
    });

    it("preflights a whole batch so an unauthenticated account call cannot execute alongside demo work", async () => {
        const backend = await oauthBackend();
        const { url } = await startMcp(backend.url, OAUTH_OPTIONS);
        const response = await postRaw(url, [
            { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "render_documents", arguments: { template: "letter", rows: [{ body: "hello" }] } } },
            PROFILE_CALL,
        ]);
        assert.equal(response.status, 401);
        assert.equal(backend.calls.length, 0);
        const chatgpt = await postRaw(url, [TOOLS_LIST, PROFILE_CALL], { "User-Agent": "ChatGPT" });
        assert.equal(chatgpt.status, 200);
        const results = await chatgpt.json() as { id: number; result: { isError: boolean; _meta: Record<string, string[]> } }[];
        assert.deepEqual(results.map((result) => result.id), [TOOLS_LIST.id, PROFILE_CALL.id]);
        assert.ok(results.every((result) => result.result.isError));
        assert.deepEqual(results[1].result._meta["mcp/www_authenticate"], [SIGN_IN_CHALLENGE]);
        assert.equal(backend.calls.length, 0);
    });
});
