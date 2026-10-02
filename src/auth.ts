/** OAuth discovery, introspection and per-tool challenges for the hosted server. */
import { createHash } from "node:crypto";

export const OAUTH_SCOPES = ["profile", "render", "design", "jobs"] as const;
export type OAuthScope = typeof OAUTH_SCOPES[number];

export const PROTECTED_TOOL_SCOPES = {
    get_profile: "profile",
    list_templates: "render",
    render_template: "render",
    create_dataset: "render",
    list_datasets: "render",
    design_template: "design",
    get_design: "design",
    create_batch_job: "jobs",
    get_job: "jobs",
    get_document: "jobs",
    create_schedule: "jobs",
    list_schedules: "jobs",
} as const satisfies Record<string, OAuthScope>;

export const PROTECTED_TOOLS: ReadonlySet<string> = new Set(Object.keys(PROTECTED_TOOL_SCOPES));
export const ANONYMOUS_TOOLS: ReadonlySet<string> = new Set([
    "list_document_templates", "render_documents", "create_continue_link",
]);

export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource/mcp";
export const OAUTH_CACHE_MS = 60_000;
export const OAUTH_NEGATIVE_CACHE_MS = 5_000;
const MAX_CACHE_ENTRIES = 10_000;
const INTROSPECTION_TIMEOUT_MS = 5_000;

export interface OAuthOptions {
    oauthIssuer?: string;
    introspectSecret?: string;
    publicUrl?: string;
}

export interface OAuthConfig {
    issuer: string;
    secret: string;
    resource: string;
    metadataUrl: string;
}

/** Partial configuration leaves the legacy server enabled. Never infer public URLs from headers. */
export function oauthConfig(options: OAuthOptions): OAuthConfig | undefined {
    const issuer = options.oauthIssuer?.trim();
    const secret = options.introspectSecret?.trim();
    if (!issuer || !secret) return undefined;
    const origin = checkedUrl(issuer, "OAUTH_ISSUER");
    if (origin.pathname !== "/" || origin.search || origin.hash) {
        throw new Error("OAUTH_ISSUER must be an http(s) origin without a path, query or fragment.");
    }
    if (!options.publicUrl) throw new Error("MCP_PUBLIC_URL is required when OAuth is enabled.");
    const resource = checkedUrl(options.publicUrl, "MCP_PUBLIC_URL");
    if (resource.search || resource.hash) {
        throw new Error("MCP_PUBLIC_URL must not contain a query or fragment when OAuth is enabled.");
    }
    return {
        issuer: origin.origin,
        secret,
        resource: options.publicUrl,
        metadataUrl: `${resource.origin}${PROTECTED_RESOURCE_PATH}`,
    };
}

function checkedUrl(raw: string, name: string): URL {
    try {
        const url = new URL(raw);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
        return url;
    } catch {
        // Configuration can contain secrets; do not echo it in a startup error.
        throw new Error(`${name} must be an http(s) URL without credentials.`);
    }
}

export function protectedResourceMetadata(config: OAuthConfig) {
    return {
        resource: config.resource,
        authorization_servers: [config.issuer],
        scopes_supported: [...OAUTH_SCOPES],
        bearer_methods_supported: ["header"],
    };
}

export type TokenStatus = { active: false } | { active: true; scopes: readonly string[]; expiresAt: number };
const INACTIVE: TokenStatus = { active: false };

/** A fixed local message prevents upstream errors from reflecting credentials. */
export class IntrospectionUnavailable extends Error {
    constructor() {
        super("SheetRender sign-in verification is temporarily unavailable. Retry shortly.");
        this.name = "IntrospectionUnavailable";
    }
}

export function tokenHash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

/** Positive and negative caches, plus concurrent lookups, use only SHA-256 keys. */
export class TokenIntrospector {
    readonly #cache = new Map<string, { value: TokenStatus; until: number }>();
    readonly #pending = new Map<string, Promise<TokenStatus>>();
    readonly #url: string;
    readonly #config: OAuthConfig;
    readonly #now: () => number;
    readonly #fetch: typeof fetch;

    constructor(apiUrl: string, config: OAuthConfig, options: { now?: () => number; fetch?: typeof fetch } = {}) {
        this.#url = `${apiUrl.replace(/\/+$/, "")}/api/oauth/introspect`;
        this.#config = config;
        this.#now = options.now ?? Date.now;
        this.#fetch = options.fetch ?? fetch;
    }

