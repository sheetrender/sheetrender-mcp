import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
    authFailureResponse,
    authorizeTool,
    IntrospectionUnavailable,
    isChatGptCall,
    oauthConfig,
    OAUTH_CACHE_MS,
    OAUTH_NEGATIVE_CACHE_MS,
    protectedResourceMetadata,
    TokenIntrospector,
    tokenHash,
    type OAuthConfig,
} from "../src/auth.js";

const TOKEN = `sro_${"a".repeat(43)}`;
const OTHER = `sro_${"b".repeat(43)}`;
const CONFIG: OAuthConfig = {
    issuer: "https://staging.sheetrender.test",
    secret: "introspection-secret-for-tests",
    resource: "https://mcp.staging.sheetrender.test/mcp",
    metadataUrl: "https://mcp.staging.sheetrender.test/.well-known/oauth-protected-resource/mcp",
};

function active(now = 0) {
    return {
        active: true, scope: "profile render design jobs", client_id: "test-client", sub: "account-id",
        aud: [CONFIG.resource, `${CONFIG.issuer}/api`], exp: now / 1000 + 3600, token_type: "access_token",
    };
}

function response(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const call = (name: string, meta?: Record<string, unknown>) => ({
    jsonrpc: "2.0", id: 42, method: "tools/call", params: { name, arguments: {}, _meta: meta },
});

describe("OAuth configuration and discovery", () => {
    it("requires both issuer and secret, and validates the public URL only when enabled", () => {
        assert.equal(oauthConfig({}), undefined);
        assert.equal(oauthConfig({ oauthIssuer: "not configured yet" }), undefined);
        assert.equal(oauthConfig({ introspectSecret: CONFIG.secret }), undefined);
        assert.throws(() => oauthConfig({ oauthIssuer: CONFIG.issuer, introspectSecret: CONFIG.secret }), /MCP_PUBLIC_URL/);
        for (const issuer of ["invalid", "file:///secret", "https://user:pass@example.test", "https://example.test/api"]) {
            assert.throws(() => oauthConfig({ oauthIssuer: issuer, introspectSecret: CONFIG.secret, publicUrl: CONFIG.resource }), /OAUTH_ISSUER/);
        }
        const config = oauthConfig({ oauthIssuer: `${CONFIG.issuer}/`, introspectSecret: CONFIG.secret, publicUrl: CONFIG.resource });
        assert.deepEqual(config, CONFIG);
        assert.deepEqual(protectedResourceMetadata(config!), {
            resource: CONFIG.resource,
            authorization_servers: [CONFIG.issuer],
            scopes_supported: ["profile", "render", "design", "jobs"],
            bearer_methods_supported: ["header"],
        });
    });
});

describe("token introspection", () => {
    it("uses the fixed form request and secret, caches for 60 seconds, and uses only hashed keys", async (t) => {
        let now = 0;
        const requests: Request[] = [];
        const keys: unknown[] = [];
        const original = Map.prototype.set;
        const spy = t.mock.method(Map.prototype, "set", function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
            keys.push(key);
            return original.call(this, key, value);
        });
        const introspector = new TokenIntrospector("https://api.test/", CONFIG, {
            now: () => now,
            fetch: async (input, init) => {
                requests.push(new Request(input, init));
                assert.equal(init?.redirect, "error");
                assert.ok(init?.signal);
                return response(active(now));
            },
        });
        assert.equal(introspector.peek(TOKEN), undefined);
        const [first, concurrent] = await Promise.all([introspector.introspect(TOKEN), introspector.introspect(TOKEN)]);
        assert.deepEqual(first, concurrent);
        assert.equal(first.active, true);
        await introspector.introspect(TOKEN);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].url, "https://api.test/api/oauth/introspect");
        assert.equal(requests[0].method, "POST");
        assert.equal(requests[0].headers.get("authorization"), `Bearer ${CONFIG.secret}`);
        assert.equal(requests[0].headers.get("content-type"), "application/x-www-form-urlencoded");
        assert.equal(await requests[0].text(), `token=${TOKEN}`);
        const hash = createHash("sha256").update(TOKEN).digest("hex");
        assert.equal(tokenHash(TOKEN), hash);
        assert.ok(keys.filter((key) => key === hash).length >= 2, "cache and concurrent lookup both use the digest");
        assert.equal(keys.includes(TOKEN), false);
        assert.equal(keys.includes(CONFIG.secret), false);
        spy.mock.restore();
        now = OAUTH_CACHE_MS - 1;
        await introspector.introspect(TOKEN);
        assert.equal(requests.length, 1);
        now++;
        assert.equal(introspector.peek(TOKEN), undefined);
        await introspector.introspect(TOKEN);
        assert.equal(requests.length, 2);
        await introspector.introspect(OTHER);
        assert.equal(requests.length, 3, "each token has its own entry");
    });

    it("expires a positive at token expiry even if its 60 seconds have not elapsed", async () => {
        let now = 0;
        let calls = 0;
        const introspector = new TokenIntrospector("https://api.test", CONFIG, {
            now: () => now,
            fetch: async () => { calls++; return response({ ...active(), exp: 2 }); },
        });
        assert.equal((await introspector.introspect(TOKEN)).active, true);
        now = 2000;
        assert.equal(introspector.peek(TOKEN), undefined);
        assert.equal((await introspector.introspect(TOKEN)).active, false);
        assert.equal(calls, 2);
    });

    it("briefly caches inactive tokens and refuses malformed or refresh tokens locally", async () => {
        let now = 0;
        let calls = 0;
        const introspector = new TokenIntrospector("https://api.test", CONFIG, {
            now: () => now,
            fetch: async () => { calls++; return response({ active: false }); },
        });
        for (const token of ["sro_fake", "sr_live_test", `srr_${"a".repeat(43)}`, `sro_${"!".repeat(43)}`]) {
            assert.deepEqual(await introspector.introspect(token), { active: false });
        }
        assert.equal(calls, 0);
        await introspector.introspect(TOKEN);
        now = OAUTH_NEGATIVE_CACHE_MS - 1;
        await introspector.introspect(TOKEN);
        assert.equal(calls, 1);
        now++;
        await introspector.introspect(TOKEN);
        assert.equal(calls, 2);
    });

    it("rejects the wrong audience, expired credentials and non-access tokens", async () => {
        for (const patch of [
            { aud: ["https://another-mcp.test/mcp"] }, { aud: [`${CONFIG.resource}/`] },
            { aud: [`${CONFIG.issuer}/api`] }, { exp: 0 }, { exp: "3600" },
            { token_type: "refresh_token" }, { scope: undefined },
        ]) {
            const introspector = new TokenIntrospector("https://api.test", CONFIG, {
                now: () => 0, fetch: async () => response({ ...active(), ...patch }),
            });
            assert.deepEqual(await introspector.introspect(TOKEN), { active: false });
        }
    });

    it("fails closed on outages and malformed responses, without caching the failure or echoing secrets", async () => {
        for (const outcome of [
            () => response({ reflected: TOKEN, secret: CONFIG.secret }, 503),
            () => response({}, 401), () => response({}, 404), () => response({}, 429),
            () => response({ active: "true" }), () => response(null),
            () => new Response("not JSON"),
            () => { throw new Error(`${TOKEN} ${CONFIG.secret}`); },
        ]) {
            let calls = 0;
            const introspector = new TokenIntrospector("https://api.test", CONFIG, {
                now: () => 0,
                fetch: async () => { calls++; return calls === 1 ? outcome() : response(active()); },
            });
            await assert.rejects(introspector.introspect(TOKEN), (error: unknown) => {
                assert.ok(error instanceof IntrospectionUnavailable);
                assert.match(error.message, /Retry shortly/);
                assert.equal(error.message.includes(TOKEN), false);
                assert.equal(error.message.includes(CONFIG.secret), false);
                return true;
            });
            assert.equal(introspector.peek(TOKEN), undefined);
            assert.equal((await introspector.introspect(TOKEN)).active, true);
            assert.equal(calls, 2);
        }
    });
});

