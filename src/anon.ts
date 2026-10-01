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
 * caller's subject: ChatGPT's anonymised `openai/subject` when the call comes
 * from OpenAI's published egress ranges, else the client IP.
 * The flood guard here (calls per hour) sits in front of the backend's own
 * per-subject monthly document volume, which is the real limit.
 *
 * Stdio and API-key callers never see any of this: http.ts only builds this
 * server for a request with no Authorization header, and only when a demo key
 * is configured.
 */

import { createHash } from "node:crypto";
import { BlockList, isIP } from "node:net";

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

/**
 * Default cell cap, in characters: the catalogue's `limits.cell_max_chars`.
 * Applies to a field the catalogue gives no `max_chars` (and to prose).
 */
export const MAX_CELL_CHARS = 2000;
/** Default UTF-8 byte bound on a text cell, the catalogue's `limits.cell_max_bytes`. */
export const MAX_CELL_BYTES = 2048;
/** Most columns a row may carry. The widest template has eight fields. */
export const MAX_ROW_KEYS = 50;
/** The handoff payload cap the backend enforces, checked here first. */
export const MAX_HANDOFF_BYTES = 256 * 1024;
/**
 * Anonymous HTTP body cap: the backend's render body cap. 25 letters at their
 * field caps are 650 KB of UTF-8 cell text, and still fit when a client
 * escapes every emoji as `\uXXXX\uXXXX` (three times the bytes). The handoff
 * cap above still applies to create_continue_link's own payload.
 */
export const MAX_ANON_BODY_BYTES = 2 * 1024 * 1024;
/** Default flood guard: tool calls per subject per hour. */
export const DEFAULT_CALLS_PER_HOUR = 30;
/**
 * Second, coarser bucket for callers counted by IP: calls per IPv4 /24 or
 * IPv6 /48 per hour, so a block of cheap addresses is one caller here.
 */
export const DEFAULT_NETWORK_CALLS_PER_HOUR = 300;
/** Traffic from Claude's network shares one larger, isolated flood bucket. */
export const DEFAULT_CLAUDE_CALLS_PER_HOUR = 3000;
/**
 * Most messages an anonymous JSON-RPC batch may carry. MCP removed batching in
 * protocol version 2025-06-18, and ChatGPT and Claude send one message per
 * request; four leaves room for an older client while bounding what one small
 * request can make the server generate (a view read answers ~200 KB).
 */
export const MAX_ANON_BATCH = 4;
/**
 * Anonymous messages other than tool calls (initialize, tools/list,
 * resources/read, ...) per IPv4 /24 or IPv6 /48 per hour. A session sends a
 * handful; tool calls have their own buckets (guard() below). Not applied to
 * ChatGPT's or Claude's egress, where one address carries many users.
 */
export const DEFAULT_RPC_PER_HOUR = 600;
/** Anonymous requests being answered at once, all callers together. */
export const DEFAULT_MAX_IN_FLIGHT = 64;
/** Anonymous requests being answered at once per IPv4 /24 or IPv6 /48, outside the platforms' egress. */
export const DEFAULT_NETWORK_MAX_IN_FLIGHT = 8;
const HOUR_MS = 60 * 60 * 1000;
const CATALOGUE_TTL_MS = HOUR_MS;

// ---------------------------------------------------------------------------
// Caller identity
// ---------------------------------------------------------------------------

/** Which directory the call came from, based on verified caller identity. */
export type Source = "chatgpt" | "claude" | "other";

type Meta = Record<string, unknown> | undefined;

/**
 * A User-Agent or untrusted `_meta` cannot select a source. Claude must come
 * from its egress range; ChatGPT must carry a trusted OpenAI subject.
 */
export function detectSource(
    meta: Meta,
    _userAgent: string | undefined,
    clientIp = "",
    openaiEgress: CidrSet = DEFAULT_OPENAI_EGRESS,
): Source {
    if (isClaudeIp(clientIp)) return "claude";
    return trustedOpenaiSubject(meta, clientIp, openaiEgress) ? "chatgpt" : "other";
}

function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

/**
 * Anthropic's published outbound range for MCP tool calls, checked on
 * 2026-10-01 at https://platform.claude.com/docs/en/api/ip-addresses. The
 * outbound list is IPv4 only; the IPv6 range on that page (2607:6bc0::/48) is
 * inbound, and the 34.162.x.x addresses it lists are phased out. The page also
 * says the MCP connector of the Claude API leaves from this range, so any API
 * key holder reaches this server from it too.
 */
export const CLAUDE_EGRESS_CIDRS: readonly string[] = ["160.79.104.0/21"];

/**
 * OpenAI's published egress ranges for ChatGPT apps and connectors, copied
 * from https://openai.com/chatgpt-connectors.json (creationTime
 * 2026-09-22T18:18:05), which https://developers.openai.com/api/docs/guides/ip-addresses
 * names for Apps SDK traffic. IPv4 only, as published. OpenAI calls the list
 * best effort and changes it often: OPENAI_EGRESS_CIDRS (http.ts) replaces it
 * without a release. A ChatGPT call from an address missing here is counted by
 * its IP, never by its `openai/subject`.
 */