    /** Cached validation alone can lift admission limits before the request body is read. */
    peek(token: string): TokenStatus | undefined {
        const hash = tokenHash(token);
        const entry = this.#cache.get(hash);
        if (!entry) return undefined;
        if (entry.until > this.#now()) return entry.value;
        this.#cache.delete(hash);
        return undefined;
    }

    async introspect(token: string): Promise<TokenStatus> {
        // Refresh tokens and malformed access tokens never reach the backend.
        if (!/^sro_[A-Za-z0-9_-]{43}$/.test(token)) return INACTIVE;
        const cached = this.peek(token);
        if (cached) return cached;
        const hash = tokenHash(token);
        const pending = this.#pending.get(hash);
        if (pending) return pending;
        const lookup = this.#lookup(token).then((value) => {
            const until = value.active
                ? Math.min(this.#now() + OAUTH_CACHE_MS, value.expiresAt)
                : this.#now() + OAUTH_NEGATIVE_CACHE_MS;
            while (this.#cache.size >= MAX_CACHE_ENTRIES) {
                const oldest = this.#cache.keys().next().value;
                if (oldest === undefined) break;
                this.#cache.delete(oldest);
            }
            this.#cache.set(hash, { value, until });
            return value;
        }).finally(() => this.#pending.delete(hash));
        this.#pending.set(hash, lookup);
        return lookup;
    }

    async #lookup(token: string): Promise<TokenStatus> {
        try {
            const response = await this.#fetch(this.#url, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${this.#config.secret}`,
                    "Content-Type": "application/x-www-form-urlencoded",
                    Accept: "application/json",
                },
                body: new URLSearchParams({ token }).toString(),
                signal: AbortSignal.timeout(INTROSPECTION_TIMEOUT_MS),
                redirect: "error",
            });
            if (!response.ok) {
                await response.body?.cancel();
                throw new IntrospectionUnavailable();
            }
            const body: unknown = await response.json();
            if (!body || typeof body !== "object" || !("active" in body)) throw new IntrospectionUnavailable();
            const result = body as Record<string, unknown>;
            if (result.active === false) return INACTIVE;
            if (result.active !== true) throw new IntrospectionUnavailable();
            const tokenType = typeof result.token_type === "string" ? result.token_type.toLowerCase() : undefined;
            // Keep the original backend value compatible while it switches to Bearer.
            if (!Array.isArray(result.aud) || !result.aud.includes(this.#config.resource) ||
                typeof result.exp !== "number" || !Number.isFinite(result.exp) || result.exp * 1000 <= this.#now() ||
                (tokenType !== "bearer" && tokenType !== "access_token") || typeof result.scope !== "string") return INACTIVE;
            return { active: true, scopes: result.scope.split(/\s+/).filter(Boolean), expiresAt: result.exp * 1000 };
        } catch {
            // Do not retain stale positives or cache an outage as a bad credential.
            throw new IntrospectionUnavailable();
        }
    }
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown> : undefined;
}

export function toolName(message: unknown): string | undefined {
    const request = record(message);
    const name = record(request?.params)?.name;
    return request?.method === "tools/call" && typeof name === "string" ? name : undefined;
}

/** This guess selects the error format only; it never establishes identity or lifts a limit. */
export function isChatGptCall(message: unknown, userAgent?: string): boolean {
    const meta = record(record(record(message)?.params)?._meta);
    return Boolean(meta && Object.keys(meta).some((key) => key.startsWith("openai/"))) ||
        /\b(?:chatgpt|openai)\b/i.test(userAgent ?? "");
}

export interface AuthFailure {
    status: 401 | 403;
    challenge: string;
    message: string;
    error: "invalid_token" | "insufficient_scope";
}

export function authorizeTool(message: unknown, token: TokenStatus | undefined, config: OAuthConfig): AuthFailure | undefined {
    const name = toolName(message);
    if (!name || !PROTECTED_TOOLS.has(name)) return undefined;
    const scope = PROTECTED_TOOL_SCOPES[name as keyof typeof PROTECTED_TOOL_SCOPES];
    if (!token?.active) {
        const message = "Requires a signed-in SheetRender account.";
        return {
            status: 401,
            challenge: `Bearer resource_metadata="${config.metadataUrl}", scope="${OAUTH_SCOPES.join(" ")}", error="invalid_token", error_description="${message}"`,
            message,
            error: "invalid_token",
        };
    }
    if (!token.scopes.includes(scope)) {
        const message = `SheetRender sign-in needs the ${scope} scope for this tool.`;
        return {
            status: 403,
            challenge: `Bearer resource_metadata="${config.metadataUrl}", error="insufficient_scope", scope="${scope}", error_description="${message}"`,
            message,
            error: "insufficient_scope",
        };
    }
    return undefined;
}

/** Builds a JSON-RPC response before an SDK transport or account tool is created. */
export function authFailureResponse(message: unknown, failure: AuthFailure, chatgpt: boolean) {
    const id = record(message)?.id;
    const envelope = { jsonrpc: "2.0", id: typeof id === "string" || typeof id === "number" ? id : null };
    return chatgpt
        ? { ...envelope, result: {
            isError: true,
            content: [{ type: "text", text: failure.message }],
            _meta: { "mcp/www_authenticate": [failure.challenge] },
        } }
        : { ...envelope, error: { code: -32001, message: failure.message, data: { error: failure.error } } };
}
