/**
 * Keeps the OpenAI egress ranges current: the addresses whose `openai/subject`
 * the anonymous tools believe (anon.ts, trustedOpenaiSubject).
 *
 * OpenAI publishes the ranges ChatGPT apps and connectors call from at
 * https://openai.com/chatgpt-connectors.json and calls the list best effort,
 * changing often. A ChatGPT call from an address missing from our copy is
 * counted by IP, so everyone behind that address shares one allowance. The
 * hosted server therefore fetches the list at startup and every 24 hours.
 *
 * A fetch that fails, or returns anything malformed or empty, changes nothing:
 * the set keeps the last good list, which at startup is the built-in copy in
 * anon.ts. OPENAI_EGRESS_CIDRS, when set, replaces all of this (http.ts never
 * starts the refresh then).
 */

import { type CidrSet, parseCidr } from "./anon.js";

export const OPENAI_EGRESS_URL = "https://openai.com/chatgpt-connectors.json";
export const OPENAI_EGRESS_REFRESH_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
/** The published file is about 10 KB; anything far larger is not it. */
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_PREFIXES = 10_000;
/**
 * Broadest range accepted: a /0 would let any caller choose its own subject.
 * The widest published range today is an IPv4 /17.
 */
const MIN_PREFIX = { ipv4: 8, ipv6: 16 } as const;

type Fetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;
type Log = (entry: Record<string, unknown> & { level: "info" | "warn" | "error"; msg: string }) => void;

/** Why a fetched list was not used; a fixed phrase, safe to log. */
export class EgressListError extends Error {}

/**
 * The CIDRs in a chatgpt-connectors.json body: `{"prefixes": [{"ipv4Prefix":
 * "a.b.c.d/n"} | {"ipv6Prefix": "x::/n"}, ...]}`. Throws EgressListError if
 * any entry is malformed or too broad, or if there is none: a list is used
 * whole or not at all.
 */
export function parseOpenaiEgress(body: unknown): string[] {
    const prefixes = body && typeof body === "object" ? (body as { prefixes?: unknown }).prefixes : undefined;
    if (!Array.isArray(prefixes)) throw new EgressListError("no prefixes array");
    if (prefixes.length === 0) throw new EgressListError("empty list");
    if (prefixes.length > MAX_PREFIXES) throw new EgressListError("too many prefixes");
    return prefixes.map((entry: unknown) => {
        const item = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
        const v4 = item.ipv4Prefix;
        const v6 = item.ipv6Prefix;
        const raw = typeof v4 === "string" && v6 === undefined ? v4 : typeof v6 === "string" && v4 === undefined ? v6 : undefined;
        if (raw === undefined) throw new EgressListError("malformed prefix entry");
        let parsed: ReturnType<typeof parseCidr>;
        try {
            parsed = parseCidr(raw);
        } catch {
            throw new EgressListError("malformed CIDR");
        }
        if (parsed.family !== (raw === v4 ? "ipv4" : "ipv6")) throw new EgressListError("prefix in the wrong family");
        if (parsed.prefix < MIN_PREFIX[parsed.family]) throw new EgressListError("range too broad");
        return raw.trim();
    });
}

/**
 * The body as UTF-8, read a chunk at a time: past `limit` bytes the download
 * is cancelled and EgressListError thrown, so an oversized answer never sits
 * in memory whole. A declared Content-Length past `limit` is refused unread.
 */
async function readCapped(response: Response, limit: number): Promise<string> {
    const body = response.body;
    if (!body) return "";
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > limit) {
        await body.cancel().catch(() => undefined);
        throw new EgressListError("body too large");
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
            chunk = await reader.read();
        } catch {
            throw new EgressListError("fetch failed");
        }
        if (chunk.done) break;
        received += chunk.value.byteLength;
        if (received > limit) {
            await reader.cancel().catch(() => undefined);
            throw new EgressListError("body too large");
        }
        chunks.push(chunk.value);
    }
    return Buffer.concat(chunks).toString("utf8");
}

/** Fetches and parses the published list. Throws EgressListError on any failure. */
export async function fetchOpenaiEgress(fetchImpl: Fetch = fetch, timeoutMs = FETCH_TIMEOUT_MS): Promise<string[]> {
    let response: Response;
    try {
        response = await fetchImpl(OPENAI_EGRESS_URL, {
            signal: AbortSignal.timeout(timeoutMs),
            headers: { Accept: "application/json" },
        });
    } catch {
        throw new EgressListError("fetch failed");
    }
    if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new EgressListError(`HTTP ${response.status}`);
    }
    const text = await readCapped(response, MAX_BODY_BYTES);
    let body: unknown;
    try {
        body = JSON.parse(text);
    } catch {
        throw new EgressListError("not JSON");
    }
    return parseOpenaiEgress(body);
}

export interface EgressRefreshOptions {
    log: Log;
    fetch?: Fetch;
    intervalMs?: number;
}

export interface EgressRefresh {
    /** One refresh now; never throws. Resolves once the set and log are updated. */
    refresh(): Promise<void>;
    stop(): void;
}

/**
 * Refreshes `set` from OpenAI's list now and every `intervalMs`, logging one
 * line per refresh: `source` "fetched", or "built-in" / "last fetch" when the
 * fetch could not be used and the set kept what it had, with the reason.
 */
export function startOpenaiEgressRefresh(set: CidrSet, options: EgressRefreshOptions): EgressRefresh {
    let fetchedBefore = false;
    let running: Promise<void> | undefined;

    async function once(): Promise<void> {
        try {
            const cidrs = await fetchOpenaiEgress(options.fetch);
            set.replace(cidrs);
            fetchedBefore = true;
            options.log({ level: "info", msg: "openai egress list", source: "fetched", count: cidrs.length });
        } catch (error) {
            options.log({
                level: "warn",
                msg: "openai egress list",
                source: fetchedBefore ? "last fetch" : "built-in",
                count: set.size,
                reason: error instanceof EgressListError ? error.message : "unusable list",
            });
        }
    }

    const refresh = () => {
        running ??= once().finally(() => {
            running = undefined;
        });
        return running;
    };

    void refresh();
    const timer = setInterval(() => void refresh(), options.intervalMs ?? OPENAI_EGRESS_REFRESH_MS);
    timer.unref();
    return { refresh, stop: () => clearInterval(timer) };
}