export const OPENAI_EGRESS_CIDRS: readonly string[] = [
    "100.31.168.162/32", "102.37.57.54/32", "104.192.219.204/30", "104.208.184.192/28", "104.210.139.192/28",
    "104.210.139.224/28", "108.179.20.6/31", "112.220.228.112/29", "115.42.241.224/29", "12.105.90.64/27",
    "12.108.172.96/28", "12.117.245.68/30", "12.12.47.194/32", "12.12.56.224/28", "12.12.56.24/29",
    "12.12.56.240/28", "12.12.56.32/29", "12.129.184.64/26", "12.162.186.200/29", "12.77.42.78/32",
    "12.79.201.188/30", "12.79.202.152/30", "12.79.202.156/30", "12.79.202.228/30", "12.79.202.232/30",
    "12.79.225.144/30", "12.79.34.30/32", "128.177.174.162/32", "128.177.85.168/30", "13.223.161.115/32",
    "13.237.176.161/32", "13.238.110.96/32", "13.65.138.112/28", "13.67.72.16/28", "13.71.2.208/28",
    "13.71.25.29/32", "13.76.116.80/28", "13.76.32.208/28", "13.83.237.176/28", "130.33.24.99/32",
    "132.196.82.48/28", "134.138.52.16/28", "134.138.52.64/28", "134.138.57.64/28", "134.138.57.80/28",
    "134.149.233.80/28", "134.33.102.192/28", "135.116.136.160/28", "135.13.64.240/28", "135.220.208.92/32",
    "135.220.40.201/32", "135.220.73.208/28", "135.234.27.89/32", "135.237.133.48/28", "137.135.191.176/28",
    "145.132.136.96/28", "148.109.10.28/30", "148.109.36.240/28", "148.76.185.192/27", "149.97.160.16/28",
    "15.168.252.168/32", "152.44.170.32/29", "159.180.234.92/30", "172.162.248.64/28", "172.167.161.96/32",
    "172.167.32.228/32", "172.170.1.80/28", "172.170.225.0/28", "172.170.241.80/28", "172.171.234.186/32",
    "172.172.206.48/28", "172.175.152.224/28", "172.177.53.240/28", "172.183.143.224/28", "172.191.238.68/32",
    "172.191.70.179/32", "172.192.112.208/28", "172.198.58.176/28", "172.198.79.112/28", "172.199.137.80/28",
    "172.203.39.49/32", "172.204.96.80/28", "172.206.38.240/28", "172.207.1.32/28", "172.207.173.200/32",
    "172.214.226.198/32", "172.215.215.32/28", "173.195.76.0/26", "18.218.234.253/32", "180.222.194.124/30",
    "184.73.124.134/32", "191.232.238.96/28", "191.233.251.27/32", "191.234.167.144/28", "191.237.249.64/28",
    "194.46.223.16/28", "195.171.64.176/28", "199.241.201.152/29", "199.47.142.0/23", "20.102.212.144/28",
    "20.125.112.224/28", "20.125.40.252/32", "20.162.96.163/32", "20.168.7.192/28", "20.169.78.48/28",
    "20.169.78.64/28", "20.169.86.224/28", "20.170.184.16/28", "20.170.184.32/28", "20.170.184.48/28",
    "20.170.184.64/28", "20.170.184.80/28", "20.171.137.175/32", "20.172.29.32/28", "20.184.36.134/32",
    "20.206.101.192/28", "20.215.187.208/28", "20.215.219.208/28", "20.219.184.96/28", "20.227.140.32/28",
    "20.228.106.176/28", "20.235.87.224/28", "20.241.32.36/32", "20.249.63.208/28", "20.250.136.64/28",
    "20.44.100.224/28", "20.45.178.144/28", "20.55.229.144/28", "20.57.199.192/28", "20.63.221.64/28",
    "20.74.221.21/32", "20.78.130.48/28", "20.98.18.80/28", "203.125.229.136/29", "203.149.223.128/29",
    "208.184.8.104/29", "208.184.8.84/30", "208.52.97.112/29", "208.69.43.136/29", "208.80.35.32/27",
    "209.247.142.56/30", "209.247.151.176/28", "209.249.246.178/31", "209.249.37.128/26", "213.122.44.84/31",
    "216.64.170.234/32", "217.111.182.45/32", "217.111.242.24/29", "23.101.217.176/28", "23.102.141.32/28",
    "23.98.186.64/28", "23.98.186.96/28", "24.82.185.0/29", "3.12.200.18/32", "3.140.2.201/32",
    "4.14.111.0/28", "4.151.119.48/28", "4.151.200.38/32", "4.151.71.176/28", "4.155.146.196/32",
    "4.17.25.128/29", "4.185.216.109/32", "4.189.118.208/28", "4.19.160.0/28", "4.197.115.112/28",
    "4.197.172.116/32", "4.197.64.0/28", "4.197.64.48/28", "4.201.232.64/28", "4.205.128.176/28",
    "4.217.235.100/32", "4.218.24.64/28", "4.226.200.16/28", "4.226.226.32/28", "4.245.198.13/32",
    "4.38.166.228/30", "4.53.139.144/28", "4.7.10.112/30", "4.7.11.196/30", "40.118.236.137/32",
    "40.122.118.119/32", "40.122.118.202/32", "40.122.118.93/32", "40.124.161.0/28", "40.88.27.77/32",
    "43.202.230.227/32", "44.221.134.118/32", "44.249.227.138/32", "45.147.211.96/29", "48.218.181.198/32",
    "48.221.184.80/28", "48.221.184.96/28", "48.221.40.176/28", "50.145.17.208/30", "50.145.17.212/30",
    "50.145.17.216/29", "50.145.17.224/29", "50.151.105.128/30", "50.151.105.136/29", "50.213.205.80/29",
    "50.235.235.72/29", "51.4.112.173/32", "51.57.0.96/28", "51.59.24.64/28", "51.59.24.80/28",
    "51.59.48.80/28", "52.119.123.85/32", "52.143.181.161/32", "52.148.129.32/28", "52.165.212.48/28",
    "52.17.188.55/32", "52.172.129.160/28", "52.173.221.16/28", "52.173.234.16/28", "52.173.234.80/28",
    "52.190.137.144/28", "52.190.137.16/28", "52.190.139.48/28", "52.190.142.64/28", "52.2.184.223/32",
    "52.208.217.159/32", "52.231.30.48/28", "52.231.39.144/28", "52.242.132.224/28", "52.242.132.240/28",
    "52.255.109.144/28", "52.255.109.80/28", "52.255.109.96/28", "52.255.111.0/28", "52.43.161.225/32",
    "52.6.94.121/32", "54.180.197.31/32", "54.227.131.66/32", "56.155.71.179/32", "57.133.92.112/31",
    "57.154.174.112/28", "57.154.187.32/28", "61.105.58.228/30", "62.96.221.184/29", "64.124.191.96/28",
    "64.124.21.196/32", "64.71.12.112/28", "66.193.99.66/32", "67.207.103.240/28", "68.154.28.96/28",
    "68.220.57.64/28", "70.153.32.16/28", "70.153.32.32/28", "70.156.152.96/28", "72.146.20.246/32",
    "74.161.200.96/28", "74.224.217.64/28", "74.226.253.160/28", "74.248.148.7/32", "74.248.37.160/28",
    "74.7.35.112/28", "74.7.35.48/28", "74.7.36.64/28", "74.7.36.80/28", "74.7.36.96/28",
    "76.77.188.112/29", "77.75.96.48/29", "79.244.198.212/30", "8.244.149.100/30", "80.169.53.32/28",
    "85.211.128.16/28", "85.211.128.32/28", "9.129.0.0/17", "9.160.128.16/28", "9.160.128.64/28",
    "9.160.96.16/28", "9.205.128.32/28", "9.205.128.48/28", "9.205.8.48/28", "9.205.8.64/28",
    "9.234.96.192/28", "9.234.97.96/28", "98.87.72.221/32",
];

