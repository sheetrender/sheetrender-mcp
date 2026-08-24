/**
 * Typed fetch wrapper for the SheetRender public API (`/api/v1`).
 *
 * The backend is FastAPI, so every error body is `{"detail": ...}` where the
 * detail is usually a string, sometimes an object (plan-limit errors) and
 * sometimes the default 422 validation array. `SheetRenderError` normalises all
 * three into one readable message and keeps the status code around so callers
 * can branch on it.
 */

const DEFAULT_BASE_URL = "https://sheetrender.com";

/** JSON request timeout. Template listings and job polls are quick. */
const JSON_TIMEOUT_MS = 30_000;
/** Render timeout. A Chromium render of a large document is not quick. */
const RENDER_TIMEOUT_MS = 180_000;
/**
 * Dataset timeout. A 20 MB workbook has to be uploaded, parsed and stored, and
 * 50,000 JSON rows are written out as a workbook and parsed straight back.
 */
const DATASET_TIMEOUT_MS = 120_000;

export interface SheetRenderConfig {
    baseUrl: string;
    apiKey: string;
}

export interface TemplateSummary {
    id: string;
    name: string;
    created_at: string | null;
    updated_at: string | null;
}

export interface DatasetColumn {
    /**
     * The sanitized column key. This — not `original` — is what a template's
     * placeholders and a job's `group_by` address the column by.
     */
    key: string;
    /** The header text as it appeared in the spreadsheet or JSON rows. */
    original: string;
    inferred_type: "string" | "number";
}

export interface DatasetSummary {
    id: string;
    filename: string | null;
    sheet_name: string | null;
    columns: DatasetColumn[];
    row_count: number | null;
    created_at: string | null;
}

export interface JobDocument {
    id: string;
    filename: string | null;
}

export interface JobStatus {
    id: string;
    status: string;
    rows_total: number | null;
    rows_done: number | null;
    rows_failed: number | null;
    created_at: string | null;
    finished_at: string | null;
    documents: JobDocument[];
    merged_available: boolean;
    zip_available: boolean;
}

export interface CreatedJob {
    job_id: string;
}

export interface Margins {
    top?: number;
    right?: number;
    bottom?: number;
    left?: number;
}

export interface PageSettings {
    page_size?: string;
    orientation?: "portrait" | "landscape";
    margins?: Margins;
}

/**
 * Job statuses that mean the job has stopped: it will not progress further and
 * its document list is final. Anything else means it is still in flight.
 */
export const TERMINAL_JOB_STATUSES = new Set([
    "succeeded",
    "partial",
    "failed",
    "cancelled",
]);

export class SheetRenderError extends Error {
    readonly status?: number;
    /** The raw `detail` value from the API body, when there was one. */
    readonly detail?: unknown;

    constructor(message: string, status?: number, detail?: unknown) {
        super(message);
        this.name = "SheetRenderError";
        this.status = status;
        this.detail = detail;
    }
}

/**
 * Reads configuration from the environment. Throws a `SheetRenderError` with a
 * message meant for a human reading stderr, not for the model.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): SheetRenderConfig {
    const apiKey = env.SHEETRENDER_API_KEY?.trim();
    if (!apiKey) {
        throw new SheetRenderError(
            "SHEETRENDER_API_KEY is not set.\n" +
                "Create a key at https://sheetrender.com -> Settings -> API keys, then set it\n" +
                'in your MCP client config, e.g. "env": { "SHEETRENDER_API_KEY": "sr_live_..." }.',
        );
    }
    const rawBase = env.SHEETRENDER_API_URL?.trim() || DEFAULT_BASE_URL;
    let baseUrl: string;
    try {
        baseUrl = new URL(rawBase).toString().replace(/\/+$/, "");
    } catch {
        throw new SheetRenderError(
            `SHEETRENDER_API_URL is not a valid URL: ${rawBase}`,
        );
    }
    return { baseUrl, apiKey };
}

/** Flattens FastAPI's several `detail` shapes into one line of text. */
function describeDetail(detail: unknown): string | undefined {
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
        // Default 422 body: [{loc: [...], msg: "...", type: "..."}]
        const parts = detail
            .map((item) => {
                if (item && typeof item === "object") {
                    const record = item as Record<string, unknown>;
                    const loc = Array.isArray(record.loc)
                        ? record.loc.join(".")
                        : undefined;
                    const msg = typeof record.msg === "string" ? record.msg : undefined;
                    if (loc && msg) return `${loc}: ${msg}`;
                    if (msg) return msg;
                }
                return JSON.stringify(item);
            })
            .filter(Boolean);
        return parts.length ? parts.join("; ") : undefined;
    }
    if (detail && typeof detail === "object") {
        // Plan-limit errors use {code, kind, message}.
        const record = detail as Record<string, unknown>;
        if (typeof record.message === "string") {
            return typeof record.code === "string"
                ? `${record.message} (${record.code})`
                : record.message;
        }
        return JSON.stringify(detail);
    }
    return undefined;
}

