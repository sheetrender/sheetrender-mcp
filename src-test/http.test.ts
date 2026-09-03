import assert from "node:assert/strict";
import { createServer as createNodeServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { bearerToken, createHttpServer, keyFingerprint, type LogEntry } from "../src/http.js";

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
    extra: { maxBodyBytes?: number } = {},
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

    it("404s anything that is not /mcp or /healthz", async () => {
        const { url } = await startMcp("http://127.0.0.1:1");
        const response = await fetch(`${url}/`);
        assert.equal(response.status, 404);
    });
});