/** Expand an already validated IPv6 address, including a dotted IPv4 tail. */
function ipv6Words(address: string): number[] {
    let plain = address.split("%", 1)[0]!;
    if (plain.includes(".")) {
        const tailAt = plain.lastIndexOf(":") + 1;
        const octets = plain.slice(tailAt).split(".").map(Number);
        plain = plain.slice(0, tailAt) + ((octets[0]! << 8) | octets[1]!).toString(16) +
            ":" + ((octets[2]! << 8) | octets[3]!).toString(16);
    }
    const [head, tail] = plain.split("::");
    const words = (part: string) => part ? part.split(":").map((word) => parseInt(word, 16)) : [];
    const leading = words(head!);
    if (tail === undefined) return leading;
    const trailing = words(tail);
    return [...leading, ...Array<number>(8 - leading.length - trailing.length).fill(0), ...trailing];
}

function unmapV4(address: string): string {
    if (isIP(address) !== 6) return address;
    const words = ipv6Words(address);
    if (words.slice(0, 5).some((word) => word !== 0) || words[5] !== 0xffff) return address;
    return [words[6]! >> 8, words[6]! & 255, words[7]! >> 8, words[7]! & 255].join(".");
}

/** Match the backend's client_network: IPv4, unwrapped mapped IPv4, or IPv6 /64. */
export function clientNetwork(address: string): string {
    const plain = unmapV4(address);
    if (isIP(plain) !== 6) return plain || "unknown";
    const words = ipv6Words(plain);
    words.fill(0, 4);
    // Python's IPv6 spelling compresses the longest zero run, first on a tie.
    let start = 0;
    let length = 0;
    for (let i = 0; i < words.length;) {
        if (words[i] !== 0) {
            i++;
            continue;
        }
        const from = i;
        while (i < words.length && words[i] === 0) i++;
        if (i - from > length) {
            start = from;
            length = i - from;
        }
    }
    const hex = words.map((word) => word.toString(16));
    return `${hex.slice(0, start).join(":")}::${hex.slice(start + length).join(":")}/64`;
}

/**
 * The coarser network an address is flood-guarded by: an IPv4 /24 or an IPv6
 * /48 (one tunnel-broker allocation), with mapped IPv4 unwrapped first.
 */
