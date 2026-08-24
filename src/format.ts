/**
 * Pure helpers shared by the tool handlers.
 *
 * These live apart from `index.ts` because that module starts the server as a
 * side effect of being imported; anything worth unit-testing belongs here.
 */

import { randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
    SheetRenderError,
    TERMINAL_JOB_STATUSES,
    type DatasetSummary,
    type JobStatus,
    type TemplateSummary,
} from "./client.js";

/** Where a rendered PDF gets written. Unique per call. */
export function tempPdfPath(): string {
    // The random suffix is not decoration: two renders in the same millisecond
    // would otherwise write to the same path and the first would be lost.
    return join(tmpdir(), `sheetrender-${Date.now()}-${randomBytes(3).toString("hex")}.pdf`);
}

/** PDFs at or under this size are also returned inline as a base64 blob. */
export const INLINE_BLOB_LIMIT_BYTES = 512 * 1024;

/**
 * Describes a PDF that has already been written to `filePath`.
 *
 * Small PDFs are additionally returned as an embedded base64 resource so that
 * clients which render attachments can show the document without reading the
 * file back; large ones would blow up the context, so they get the path only.
 */
export function buildPdfResult(
    label: string,
    filePath: string,
    bytes: Uint8Array,
): CallToolResult {
    const summary =
        `${label}\nSaved to: ${filePath}\nSize: ${formatBytes(bytes.byteLength)} ` +
        `(${bytes.byteLength} bytes)`;

    if (bytes.byteLength > INLINE_BLOB_LIMIT_BYTES) {
        return {
            content: [{
                type: "text",
                text: `${summary}\n(Too large to inline — read it from the path above.)`,
            }],
        };
    }

    return {
        content: [
            { type: "text", text: summary },
            {
                type: "resource",
                resource: {
                    uri: pathToFileURL(filePath).href,
                    mimeType: "application/pdf",
                    blob: Buffer.from(bytes).toString("base64"),
                },
            },
        ],
    };
}

export function formatBytes(byteLength: number): string {
    if (byteLength < 1024) return `${byteLength} bytes`;
    if (byteLength < 1024 * 1024) return `${(byteLength / 1024).toFixed(1)} KB`;
    return `${(byteLength / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatTemplates(templates: TemplateSummary[]): string {
    if (templates.length === 0) {
        return "No templates found on this account. Create one at https://sheetrender.com, " +
            "or use render_pdf with inline HTML instead.";
    }
    const lines = templates.map((template) => {
        const updated = template.updated_at ?? template.created_at ?? "unknown";
        return `- ${template.name}\n  id: ${template.id}\n  updated: ${updated}`;
    });
    const noun = templates.length === 1 ? "template" : "templates";
    return `${templates.length} ${noun}:\n${lines.join("\n")}`;
}

/** Extensions the dataset upload endpoint will parse. */
export const DATASET_EXTENSIONS = [".csv", ".xlsx"];

/** The server's upload cap. Checked here so 100 MB is refused before it is sent. */
export const MAX_DATASET_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Reads a local spreadsheet for upload, refusing what the server would refuse.
 *
 * The extension and size checks are the server's own, run early: an agent that
 * points this at a .pdf or a 90 MB export learns why without a round trip, and
 * without spending two minutes uploading first. Everything past that — header
 * row, cell count, parseability — is the server's call, not ours.
 */
export async function readDatasetFile(
    filePath: string,
): Promise<{ filename: string; bytes: Uint8Array }> {
    const path = expandUserPath(filePath);
    const extension = extname(path).toLowerCase();
    if (!DATASET_EXTENSIONS.includes(extension)) {
        throw new SheetRenderError(
            `${basename(path) || path} is not a spreadsheet SheetRender can read — ` +
                `it needs a ${DATASET_EXTENSIONS.join(" or ")} file. ` +
                "To send data you already hold as JSON, use create_dataset instead.",
        );
    }

    // One handle for the checks and the read, rather than a stat() followed by
    // a readFile() of the same path: the two would be free to land on different
    // files, and the bytes uploaded would be the ones nothing vetted.
    let handle: FileHandle;
    try {
        handle = await open(path, "r");
    } catch (error) {
        // Linux opens a directory read-only quite happily and the isDirectory()
        // check below catches it; elsewhere the open itself is what fails.
        if ((error as NodeJS.ErrnoException)?.code === "EISDIR") {
            throw new SheetRenderError(`${path} is a directory, not a spreadsheet file.`);
        }
        throw new SheetRenderError(`Could not read ${path}: ${describeFsError(error)}`);
    }
    try {
        const info = await handle.stat();
        if (info.isDirectory()) {
            throw new SheetRenderError(`${path} is a directory, not a spreadsheet file.`);
        }
        if (info.size === 0) {
            throw new SheetRenderError(`${path} is empty — there are no rows to upload.`);
        }
        if (info.size > MAX_DATASET_UPLOAD_BYTES) {
            throw new SheetRenderError(
                `${path} is ${formatBytes(info.size)}, over SheetRender's ` +
                    `${formatBytes(MAX_DATASET_UPLOAD_BYTES)} upload limit. ` +
                    "Split it into smaller files and create one job per part.",
            );
        }
        return { filename: basename(path), bytes: await handle.readFile() };
    } catch (error) {
        if (error instanceof SheetRenderError) throw error;
        throw new SheetRenderError(`Could not read ${path}: ${describeFsError(error)}`);
    } finally {
        await handle.close().catch(() => {
            // The upload does not depend on the close succeeding, and a failure
            // here would otherwise mask whatever is being thrown above.
        });
    }
}