describe("per-tool auth responses", () => {
    it("challenges all four scopes for sign-in, and only the required scope for insufficient_scope", () => {
        const request = call("get_profile");
        const missing = authorizeTool(request, undefined, CONFIG)!;
        assert.equal(missing.status, 401);
        assert.equal(missing.challenge, `Bearer resource_metadata="${CONFIG.metadataUrl}", scope="profile render design jobs"`);
        assert.deepEqual(authFailureResponse(request, missing, false), {
            jsonrpc: "2.0", id: 42,
            error: { code: -32001, message: "Requires a signed-in SheetRender account.", data: { error: "invalid_token" } },
        });
        const limited = { active: true as const, scopes: ["render"], expiresAt: 3600000 };
        const denied = authorizeTool(request, limited, CONFIG)!;
        assert.equal(denied.status, 403);
        assert.match(denied.challenge, /error="insufficient_scope", scope="profile"/);
        assert.equal(authorizeTool(call("list_templates"), limited, CONFIG), undefined);
        assert.equal(authorizeTool(call("render_documents"), undefined, CONFIG), undefined);
    });

    it("uses OpenAI metadata or User-Agent only to select the tool-error shape", () => {
        const request = call("get_profile", { "openai/subject": "forged" });
        assert.equal(isChatGptCall(request, "Claude"), true);
        assert.equal(isChatGptCall(call("get_profile"), "ChatGPT/1.0"), true);
        assert.equal(isChatGptCall(call("get_profile"), "OpenAI MCP client"), true);
        assert.equal(isChatGptCall(call("get_profile", { subject: "openai/user" }), "Claude"), false);
        const failure = authorizeTool(request, undefined, CONFIG)!;
        const shaped = authFailureResponse(request, failure, true);
        assert.deepEqual(shaped, {
            jsonrpc: "2.0", id: 42,
            result: {
                isError: true,
                content: [{ type: "text", text: "Requires a signed-in SheetRender account." }],
                _meta: { "mcp/www_authenticate": [failure.challenge] },
            },
        });
    });
});