const STATUS_HINTS: Record<number, string> = {
    401: "the API key was rejected — check SHEETRENDER_API_KEY",
    403: "the account is not allowed to do this",
    404: "not found",
    405: "this endpoint does not exist on this server",
    413: "the request body is too large",
    422: "the request body failed validation",
    500: "the server hit an internal error",
    502: "the server is unreachable through its proxy",
    503: "the server is temporarily unavailable",
};

/**
 * Extra sentences appended to a failure, keyed by status.
 *
 * The status hints above only ever appear when the body carried no detail, and
 * the dataset routes always carry one — a good one, written for a human. What
 * they cannot say is which *other* SheetRender call gets the caller unstuck, so
 * that advice is added here rather than replacing the server's wording.
 */
type StatusAdvice = Record<number, string>;

async function toError(
    response: Response,
    what: string,
    advice?: StatusAdvice,
): Promise<SheetRenderError> {
    let detail: unknown;
    let bodyText = "";
    try {
        bodyText = await response.text();
    } catch {
        // Body already consumed or connection died; fall through to status only.
    }
    if (bodyText) {
        try {
            const parsed = JSON.parse(bodyText) as unknown;
            if (parsed && typeof parsed === "object" && "detail" in parsed) {
                detail = (parsed as { detail: unknown }).detail;
            } else {
                detail = parsed;
            }
        } catch {
            detail = bodyText.slice(0, 400);
        }
    }

    const described = describeDetail(detail);
    const extra = advice?.[response.status];
    const suffix = extra ? ` ${extra}` : "";

    if (response.status === 429) {
        return new SheetRenderError(
            `${what} failed: rate limited, retry shortly (HTTP 429${
                described ? ` — ${described}` : ""
            }).${suffix}`,
            429,
            detail,
        );
    }

    const hint = STATUS_HINTS[response.status];
    const tail = described ?? hint ?? response.statusText ?? "unknown error";
    return new SheetRenderError(
        `${what} failed: ${tail} (HTTP ${response.status}).${suffix}`,
        response.status,
        detail,
    );
}

/**
 * Rejects the row values `JSON.stringify` would quietly rewrite.
 *
 * The server has its own check for these and a better message for most of what
 * a row can hold — but it never sees these three. `JSON.stringify` turns NaN
 * and Infinity into `null` and drops an `undefined` value's key entirely, so
 * without this the server's 400 cannot fire and a bad number lands in the
 * spreadsheet as an empty cell. Everything else — nested objects, oversized
 * integers, the row and cell caps — is left to the server, whose messages name
 * the offending column and whose limits must not be duplicated here to drift.
 */
function assertSerialisableRows(rows: Record<string, unknown>[]): void {
    for (const [index, row] of rows.entries()) {
        for (const [column, value] of Object.entries(row)) {
            if (typeof value === "number" && !Number.isFinite(value)) {
                throw new SheetRenderError(
                    `Row ${index + 1}, column "${column}" is ${
                        Number.isNaN(value) ? "NaN" : String(value)
                    }, which a spreadsheet cell cannot hold. Send a number, a string or null.`,
                );
            }
            if (value === undefined) {
                throw new SheetRenderError(
                    `Row ${index + 1}, column "${column}" is undefined. Use null for a blank ` +
                        "cell, or leave the key out of that row entirely.",
                );
            }
        }
    }
}

/**
 * Advice for the three dataset routes. 404 is deliberate: the API answers a
 * template belonging to someone else with the same "Template not found" as one
 * that never existed, so the only useful next step is re-checking the id.
 */
const DATASET_ADVICE: StatusAdvice = {
    400: "Check the data itself: a file has to be a .csv or .xlsx with a header row, " +
        "and JSON rows have to be flat — no nested objects or arrays, no NaN or Infinity, " +
        "and whole numbers beyond 2^53 sent as strings.",
    404: "Check template_id against list_templates.",
    413: "Split it into smaller datasets and create one job per part.",
};

/** Turns a fetch/network rejection into a `SheetRenderError` with the cause kept. */
function toNetworkError(error: unknown, what: string, baseUrl: string): SheetRenderError {
    if (error instanceof SheetRenderError) return error;
    if (error instanceof DOMException && error.name === "TimeoutError") {
        return new SheetRenderError(`${what} failed: the request to ${baseUrl} timed out.`);
    }
    if (error instanceof DOMException && error.name === "AbortError") {
        return new SheetRenderError(`${what} failed: the request to ${baseUrl} was aborted.`);
    }
    const cause = error instanceof Error && error.cause instanceof Error
        ? `${error.message} (${error.cause.message})`
        : error instanceof Error
        ? error.message
        : String(error);
    return new SheetRenderError(
        `${what} failed: could not reach the SheetRender API at ${baseUrl} — ${cause}.`,
    );
}