function describeFsError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Resolves `~` and relative paths.
 *
 * An MCP server's cwd belongs to the client that spawned it, so a relative path
 * is a guess either way — but a leading `~` is one an agent writes often, and
 * with no shell in the path nothing else would expand it.
 */
function expandUserPath(filePath: string): string {
    const trimmed = filePath.trim();
    if (trimmed === "~") return homedir();
    if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
    return isAbsolute(trimmed) ? trimmed : resolve(trimmed);
}

/** One dataset, with the column keys a template and `group_by` address. */
export function formatDataset(dataset: DatasetSummary): string {
    const lines = [
        `Dataset ${dataset.id}`,
        `File: ${dataset.filename ?? "(unnamed)"}${
            dataset.sheet_name ? ` (sheet "${dataset.sheet_name}")` : ""
        }`,
        `Rows: ${dataset.row_count ?? 0}`,
    ];
    if (dataset.created_at) lines.push(`Created: ${dataset.created_at}`);

    const columns = dataset.columns ?? [];
    if (columns.length === 0) {
        lines.push("Columns: none detected.");
        return lines.join("\n");
    }
    lines.push(
        `Columns (${columns.length}) — use the key in template placeholders, ` +
            "filename_template and group_by:",
    );
    for (const column of columns) {
        const renamed = column.original && column.original !== column.key
            ? ` — from "${column.original}"`
            : "";
        lines.push(`- ${column.key} (${column.inferred_type})${renamed}`);
    }
    return lines.join("\n");
}

/** Every dataset on a template's project, newest first. */
export function formatDatasets(datasets: DatasetSummary[]): string {
    if (datasets.length === 0) {
        return "No datasets on this template's project yet. Create one with create_dataset " +
            "(JSON rows) or upload_dataset (a local .csv/.xlsx file), then pass its id to " +
            "create_batch_job.";
    }
    const noun = datasets.length === 1 ? "dataset" : "datasets";
    const blocks = datasets.map((dataset) => formatDataset(dataset));
    return `${datasets.length} ${noun} (newest first):\n\n${blocks.join("\n\n")}`;
}

export function formatJob(job: JobStatus): string {
    const done = job.rows_done ?? 0;
    const total = job.rows_total ?? 0;
    const failed = job.rows_failed ?? 0;
    const terminal = TERMINAL_JOB_STATUSES.has(job.status);

    const lines = [
        `Job ${job.id}`,
        `Status: ${job.status}${terminal ? " (finished)" : " (still running)"}`,
        `Rows: ${done}/${total} done${failed ? `, ${failed} failed` : ""}`,
    ];
    if (job.created_at) lines.push(`Created: ${job.created_at}`);
    if (job.finished_at) lines.push(`Finished: ${job.finished_at}`);

    const documents = job.documents ?? [];
    lines.push(`Documents: ${documents.length}`);
    if (documents.length > 0) {
        for (const document of documents) {
            lines.push(`- ${document.filename ?? "(unnamed)"} — id: ${document.id}`);
        }
    } else if (!terminal) {
        lines.push("(The document list is only populated once the job finishes.)");
    }
    if (job.merged_available) lines.push("A merged PDF is available in the web app.");
    if (job.zip_available) lines.push("A ZIP of all documents is available in the web app.");

    return lines.join("\n");
}

/**
 * True when the failure looks like "this server build has no such route" rather
 * than "your template/dataset id was wrong". FastAPI answers an unmatched path
 * with a literal `{"detail": "Not Found"}` and a wrong method with 405, whereas
 * the real handler returns 404s with its own wording — so a blanket 404 check
 * would report a mistyped template id as a missing feature.
 */
export function looksLikeMissingRoute(error: SheetRenderError): boolean {
    if (error.status === 405) return true;
    return error.status === 404 &&
        typeof error.detail === "string" &&
        error.detail.trim().toLowerCase() === "not found";
}
