/**
 * The MCP Apps view for render_documents: one HTML resource,
 * `ui://sheetrender/documents.html`, served as `text/html;profile=mcp-app`.
 *
 * The view's script is `src/widget/documents.ts`, bundled by esbuild
 * (`scripts/build-widget.mjs`) into `dist/widget/documents.js` and inlined
 * into the HTML here. The bundle is read once per process, on first use.
 *
 * The constants below are the values `@modelcontextprotocol/ext-apps/server`
 * exports. That package is a dev dependency only (it is bundled into the view),
 * so the server keeps its two runtime dependencies; a test pins the values to
 * the package's own.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const WIDGET_URI = "ui://sheetrender/documents.html";
/** `RESOURCE_MIME_TYPE` in ext-apps. */
export const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
/** `RESOURCE_URI_META_KEY` in ext-apps: the flat alias of `_meta.ui.resourceUri`. */
export const RESOURCE_URI_META_KEY = "ui/resourceUri";

/** Where the build puts the bundle, next to this module's compiled output. */
export const WIDGET_BUNDLE_URL = new URL("./widget/documents.js", import.meta.url);

let cachedBundle: string | undefined;

/** The bundled view script. Throws with a build hint when it is missing. */
export function loadWidgetBundle(): string {
    if (cachedBundle !== undefined) return cachedBundle;
    const path = fileURLToPath(WIDGET_BUNDLE_URL);
    try {
        cachedBundle = readFileSync(path, "utf8");
    } catch (error) {
        throw new Error(
            `The widget bundle is missing at ${path} (${error instanceof Error ? error.message : String(error)}). ` +
                "Run `deno task build`, which bundles it after compiling the server.",
        );
    }
    return cachedBundle;
}

/**
 * Claude's sandbox origin for this server: the first 32 hex characters of the
 * SHA-256 of the server URL, then `.claudemcpcontent.com`. Claude rejects any
 * other value with "ui.domain mismatch".
 */
export function claudeWidgetDomain(publicUrl: string): string {
    return `${createHash("sha256").update(publicUrl).digest("hex").slice(0, 32)}.claudemcpcontent.com`;
}

export interface WidgetMetaOptions {
    /** Origin the previews and PDF links come from: the API's origin. */
    apiOrigin: string;
    /** The URL users paste for this server, e.g. https://mcp.sheetrender.com/mcp. */
    publicUrl?: string;
    /** Which host is reading the resource. Decides the `ui.domain` format. */
    host: "chatgpt" | "claude" | "other";
}

/**
 * `_meta` for the resource and its content item.
 *
 * `ui.domain` has a different format on each host: ChatGPT wants an origin
 * (it derives its own sandbox host from it), Claude wants its hash host. A
 * value in the wrong format breaks the view, so it is only sent when the host
 * is known; otherwise the host picks its default sandbox origin. ChatGPT's
 * compatibility alias `openai/widgetDomain` always carries the origin, which
 * Claude ignores.
 */
export function widgetResourceMeta(options: WidgetMetaOptions): Record<string, unknown> {
    const publicOrigin = options.publicUrl ? new URL(options.publicUrl).origin : undefined;
    const ui: Record<string, unknown> = {
        csp: { resourceDomains: [options.apiOrigin] },
        prefersBorder: true,
    };
    if (options.publicUrl && options.host === "claude") ui.domain = claudeWidgetDomain(options.publicUrl);
    if (publicOrigin && options.host === "chatgpt") ui.domain = publicOrigin;

    const meta: Record<string, unknown> = {
        ui,
        "openai/widgetPrefersBorder": true,
        "openai/widgetDescription":
            "Shows a preview of each rendered document with a link to its PDF.",
        // The legacy ChatGPT CSP: snake_case, and redirect_domains is what
        // lets the view open the API origin without a confirmation prompt.
        "openai/widgetCSP": {
            connect_domains: [],
            resource_domains: [options.apiOrigin],
            redirect_domains: [options.apiOrigin],
        },
    };
    if (publicOrigin) meta["openai/widgetDomain"] = publicOrigin;
    return meta;
}