interface RequestOptions {
    method: "GET" | "POST";
    path: string;
    /** Human-readable description of the operation, used in error messages. */
    what: string;
    /** JSON-serialised, unless it is a `FormData`, which is sent as multipart. */
    body?: unknown;
    accept: "json" | "pdf";
    timeoutMs?: number;
    /** Per-status sentences appended to the error message. */
    advice?: StatusAdvice;
}

export class SheetRenderClient {
    readonly baseUrl: string;
    readonly #apiKey: string;

    constructor(config: SheetRenderConfig) {
        this.baseUrl = config.baseUrl.replace(/\/+$/, "");
        this.#apiKey = config.apiKey;
    }

    async #send(options: RequestOptions): Promise<Response> {
        const { method, path, what, body, accept } = options;
        const timeoutMs = options.timeoutMs ??
            (accept === "pdf" ? RENDER_TIMEOUT_MS : JSON_TIMEOUT_MS);
        const headers: Record<string, string> = {
            Authorization: `Bearer ${this.#apiKey}`,
            Accept: accept === "pdf" ? "application/pdf" : "application/json",
        };
        const multipart = body instanceof FormData;
        // A multipart Content-Type is deliberately left unset: fetch derives it
        // from the FormData along with the boundary, and naming it here would
        // send a boundary-less header the server cannot split the parts with.
        if (body !== undefined && !multipart) headers["Content-Type"] = "application/json";

