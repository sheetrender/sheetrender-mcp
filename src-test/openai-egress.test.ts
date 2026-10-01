import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CidrSet, OPENAI_EGRESS_CIDRS } from "../src/anon.js";
import {
    EgressListError,
    fetchOpenaiEgress,
    OPENAI_EGRESS_URL,
    parseOpenaiEgress,
    startOpenaiEgressRefresh,
} from "../src/openai-egress.js";

/** The published file's shape: https://openai.com/chatgpt-connectors.json */
const PUBLISHED = {
    creationTime: "2026-09-22T18:18:05.915327",
    prefixes: [{ ipv4Prefix: "100.31.168.162/32" }, { ipv4Prefix: "9.129.0.0/17" }, { ipv6Prefix: "2001:db8:5::/48" }],
};

type Entry = Record<string, unknown> & { level: string; msg: string };

function respond(status: number, body: string): typeof fetch {
    return (async () => new Response(body, { status })) as unknown as typeof fetch;
}

describe("OpenAI egress list", () => {
    it("reads IPv4 and IPv6 prefixes from the published shape", () => {
        assert.deepEqual(parseOpenaiEgress(PUBLISHED), ["100.31.168.162/32", "9.129.0.0/17", "2001:db8:5::/48"]);
    });

    it("refuses the whole list when it is empty, malformed or too broad", () => {
        for (const body of [
            null,
            [],
            {},
            { prefixes: [] },
            { prefixes: "1.2.3.0/24" },
            { prefixes: [{ ipv4Prefix: "1.2.3.0/24" }, { ipv4Prefix: "not a cidr" }] },
            { prefixes: [{ ipv4Prefix: "1.2.3.4" }] },
            { prefixes: [{ ipv4Prefix: "2001:db8::/32" }] },
            { prefixes: [{ ipv6Prefix: "1.2.3.0/24" }] },
            { prefixes: [{ ipv4Prefix: "1.2.3.0/24", ipv6Prefix: "2001:db8::/32" }] },
            { prefixes: [{ ipv4Prefix: 42 }] },
            { prefixes: [null] },
            { prefixes: [{ ipv4Prefix: "0.0.0.0/0" }] },
            { prefixes: [{ ipv4Prefix: "10.0.0.0/7" }] },
            { prefixes: [{ ipv6Prefix: "::/0" }] },
            { prefixes: Array.from({ length: 10_001 }, () => ({ ipv4Prefix: "1.2.3.0/24" })) },
        ]) {
            assert.throws(() => parseOpenaiEgress(body), EgressListError, JSON.stringify(body)?.slice(0, 80));
        }
    });

    it("fetches the published URL and refuses failed, oversized or non-JSON answers", async () => {
        const seen: string[] = [];
        const ok = (async (url: string) => {
            seen.push(url);
            return new Response(JSON.stringify(PUBLISHED), { status: 200, headers: { "Content-Type": "application/octet-stream" } });
        }) as unknown as typeof fetch;
        assert.equal((await fetchOpenaiEgress(ok)).length, 3);
        assert.deepEqual(seen, [OPENAI_EGRESS_URL]);
        await assert.rejects(fetchOpenaiEgress(respond(503, "{}")), /HTTP 503/);
        await assert.rejects(fetchOpenaiEgress(respond(200, "<html>")), /not JSON/);
        await assert.rejects(fetchOpenaiEgress(respond(200, "x".repeat(1024 * 1024 + 1))), /body too large/);
        await assert.rejects(fetchOpenaiEgress((async () => { throw new TypeError("network down"); }) as unknown as typeof fetch), /fetch failed/);
    });

    it("replaces the set on a good fetch and keeps what it has on a bad one, logging each refresh", async () => {
        const logs: Entry[] = [];
        const set = new CidrSet(OPENAI_EGRESS_CIDRS);
        let answer = respond(503, "");
        const refresh = startOpenaiEgressRefresh(set, { log: (entry) => logs.push(entry), fetch: (url, init) => answer(url, init) });
        try {
            await refresh.refresh();
            assert.equal(set.size, OPENAI_EGRESS_CIDRS.length);
            assert.ok(set.has("98.87.72.221"));
            assert.deepEqual(logs.at(-1), {
                level: "warn", msg: "openai egress list", source: "built-in", count: OPENAI_EGRESS_CIDRS.length, reason: "HTTP 503",
            });

            answer = respond(200, JSON.stringify(PUBLISHED));
            await refresh.refresh();
            assert.equal(set.size, 3);
            assert.ok(set.has("9.129.1.1"));
            assert.ok(set.has("2001:db8:5:1::9"));
            assert.equal(set.has("98.87.72.221"), false);
            assert.deepEqual(logs.at(-1), { level: "info", msg: "openai egress list", source: "fetched", count: 3 });

            answer = respond(200, JSON.stringify({ prefixes: [] }));
            await refresh.refresh();
            assert.equal(set.size, 3);
            assert.ok(set.has("9.129.1.1"));
            assert.deepEqual(logs.at(-1), {
                level: "warn", msg: "openai egress list", source: "last fetch", count: 3, reason: "empty list",
            });
        } finally {
            refresh.stop();
        }
    });

    it("leaves the set untouched when a replacement does not parse", () => {
        const set = new CidrSet(["192.0.2.0/24"]);
        assert.throws(() => set.replace(["198.51.100.0/24", "nope"]));
        assert.ok(set.has("192.0.2.1"));
        assert.equal(set.has("198.51.100.1"), false);
        assert.equal(set.size, 1);
    });
});