/** Makes a script safe to inline: no `</script` can end the element early. */
function inlineScript(source: string): string {
    // A hex escape is valid in both strings and Unicode regex literals;
    // escaping `!` instead would make /<!--/u an invalid regular expression.
    return source.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "\\x3c!--");
}

function escapeAttribute(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * The full HTML document. `apiOrigin` goes into a data attribute: the view
 * only shows images from, and only opens links to, that origin.
 */
export function widgetHtml(apiOrigin: string, bundle: string = loadWidgetBundle()): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Documents</title>
<style>${WIDGET_CSS}</style>
</head>
<body>
<main id="root" data-origin="${escapeAttribute(apiOrigin)}" aria-live="polite"></main>
<script type="module">${inlineScript(bundle)}</script>
</body>
</html>`;
}

const WIDGET_CSS = `
:root {
  color-scheme: light dark;
  --sr-bg: var(--color-background-primary, #ffffff);
  --sr-bg-2: var(--color-background-secondary, #f4f4f5);
  --sr-text: var(--color-text-primary, #18181b);
  --sr-muted: var(--color-text-secondary, #52525b);
  --sr-border: var(--color-border-primary, #e4e4e7);
  --sr-warn: var(--color-text-warning, #a16207);
  --sr-radius: var(--border-radius-md, 8px);
  --sr-font: var(--font-sans, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --sr-bg: var(--color-background-primary, #18181b);
    --sr-bg-2: var(--color-background-secondary, #27272a);
    --sr-text: var(--color-text-primary, #fafafa);
    --sr-muted: var(--color-text-secondary, #a1a1aa);
    --sr-border: var(--color-border-primary, #3f3f46);
    --sr-warn: var(--color-text-warning, #facc15);
  }
}
:root[data-theme="dark"] {
  --sr-bg: var(--color-background-primary, #18181b);
  --sr-bg-2: var(--color-background-secondary, #27272a);
  --sr-text: var(--color-text-primary, #fafafa);
  --sr-muted: var(--color-text-secondary, #a1a1aa);
  --sr-border: var(--color-border-primary, #3f3f46);
  --sr-warn: var(--color-text-warning, #facc15);
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--sr-bg); color: var(--sr-text); font: 14px/1.45 var(--sr-font); }
main { padding: 16px; display: grid; gap: 12px; }
h1 { font-size: 16px; font-weight: 600; margin: 0; }
p { margin: 0; }
.muted { color: var(--sr-muted); }
.strip { display: flex; gap: 12px; overflow-x: auto; padding-bottom: 4px; scroll-snap-type: x proximity; }
.doc { flex: 0 0 auto; min-width: 140px; max-width: 296px; scroll-snap-align: start; display: grid; gap: 6px; margin: 0; }
.doc img { height: 200px; width: auto; max-width: 296px; object-fit: contain; background: #ffffff;
  border: 1px solid var(--sr-border); border-radius: var(--sr-radius); display: block; }
.doc figcaption { display: flex; justify-content: space-between; align-items: center; gap: 6px; min-width: 0; }
.doc .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
button { font: inherit; cursor: pointer; border-radius: var(--sr-radius); border: 1px solid var(--sr-border);
  background: var(--sr-bg-2); color: var(--sr-text); padding: 4px 10px; }
button:hover:not(:disabled) { border-color: var(--sr-muted); }
button:disabled { cursor: default; opacity: .6; }
button:focus-visible { outline: 2px solid var(--sr-text); outline-offset: 2px; }
.warn { color: var(--sr-warn); }
.warn ul { margin: 4px 0 0; padding-left: 18px; }
.continue { display: grid; gap: 4px; justify-items: start; border-top: 1px solid var(--sr-border); padding-top: 12px; }
.continue button { padding: 6px 12px; }
`;
