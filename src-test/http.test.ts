import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createNodeServer, type IncomingMessage, type Server } from "node:http";
import { connect as connectSocket, type AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ClientRequestSchema, JSONRPCRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { CidrSet, MAX_ANON_BODY_BYTES, OPENAI_EGRESS_CIDRS } from "../src/anon.js";
import { ANON_TEXT } from "../src/anon-descriptions.js";
import {
    bearerToken,
    clientIp,
    createHttpServer,
    keyFingerprint,
    loadHttpConfig,
    newSessionId,
    UntrustedSubjectTally,
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

async function startMcp(
    apiUrl: string,
    extra: { maxBodyBytes?: number; openaiAppsChallenge?: string } = {},
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
        assert.equal(entry.subject_fp, createHash("sha256").update("subject-xyz").digest("hex").slice(0, 12));
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

    it("caps anonymous HTTP bodies at 2 MB while preserving the API-key body cap", async () => {
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
        const keyed = await rawRpc(url, overLimit, { Authorization: "Bearer sr_test_key" });
        assert.equal(keyed.status, 200);
        const names = (keyed.json as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name);
        assert.ok(names.includes("render_pdf"));
        assert.ok(!names.includes("render_documents"));
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
        // API-key callers keep the SDK's batching as before.
        const listTools = Array.from({ length: 50 }, (_, index) => ({ jsonrpc: "2.0", id: index + 1, method: "tools/list" }));
        const keyed = await postRaw(url, listTools, { Authorization: "Bearer sr_test_key" });
        assert.equal(keyed.status, 200);
        assert.equal(events(await keyed.text()), 50);
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
        // API-key callers are not counted.
        assert.equal((await postRaw(url, { jsonrpc: "2.0", id: 1, method: "tools/list" },
            { Authorization: "Bearer sr_test_key" })).status, 200);
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
