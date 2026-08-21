/**
 * Pure helpers shared by the tool handlers.
 *
 * These live apart from `index.ts` because that module starts the server as a
 * side effect of being imported; anything worth unit-testing belongs here.
 */

import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
    SheetRenderError,
    TERMINAL_JOB_STATUSES,
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
