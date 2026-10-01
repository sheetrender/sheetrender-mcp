/**
 * The render_documents view, running in the host's sandboxed iframe (ChatGPT,
 * Claude, any MCP Apps host). Bundled by scripts/build-widget.mjs; never
 * imported by the server.
 *
 * It shows the PNG previews with a PDF link each, the rows that missed a
 * required field, the documents left this month, and one secondary button that
 * calls create_continue_link with the rows from the tool input and opens the
 * returned link. Every string is set with textContent, never as HTML, and
 * images and links are only used when they point at the API origin the server
 * wrote into `data-origin`.
 */

import {
    App,
    applyDocumentTheme,
    applyHostFonts,
    applyHostStyleVariables,
    type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";

interface DocumentItem {
    row_index: number;
    label: string | null;
    preview_png_url: string | null;
    pdf_url: string | null;
}

interface RenderOutput {
    template: string;
    template_name?: string;
    rows_received: number;
    rows_rendered: number;
    documents: DocumentItem[];
    expires_at: string | null;
    missing_fields: { row_index: number; fields: string[] }[];
    volume: { used: number; limit: number; resets_at: string | null } | null;
    /** The server's own notice, with either a refusal or a partial render. */
    message?: string;
}

interface RenderInput {
    template?: string;
    rows?: Record<string, unknown>[];
    title?: string;
}

const root = document.getElementById("root") as HTMLElement;
const allowedOrigin = root.dataset.origin ?? "";

let input: RenderInput | undefined;
let output: RenderOutput | undefined;
let failure: string | undefined;
let locale: string | undefined;

/** A URL on the API origin, or undefined. */
function safeUrl(raw: unknown): string | undefined {
    if (typeof raw !== "string" || !raw) return undefined;
    try {
        const url = new URL(raw);
        if (url.origin !== allowedOrigin) return undefined;
        if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
        if (url.username || url.password) return undefined;
        return url.href;
    } catch {
        return undefined;
    }
}

function formatDate(iso: string | null | undefined): string | undefined {
    if (!iso) return undefined;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return undefined;
    try {
        return date.toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
    } catch {
        return date.toISOString().slice(0, 10);
    }
}

function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text?: string,
    className?: string,
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
}

const app = new App({ name: "SheetRender documents", version: "1.0.0" }, {}, { autoResize: true });

async function open(url: string): Promise<void> {
    const result = await app.openLink({ url });
    if (result.isError) throw new Error("The link could not be opened.");
}

function plural(count: number, one: string, many: string): string {
    return `${count} ${count === 1 ? one : many}`;
}

function render(): void {
    root.replaceChildren();

    if (failure) {
        root.append(el("p", failure, "warn"));
        return;
    }
    if (!output) {
        root.append(el("p", "Rendering documents…", "muted"));
        return;
    }

    const documents = Array.isArray(output.documents) ? output.documents : [];
    const header = el("div");
    const message = typeof output.message === "string" && output.message
        ? output.message
        : undefined;
    header.append(el("h1", documents.length === 0 && message ? "No documents rendered" : `${plural(documents.length, "document", "documents")} ready`));
    const name = output.template_name ?? output.template;
    if (name) header.append(el("p", name, "muted"));
    root.append(header);

    const volume = output.volume;
    const resets = formatDate(volume?.resets_at);
    if (message) {
        root.append(el("p", message, "warn"));
    } else if (documents.length === 0 && volume && volume.used >= volume.limit) {
        root.append(el(
            "p",
            `This month's ${volume.limit} documents are used.${resets ? ` The count resets on ${resets}.` : ""}`,
            "warn",
        ));
    }

    if (documents.length > 0) {
        const strip = el("div", undefined, "strip");
        for (const item of documents) {
            const label = item.label || `Row ${item.row_index + 1}`;
            const figure = el("figure", undefined, "doc");
            const preview = safeUrl(item.preview_png_url);
            if (preview) {
                const image = el("img");
                image.src = preview;
                image.alt = `Preview: ${label}`;
                image.loading = "lazy";
                figure.append(image);
            }
            const caption = el("figcaption");
            const text = el("span", label, "label");
            text.title = label;
            caption.append(text);
            const pdf = safeUrl(item.pdf_url);
            if (pdf) {
                const button = el("button", "PDF");
                button.type = "button";
                button.setAttribute("aria-label", `Open the PDF for ${label}`);
                button.addEventListener("click", async () => {
                    try {
                        await open(pdf);
                    } catch {
                        button.textContent = "Could not open PDF";
                    }
                });
                caption.append(button);
            }
            figure.append(caption);
            strip.append(figure);
        }
        root.append(strip);
        const expires = output.expires_at ? new Date(output.expires_at) : undefined;
        if (expires && !Number.isNaN(expires.getTime())) {
            root.append(el("p", "Preview and PDF links work for one hour.", "muted"));
        }
    }

    const missing = Array.isArray(output.missing_fields) ? output.missing_fields : [];
    if (missing.length > 0) {
        const box = el("div", undefined, "warn");
        box.append(el("p", `${plural(missing.length, "row is", "rows are")} missing a required field:`));
        const list = el("ul");
        for (const entry of missing) {
            list.append(el("li", `Row ${entry.row_index + 1}: ${entry.fields.join(", ")}`));
        }
        box.append(list);
        root.append(box);
    }

    if (volume && documents.length > 0) {
        const left = Math.max(0, volume.limit - volume.used);
        root.append(el(
            "p",
            `${left} of ${volume.limit} documents left this month${resets ? `; the count resets on ${resets}` : ""}.`,
            "muted",
        ));
    }

    const rows = Array.isArray(input?.rows) ? input.rows : undefined;
    const template = input?.template ?? output.template;
    if (rows && rows.length > 0 && template) {
        const section = el("div", undefined, "continue");
        const button = el("button", "Continue in SheetRender with these rows");
        button.type = "button";
        const caption = el("p", "Keep the rows as a project, connect a Google Sheet, run it on a schedule.", "muted");
        const status = el("p", undefined, "warn");
        button.addEventListener("click", async () => {
            button.disabled = true;
            status.textContent = "";
            try {
                const args: Record<string, unknown> = { template, rows };
                if (input?.title) args.title = input.title;
                const result = await app.callServerTool({ name: "create_continue_link", arguments: args });
                const link = safeUrl((result.structuredContent as { continue_url?: unknown } | undefined)?.continue_url);
                if (result.isError || !link) throw new Error("no link");
                await open(link);
            } catch {
                status.textContent = "The link could not be created. Try again in a moment.";
            } finally {
                button.disabled = false;
            }
        });
        section.append(button, caption, status);
        root.append(section);
    }
}

function applyContext(context: McpUiHostContext | undefined): void {
    if (!context) return;
    if (context.theme) applyDocumentTheme(context.theme);
    if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
    if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
    if (context.locale) locale = context.locale;
}

app.ontoolinput = (params) => {
    input = (params.arguments ?? {}) as RenderInput;
    render();
};

app.ontoolresult = (params) => {
    if (params.isError) {
        const text = params.content?.find((item) => item.type === "text");
        failure = text && "text" in text ? text.text : "The documents could not be rendered.";
    } else {
        failure = undefined;
        output = params.structuredContent as RenderOutput | undefined;
    }
    render();
};

app.onhostcontextchanged = (context) => {
    applyContext(context as McpUiHostContext);
    render();
};

render();
app.connect().then(() => {
    applyContext(app.getHostContext());
    render();
}).catch(() => {
    failure = "This view could not connect to the conversation.";
    render();
});