        let response: Response;
        try {
            response = await fetch(`${this.baseUrl}${path}`, {
                method,
                headers,
                body: body === undefined
                    ? undefined
                    : multipart
                    ? body
                    : JSON.stringify(body),
                signal: AbortSignal.timeout(timeoutMs),
                redirect: "follow",
            });
        } catch (error) {
            throw toNetworkError(error, what, this.baseUrl);
        }
        if (!response.ok) throw await toError(response, what, options.advice);
        return response;
    }

    async #json<T>(options: RequestOptions): Promise<T> {
        const response = await this.#send(options);
        const text = await response.text();
        try {
            return JSON.parse(text) as T;
        } catch {
            throw new SheetRenderError(
                `${options.what} failed: the server returned a non-JSON response ` +
                    `(${response.headers.get("content-type") ?? "no content-type"}): ` +
                    `${text.slice(0, 200)}`,
                response.status,
            );
        }
    }

    async #pdf(options: RequestOptions): Promise<Uint8Array> {
        const response = await this.#send(options);
        const contentType = response.headers.get("content-type") ?? "";
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!contentType.includes("application/pdf") && !isPdf(bytes)) {
            const preview = new TextDecoder().decode(bytes.slice(0, 200));
            throw new SheetRenderError(
                `${options.what} failed: expected a PDF but got ` +
                    `${contentType || "an unlabelled response"}: ${preview}`,
                response.status,
            );
        }
        if (bytes.byteLength === 0) {
            throw new SheetRenderError(`${options.what} failed: the server returned an empty PDF.`);
        }
        return bytes;
    }

    /** POST /api/v1/renders — render an ad-hoc HTML document to PDF bytes. */
    renderHtml(
        html: string,
        data?: Record<string, unknown>,
        pageSettings?: PageSettings,
    ): Promise<Uint8Array> {
        const body: Record<string, unknown> = { html };
        if (data !== undefined) body.data = data;
        if (pageSettings !== undefined) body.page_settings = pageSettings;
        return this.#pdf({
            method: "POST",
            path: "/api/v1/renders",
            what: "Rendering HTML to PDF",
            body,
            accept: "pdf",
        });
    }

    /** GET /api/v1/templates — the account's saved templates. */
    listTemplates(): Promise<TemplateSummary[]> {
        return this.#json<TemplateSummary[]>({
            method: "GET",
            path: "/api/v1/templates",
            what: "Listing templates",
            accept: "json",
        });
    }

    /** POST /api/v1/templates/{id}/render — render a saved template to PDF bytes. */
    renderTemplate(
        templateId: string,
        data: Record<string, unknown>,
        pageSettings?: PageSettings,
    ): Promise<Uint8Array> {
        const body: Record<string, unknown> = { data };
        // Omitting page_settings entirely makes the server use the template's own
        // stored settings; sending {} would override them with global defaults.
        if (pageSettings !== undefined) body.page_settings = pageSettings;
        return this.#pdf({
            method: "POST",
            path: `/api/v1/templates/${encodeURIComponent(templateId)}/render`,
            what: `Rendering template ${templateId}`,
            body,
            accept: "pdf",
        });
    }

    /**
     * POST /api/v1/templates/{id}/datasets/rows — a dataset from JSON rows.
     *
     * The server builds the header from the union of the row keys in first-seen
     * order, so a row that omits a key gets a blank cell rather than a shifted
     * one. Rows are otherwise sent as given: shaping them into a rectangle here
     * would only disagree with the server about what a missing cell means.
     */
    // `async` so the row check below rejects rather than throwing synchronously:
    // every other method here hands back a promise, and a caller that reaches
    // for `.catch()` instead of `try` would otherwise miss this one.
    async createDatasetFromRows(
        templateId: string,
        rows: Record<string, unknown>[],
        name?: string,
    ): Promise<DatasetSummary> {
        assertSerialisableRows(rows);
        const body: Record<string, unknown> = { rows };
        if (name !== undefined) body.name = name;
        return this.#json<DatasetSummary>({
            method: "POST",
            path: `/api/v1/templates/${encodeURIComponent(templateId)}/datasets/rows`,
            what: `Creating a dataset on template ${templateId}`,
            body,
            accept: "json",
            timeoutMs: DATASET_TIMEOUT_MS,
            advice: DATASET_ADVICE,
        });
    }

    /**
     * POST /api/v1/templates/{id}/datasets — a dataset from spreadsheet bytes.
     *
     * Takes bytes rather than a path so the client stays a pure HTTP layer; the
     * caller reads and vets the file (see `readDatasetFile`).
     */
    uploadDataset(
        templateId: string,
        filename: string,
        data: Uint8Array,
    ): Promise<DatasetSummary> {
        const form = new FormData();
        // Copied into its own ArrayBuffer: a Uint8Array view of a larger pooled
        // Node Buffer would otherwise upload the whole underlying allocation.
        const bytes = new Uint8Array(data.byteLength);
        bytes.set(data);
        form.append("file", new Blob([bytes]), filename);
        return this.#json<DatasetSummary>({
            method: "POST",
            path: `/api/v1/templates/${encodeURIComponent(templateId)}/datasets`,
            what: `Uploading ${filename} to template ${templateId}`,
            body: form,
            accept: "json",
            timeoutMs: DATASET_TIMEOUT_MS,
            advice: DATASET_ADVICE,
        });
    }

    /** GET /api/v1/templates/{id}/datasets — datasets this template can run. */
    listDatasets(templateId: string): Promise<DatasetSummary[]> {
        return this.#json<DatasetSummary[]>({
            method: "GET",
            path: `/api/v1/templates/${encodeURIComponent(templateId)}/datasets`,
            what: `Listing datasets for template ${templateId}`,
            accept: "json",
            advice: DATASET_ADVICE,
        });
    }

    /** POST /api/v1/jobs — queue a batch render over a dataset. */
    createJob(input: {
        template_id: string;
        dataset_id: string;
        filename_template?: string;
        group_by?: string;
    }): Promise<CreatedJob> {
        const body: Record<string, unknown> = {
            template_id: input.template_id,
            dataset_id: input.dataset_id,
        };
        if (input.filename_template !== undefined) {
            body.filename_template = input.filename_template;
        }
        if (input.group_by !== undefined) body.group_by = input.group_by;
        return this.#json<CreatedJob>({
            method: "POST",
            path: "/api/v1/jobs",
            what: "Creating a batch job",
            body,
            accept: "json",
        });
    }

    /** GET /api/v1/jobs/{id} — batch job progress, with documents once terminal. */
    getJob(jobId: string): Promise<JobStatus> {
        return this.#json<JobStatus>({
            method: "GET",
            path: `/api/v1/jobs/${encodeURIComponent(jobId)}`,
            what: `Fetching job ${jobId}`,
            accept: "json",
        });
    }

    /**
     * GET /api/v1/documents/{id} — one rendered document's PDF bytes.
     *
     * On S3-backed deployments this is a 307 to a presigned URL; `fetch` follows
     * it, and undici drops the Authorization header on the cross-origin hop,
     * which is what the presigned URL wants anyway.
     */
    getDocument(documentId: string): Promise<Uint8Array> {
        return this.#pdf({
            method: "GET",
            path: `/api/v1/documents/${encodeURIComponent(documentId)}`,
            what: `Downloading document ${documentId}`,
            accept: "pdf",
        });
    }
}

/** `%PDF` magic bytes. */
function isPdf(bytes: Uint8Array): boolean {
    return bytes.length >= 4 &&
        bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}