export function floodNetwork(address: string): string {
    const plain = unmapV4(address);
    const family = isIP(plain);
    if (family === 4) return `${plain.split(".").slice(0, 3).join(".")}.0/24`;
    if (family === 6) return `${ipv6Words(plain).slice(0, 3).map((word) => word.toString(16)).join(":")}::/48`;
    return plain || "unknown";
}

/** A CIDR as `address/prefix`, validated; throws on anything else. */
export function parseCidr(cidr: string): { address: string; prefix: number; family: "ipv4" | "ipv6" } {
    const match = /^([^/\s]+)\/(\d{1,3})$/.exec(cidr.trim());
    const family = match ? isIP(match[1]!) : 0;
    const prefix = match ? Number(match[2]) : NaN;
    if (!match || family === 0 || prefix > (family === 4 ? 32 : 128)) {
        throw new SheetRenderError(`Not a CIDR range: ${cidr.slice(0, 100)}`);
    }
    return { address: match[1]!, prefix, family: family === 4 ? "ipv4" : "ipv6" };
}

/**
 * A set of IPv4 and IPv6 ranges; an IPv4-mapped IPv6 address matches as IPv4.
 * `replace` swaps the whole set at once (the live OpenAI list), after every
 * range in the new one has parsed.
 */
export class CidrSet {
    #list: BlockList;
    #size: number;

    constructor(cidrs: readonly string[]) {
        this.#list = CidrSet.#build(cidrs);
        this.#size = cidrs.length;
    }

    static #build(cidrs: readonly string[]): BlockList {
        const list = new BlockList();
        for (const cidr of cidrs) {
            const { address, prefix, family } = parseCidr(cidr);
            list.addSubnet(address, prefix, family);
        }
        return list;
    }

    /** Replaces every range; throws, leaving the set unchanged, if one does not parse. */
    replace(cidrs: readonly string[]): void {
        this.#list = CidrSet.#build(cidrs);
        this.#size = cidrs.length;
    }

    /** How many ranges the set was built from. */
    get size(): number {
        return this.#size;
    }

    has(address: string): boolean {
        const plain = unmapV4(address);
        const family = isIP(plain);
        return family !== 0 && this.#list.check(plain, family === 4 ? "ipv4" : "ipv6");
    }
}

const CLAUDE_EGRESS = new CidrSet(CLAUDE_EGRESS_CIDRS);
const DEFAULT_OPENAI_EGRESS = new CidrSet(OPENAI_EGRESS_CIDRS);

/** Only the verified network address qualifies; a User-Agent cannot opt in. */
export function isClaudeIp(address: string): boolean {
    return CLAUDE_EGRESS.has(address);
}

/** The `openai/subject` a call carries, whoever sent it. See trustedOpenaiSubject. */
export function openaiSubject(meta: Meta): string | undefined {
    const subject = meta?.["openai/subject"];
    if (typeof subject !== "string") return undefined;
    const trimmed = subject.trim();
    return trimmed && trimmed.length <= 512 ? trimmed : undefined;
}

/**
 * ChatGPT's anonymised user id, when it can be believed. Any caller can put
 * `openai/subject` in `_meta`, and a fresh one per call would be a fresh
 * monthly allowance and a fresh flood bucket, draining the shared account.
 * So it counts only from OpenAI's egress ranges, and never from Claude's.
 */
export function trustedOpenaiSubject(
    meta: Meta,
    clientIp: string,
    openaiEgress: CidrSet = DEFAULT_OPENAI_EGRESS,
): string | undefined {
    if (isClaudeIp(clientIp) || !openaiEgress.has(clientIp)) return undefined;
    return openaiSubject(meta);
}

/**
 * Who a call is counted against, as the backend receives it: a trusted
 * subject hashed (`sub:<sha256>`); else, for a Claude caller that sent an MCP
 * session id, that id hashed (`mcps:<sha256>`, one Claude conversation); else
 * the client network hashed (`ip:<sha256>`). No raw value leaves this process or
 * reaches a log.
 */
export function subjectKey(
    meta: Meta,
    clientIp: string,
    sessionId?: string,
    openaiEgress: CidrSet = DEFAULT_OPENAI_EGRESS,
): string {
    const subject = trustedOpenaiSubject(meta, clientIp, openaiEgress);
    if (subject) return `sub:${sha256(subject)}`;
    if (sessionId && isClaudeIp(clientIp)) return `mcps:${sha256(sessionId)}`;
    return `ip:${sha256(clientNetwork(clientIp))}`;
}

/** Where a call came from; a Claude-range caller is "claude" whatever its `_meta` or User-Agent says. */
export function callerSource(
    meta: Meta,
    userAgent: string | undefined,
    clientIp: string,
    openaiEgress: CidrSet = DEFAULT_OPENAI_EGRESS,
): Source {
    return detectSource(meta, userAgent, clientIp, openaiEgress);
}

/** Short fingerprint of a subject for the request log. */
export function subjectFingerprint(subject: string): string {
    return sha256(subject).slice(0, 12);
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

    /** Whether `count` more calls would fit (what `take` decides for one), without counting any. */
    check(key: string, count = 1): LimitDecision {
        const now = this.#now();
        const hits = (this.#hits.get(key) ?? []).filter((at) => at > now - this.#windowMs);
        if (hits.length + count <= this.#limit) return { allowed: true, retryAfterMs: 0 };
        // Room for `count` once enough of the oldest calls have left the window.
        const freeing = hits[hits.length + count - this.#limit - 1];
        return { allowed: false, retryAfterMs: freeing === undefined ? this.#windowMs : Math.max(0, freeing + this.#windowMs - now) };
    }

    /** Counts `count` calls, after a check() that said they fit. */
    takeMany(key: string, count: number): void {
        for (let i = 0; i < count; i++) this.take(key);
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

/**
 * Requests being answered right now, in memory, per process: at most `limit`
 * overall and `perKeyLimit` per key. `enter` returns the release function, or
 * the reason it refused.
 */
export class InFlightLimiter {
    readonly #limit: number;
    readonly #perKeyLimit: number;
    readonly #byKey = new Map<string, number>();
    #total = 0;

    constructor(limit: number, perKeyLimit: number) {
        this.#limit = limit;
        this.#perKeyLimit = perKeyLimit;
    }

    /** `key` undefined: counted overall only. */
    enter(key: string | undefined): (() => void) | "busy" | "key" {
        if (key !== undefined && (this.#byKey.get(key) ?? 0) >= this.#perKeyLimit) return "key";
        if (this.#total >= this.#limit) return "busy";
        this.#total++;
        if (key !== undefined) this.#byKey.set(key, (this.#byKey.get(key) ?? 0) + 1);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.#total--;
            if (key === undefined) return;
            const left = (this.#byKey.get(key) ?? 1) - 1;
            if (left > 0) this.#byKey.set(key, left);
            else this.#byKey.delete(key);
        };
    }

    get total(): number {
        return this.#total;
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
    /** Longest text value, in characters, after trimming. */
    max_chars: number;
    /** Longest text value, in UTF-8 bytes, after trimming. */
    max_bytes: number;
    /** Most lines, after line breaks are folded as the backend folds them; absent: no limit. */
    max_lines?: number;
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

/** A catalogue cap, or the default when the catalogue does not carry one. */
function capOf(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function catalogueText(value: unknown, fallback = ""): string {
    return typeof value === "string" && value ? value.slice(0, MAX_CELL_CHARS) : fallback;
}

/**
 * The catalogue's prose: what a directory reviewer reads as our copy. Example
 * values are sample data (a person's name, a sentence of a letter) and are
 * left out, so an example such as "Jane Freeman" cannot fail the check.
 */
function catalogueProse(templates: CatalogueTemplate[]): string[] {
    return templates.flatMap((template) => [
        template.name,
        template.description,
        ...template.fields.flatMap((field) => [field.label, field.description]),
    ]);
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
                    max_chars: capOf(field.max_chars, MAX_CELL_CHARS),
                    max_bytes: capOf(field.max_bytes, MAX_CELL_BYTES),
                    ...(capOf(field.max_lines, 0) > 0 ? { max_lines: capOf(field.max_lines, 0) } : {}),
                })),
        });
    }
    // Catalogue prose is authored by the backend, unlike the user's row data.
    // Reject a policy regression before it reaches either the model or view.
    if (catalogueProse(templates).some((text) => BANNED_WORDS.test(text))) {
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

// Text length is checked per field against the catalogue (checkRows), since
// the letter's body allows more than the other fields; the HTTP body cap bounds
// the total.
const cellSchema = z.union([
    z.string().describe(ANON_TEXT.cellText),
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
    max_chars: z.number(),
    max_bytes: z.number(),
    max_lines: z.number().optional(),
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
    scope: z.enum(["subject", "pool"]).optional(),
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
    status: z.string().optional(),
    message: z.string().optional(),
};

const continueOutputShape = {
    continue_url: z.string(),
    expires_at: z.string().nullable(),
    rows_saved: z.number(),
};

/** Row keys match a field exactly, else with case, spaces and dashes ignored, as the backend does. */
function looseKey(key: string): string {
    return key.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * The row's value for each template field, with the key it came from, as the
 * backend's normalise_row picks it: an exact key first, then the first key
 * that matches loosely. Every other key is ignored, as the backend ignores it.
 */
function fieldValues(template: CatalogueTemplate, row: Record<string, Cell>): Map<string, [string, Cell]> {
    const keys = new Set(template.fields.map((field) => field.key));
    const picked = new Map<string, [string, Cell]>();
    for (const [key, value] of Object.entries(row)) {
        if (keys.has(key)) picked.set(key, [key, value]);
    }
    for (const [key, value] of Object.entries(row)) {
        const loose = looseKey(key);
        if (keys.has(loose) && !picked.has(loose)) picked.set(loose, [key, value]);
    }
    return picked;
}

/**
 * Python's str.isspace() set, which the backend's str.strip() removes. JS
 * trim() differs: it also strips U+FEFF and keeps U+001C-U+001F and U+0085.
 */
const PY_WHITESPACE = new Set([
    0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680,
    0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
    0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/** Python's `text.strip()`. A scan rather than a regex, which backtracks on long runs. */
export function pythonStrip(text: string): string {
    let start = 0;
    let end = text.length;
    while (start < end && PY_WHITESPACE.has(text.charCodeAt(start))) start++;
    while (end > start && PY_WHITESPACE.has(text.charCodeAt(end - 1))) end--;
    return text.slice(start, end);
}

/** Python's `len(text)`: code points, so a surrogate pair (an emoji) is one. */
export function pythonLength(text: string): number {
    let count = 0;
    for (let i = 0; i < text.length; i++) {
        const unit = text.charCodeAt(i);
        if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
            const next = text.charCodeAt(i + 1);
            if (next >= 0xdc00 && next <= 0xdfff) i++;
        }
        count++;
    }
    return count;
}

/** The backend's _LINE_BREAK_RE: every line break a browser honours. */
const LINE_BREAK = /\r\n?|[\v\f\x85\u2028\u2029]/g;
/** The backend's _BLANK_RUN_RE: three or more breaks, blank or space-only lines between. */
const BLANK_RUN = /\n(?:[ \t]*\n){2,}/g;

/**
 * Lines in a stripped text value as the backend counts them for `max_lines`:
 * every line break folded to "\n", runs of blank lines folded to one, then
 * one more than the number of breaks.
 */
export function pythonLineCount(text: string): number {
    const folded = text.replace(LINE_BREAK, "\n").replace(BLANK_RUN, "\n\n");
    let breaks = 0;
    for (let at = folded.indexOf("\n"); at !== -1; at = folded.indexOf("\n", at + 1)) breaks++;
    return breaks + 1;
}

/**
 * The first field value over its cap, as a message for the model, or
 * undefined. Mirrors the backend's _clean_value: only the value it picks per
 * field is checked, after Python's strip(), in code points and UTF-8 bytes,
 * then in lines for a field with `max_lines`.
 */
export function checkRows(template: CatalogueTemplate, rows: Record<string, Cell>[]): string | undefined {
    for (const [index, row] of rows.entries()) {
        const values = fieldValues(template, row);
        for (const field of template.fields) {
            const [key, value] = values.get(field.key) ?? [field.key, null];
            if (typeof value !== "string") continue;
            const text = pythonStrip(value);
            if (pythonLength(text) > field.max_chars || Buffer.byteLength(text, "utf8") > field.max_bytes) {
                return ANON_TEXT.cellTooLong
                    .replace("{row}", String(index + 1))
                    .replace("{field}", () => key.slice(0, 100))
                    .replace("{chars}", String(field.max_chars))
                    .replace("{bytes}", String(field.max_bytes));
            }
            if (field.max_lines !== undefined && pythonLineCount(text) > field.max_lines) {
                return ANON_TEXT.cellTooManyLines
                    .replace("{row}", String(index + 1))
                    .replace("{field}", () => key.slice(0, 100))
                    .replace("{lines}", String(field.max_lines));
            }
        }
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

function errorResult(text: string): CallToolResult {
    return { content: [{ type: "text", text }], isError: true };
}

/** Longest backend 422 message passed through to the model. */
export const MAX_DETAIL_CHARS = 300;

/**
 * A backend 422 `detail` the model may read, or undefined. Only a plain
 * string qualifies: the anonymous routes' own refusals (AnonRenderError and
 * HandoffError in the backend) name a row number, a template field key and
 * the rule, never a value. FastAPI's validation errors are a list, which can
 * name the caller's column keys, and are never passed on. Neither is a string
 * that looks like markup or a credential, should the backend ever reflect
 * one. Control characters are dropped and the text is cut to MAX_DETAIL_CHARS.
 */
function rowRefusal(detail: unknown): string | undefined {
    if (typeof detail !== "string") return undefined;
    const text = detail.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/ {2,}/g, " ").trim();
    if (!text || /[<>]|\bsr_|bearer|authori[sz]ation|api[ _-]?key|token|secret/i.test(text)) return undefined;
    return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS - 1)}…` : text;
}

/**
 * Backend failures use local wording, except a 422's own refusal text (see
 * rowRefusal). Upstream bodies and network causes can contain credentials, row
 * values or account copy.
 */
export function anonToolError(error: unknown, what: string): CallToolResult {
    if (error instanceof SheetRenderError) {
        const detail = error.detail;
        const accountCapacity = error.status === 403 && detail && typeof detail === "object" &&
            "code" in detail && detail.code === "plan_limit";
        if (error.status === 429 || accountCapacity) {
            return errorResult(what === "Creating the continue link" ? ANON_TEXT.continueBusy : ANON_TEXT.busy);
        }
        const refusal = error.status === 422 ? rowRefusal(detail) : undefined;
        if (refusal) return errorResult(`${what} failed: ${refusal}`);
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

/** A continue URL must stay on the API origin and the selected template page. */
function safeContinueUrl(raw: unknown, apiOrigin: string, key: TemplateKey): string | null {
    if (typeof raw !== "string" || !raw) return null;
    try {
        const url = new URL(raw, `${apiOrigin}/`);
        return (url.protocol === "https:" || url.protocol === "http:") &&
                url.origin === apiOrigin && !url.username && !url.password &&
                url.pathname === `/templates/${TEMPLATE_SLUGS[key]}`
            ? url.href : null;
    } catch {
        return null;
    }
}

function readVolume(result: BuiltinRenderResult): DocumentVolume | null {
    const raw = result.volume ?? result.monthly_volume ?? result.daily_volume;
    if (!raw || typeof raw.used !== "number" || typeof raw.limit !== "number") return null;
    return {
        used: raw.used,
        limit: raw.limit,
        resets_at: typeof raw.resets_at === "string" ? raw.resets_at : null,
        ...(raw.scope === "pool" || raw.scope === "subject" ? { scope: raw.scope } : {}),
    };
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
    const message = typeof result.message === "string" ? result.message : undefined;

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
        ...(typeof result.status === "string" ? { status: result.status } : {}),
        ...(message !== undefined ? { message } : {}),
    };

    // The backend's notice accompanies either a refusal or a partial render.
    if (documents.length === 0 && message !== undefined) {
        return { ...structuredResult(message, structured), isError: false };
    }

    const resets = isoDate(volume?.resets_at ?? null);
    // A shared limit's numbers are not the user's: never "X of 1000 left".
    const shared = volume?.scope === "pool";
    if (documents.length === 0 && volume && volume.used >= volume.limit) {
        return structuredResult(
            shared
                ? "No documents were rendered: this month's documents are used. The limit is shared " +
                    `with other users${resets ? ` and resets on ${resets}` : ""}.`
                : `No documents were rendered: this month's ${volume.limit} documents are used.` +
                    (resets ? ` The count resets on ${resets}.` : ""),
            structured,
        );
    }

    const lines: string[] = [
        ...(message !== undefined ? [message] : []),
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
            (shared
                ? ANON_TEXT.sharedVolume
                : `${Math.max(0, volume.limit - volume.used)} of ${volume.limit} documents left this month`) +
                (resets ? `; the count resets on ${resets}.` : "."),
        );
    }
    if (documents.length > 0) {
        lines.push(`PDF links${expiresAt ? ` (they expire at ${expiresAt})` : ""}:`);
        for (const doc of documents) {
            lines.push(`- Row ${doc.row_index + 1}${doc.label ? `, ${doc.label}` : ""}: ${doc.pdf_url ?? "(no link)"}`);
        }
    }
    return { ...structuredResult(lines.join("\n"), structured), ...(message !== undefined ? { isError: false } : {}) };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface AnonServerOptions {
    /** A client carrying the demo API key, one per HTTP request. */
    client: SheetRenderClient;
    /** Shared across requests: the flood guard. */
    limiter: SlidingWindowLimiter;
    /** Separate shared bucket for all requests from Claude's network. */
    claudeLimiter?: SlidingWindowLimiter;
    /**
     * Coarser bucket for callers counted by IP (`ip:` subjects outside
     * Claude's network), keyed by IPv4 /24 or IPv6 /48.
     */
    networkLimiter?: SlidingWindowLimiter;
    /** Shared across requests: the catalogue cache. */
    catalogue: CatalogueCache;
    /** The caller's IP, the limiter key when there is no subject. */
    clientIp: string;
    /** Addresses whose `openai/subject` is believed; OpenAI's published list by default. */
    openaiEgress?: CidrSet;
    /**
     * The `Mcp-Session-Id` the request carried. Only its hash goes upstream,
     * and only for a Claude caller; it is never logged.
     */
    sessionId?: string;
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

/**
 * Which host is reading the view resource, by network address alone.
 * `resources/read` carries no `openai/subject` (OpenAI's Apps SDK reference
 * lists it for tool calls only), so the tool calls' rule would never see
 * ChatGPT here and ChatGPT would never get `ui.domain`. Only the format of
 * `ui.domain` depends on this; a wrong guess changes no identity or count.
 */
export function resourceHost(clientIp: string, openaiEgress: CidrSet = DEFAULT_OPENAI_EGRESS): Source {
    if (isClaudeIp(clientIp)) return "claude";
    return openaiEgress.has(clientIp) ? "chatgpt" : "other";
}

/** The handoff page parameter that records where a signup came from. */
function refFor(source: Source): string {
    return source === "other" ? "mcp" : source;
}

/**
 * Builds the anonymous MCP server for one HTTP request.
 */
export function createAnonServer(options: AnonServerOptions): McpServer {
    const { client, limiter, claudeLimiter, networkLimiter, catalogue, clientIp, publicUrl, sessionId } = options;
    const openaiEgress = options.openaiEgress ?? DEFAULT_OPENAI_EGRESS;
    const claudeCaller = isClaudeIp(clientIp);
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

    /** anonToolError, with the same check against a reflected credential. */
    function failure(error: unknown, what: string): CallToolResult {
        const result = anonToolError(error, what);
        const secret = options.demoApiKey;
        const body = JSON.stringify(result);
        return secret && (body.includes(secret) || body.includes(encodeURIComponent(secret)))
            ? errorResult(`${what} failed on the SheetRender side. Try again shortly.`)
            : result;
    }

    /**
     * The text-length message for rows over their field's cap. With the
     * catalogue unavailable it is skipped and the backend, which enforces the
     * same caps, has the last word.
     */
    async function overlong(key: TemplateKey, rows: Record<string, Cell>[]): Promise<string | undefined> {
        try {
            const template = (await catalogue.get(client)).find((item) => item.key === key);
            return template ? checkRows(template, rows) : undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * The flood guard, or the result to return when the caller is over it.
     * Every bucket that applies must have room; a call is then counted in
     * all of them, and a refused call in none.
     *
     *   Claude's network: one shared bucket for all of it, plus the
     *     per-subject bucket for a caller with a session (`mcps:`). Without a
     *     session, Claude callers share addresses, so the shared bucket alone.
     *   Everyone else: the per-subject bucket, plus, for a caller counted by
     *     IP (`ip:`), the per-network bucket (IPv4 /24, IPv6 /48).
     */
    function guard(extra: RequestExtra): CallToolResult | undefined {
        const subject = subjectKey(extra._meta, clientIp, sessionId, openaiEgress);
        const shared = claudeCaller && claudeLimiter !== undefined;
        const buckets: Array<[SlidingWindowLimiter, string, string]> = [];
        if (shared) buckets.push([claudeLimiter, "claude:160.79.104.0/21", ANON_TEXT.tooManySharedCalls]);
        if (!shared || subject.startsWith("mcps:")) buckets.push([limiter, subject, ANON_TEXT.tooManyCalls]);
        if (!claudeCaller && networkLimiter && subject.startsWith("ip:")) {
            buckets.push([networkLimiter, `net:${sha256(floodNetwork(clientIp))}`, ANON_TEXT.tooManyNetworkCalls]);
        }
        for (const [bucket, key, message] of buckets) {
            const decision = bucket.check(key);
            if (decision.allowed) continue;
            const minutes = Math.max(1, Math.ceil(decision.retryAfterMs / 60_000));
            return errorResult(message.replace("{minutes}", String(minutes)));
        }
        for (const [bucket, key] of buckets) bucket.take(key);
        return undefined;
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
                    const fields = template.fields.map((field) => {
                        const notes = [
                            ...(field.required ? ["required"] : []),
                            ...(field.max_chars !== MAX_CELL_CHARS ? [`up to ${field.max_chars} characters`] : []),
                            ...(field.max_lines !== undefined ? [`up to ${field.max_lines} lines`] : []),
                        ];
                        return `  - ${field.key}${notes.length ? ` (${notes.join(", ")})` : ""}` +
                            (field.description ? `: ${field.description}` : "");
                    });
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
                return failure(error, "Listing document templates");
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
            // OpenAI's annotation rules (developers.openai.com/apps-sdk/app-submission-guidelines):
            // not read-only, since it stores the PDFs and previews for an hour
            // and counts against the month's volume; not destructive, since it
            // only adds files and deletes or overwrites nothing; not idempotent,
            // since a repeat makes new files and counts again; closed world,
            // since it fills four built-in templates into SheetRender's own
            // storage and reaches no arbitrary destination.
            annotations: {
                title: ANON_TEXT.renderTitle,
                readOnlyHint: false,
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
                const tooLong = await overlong(template, rows as Record<string, Cell>[]);
                if (tooLong) return errorResult(tooLong);
                const source = callerSource(extra._meta, userAgentOf(extra), clientIp, openaiEgress);
                const result = await client.renderBuiltin(template, {
                    rows: rows as Record<string, Cell>[],
                    title,
                    subject: subjectKey(extra._meta, clientIp, sessionId, openaiEgress),
                    source,
                    // Claude sends no per-user id, so its callers also share a monthly pool.
                    ...(claudeCaller ? { pool: "claude" as const } : {}),
                });
                return safeResult(buildRenderResult(template, rows.length, result, apiUrl));
            } catch (error) {
                return failure(error, "Rendering documents");
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
                const tooLong = await overlong(template, rows as Record<string, Cell>[]);
                if (tooLong) return errorResult(tooLong);
                const source = callerSource(extra._meta, userAgentOf(extra), clientIp, openaiEgress);
                const input: HandoffInput = {
                    template,
                    rows: rows as Record<string, Cell>[],
                    title,
                    subject: subjectKey(extra._meta, clientIp, sessionId, openaiEgress),
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
                const rowsSaved = handoff.rows_saved;
                if (typeof rowsSaved !== "number" || !Number.isSafeInteger(rowsSaved) || rowsSaved < 0) {
                    throw new SheetRenderError("Creating the continue link failed: no valid row count came back.");
                }
                // The token rides in the fragment, so it never reaches a
                // server log or a Referer header.
                const url = safeContinueUrl(handoff.continue_url, apiOrigin, template) ??
                    `${apiOrigin}/templates/${TEMPLATE_SLUGS[template]}` +
                        `?ref=${refFor(source)}#handoff=${encodeURIComponent(handoff.token)}&rows=${rowsSaved}`;
                const expiresAt = typeof handoff.expires_at === "string" ? handoff.expires_at : null;
                return safeResult(structuredResult(
                    `Your ${plural(rowsSaved, "row is", "rows are")} loaded on the template page: ${url}\n` +
                        "The link expires in 7 days.",
                    { continue_url: url, expires_at: expiresAt, rows_saved: rowsSaved },
                ));
            } catch (error) {
                return failure(error, "Creating the continue link");
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
        async (uri) => {
            const host = resourceHost(clientIp, openaiEgress);
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
