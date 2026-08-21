#!/usr/bin/env node
/**
 * SheetRender MCP server (stdio).
 *
 * Nothing may be written to stdout except JSON-RPC frames — every diagnostic
 * goes to stderr.
 */

import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
    loadConfig,
    SheetRenderClient,
    SheetRenderError,
    type PageSettings,
} from "./client.js";
import {
    formatBytes,
    formatJob,
    formatTemplates,
    looksLikeMissingRoute,
    tempPdfPath,
} from "./format.js";

const SERVER_NAME = "sheetrender";
const SERVER_VERSION = "0.1.0";

/** PDFs at or under this size are also returned inline as a base64 blob. */
const INLINE_BLOB_LIMIT_BYTES = 512 * 1024;

const WHAT_IS_SHEETRENDER =
    "SheetRender turns HTML templates plus spreadsheet rows into rendered PDFs.";

// ---------------------------------------------------------------------------
// Shared zod pieces
// ---------------------------------------------------------------------------

const marginsSchema = z
    .object({
        top: z.number().describe("Top margin in millimetres (default 15)."),
        right: z.number().describe("Right margin in millimetres (default 15)."),
        bottom: z.number().describe("Bottom margin in millimetres (default 15)."),
        left: z.number().describe("Left margin in millimetres (default 15)."),
    })
    .partial()
    .describe("Page margins in millimetres. Plain numbers, not CSS lengths.");

const pageSettingsSchema = z
    .object({
        page_size: z
            .string()
            .describe(
                'Lowercase page size: "a4" (default), "a3", "a5", "letter", "legal" or "tabloid".',
            )
            .optional(),
        orientation: z
            .enum(["portrait", "landscape"])
            .describe('Page orientation. Defaults to "portrait".')
            .optional(),
        margins: marginsSchema.optional(),
    })
    .describe("Optional page setup for the PDF.");

const dataSchema = z
    .record(z.string(), z.unknown())
    .describe(
        "Template variables as a flat JSON object. Each key becomes a Jinja variable, " +
            'so {"customer": "Acme"} makes {{ customer }} available in the HTML.',
    );

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function textResult(text: string): CallToolResult {
    return { content: [{ type: "text", text }] };
}

function errorResult(text: string): CallToolResult {
    return { content: [{ type: "text", text }], isError: true };
}

/** Turns any thrown value into a tool error the model can act on. */
function toToolError(error: unknown): CallToolResult {
    if (error instanceof SheetRenderError) return errorResult(error.message);
    if (error instanceof Error) return errorResult(`Unexpected error: ${error.message}`);
    return errorResult(`Unexpected error: ${String(error)}`);
}

/**
 * Writes the PDF to a temp file and describes it. Small PDFs are additionally
 * returned as an embedded base64 resource so clients that render attachments
 * can show the document without reading the file back.
 */
async function deliverPdf(bytes: Uint8Array, label: string): Promise<CallToolResult> {
    const filePath = tempPdfPath();
    await writeFile(filePath, bytes);

    const summary =
        `${label}\nSaved to: ${filePath}\nSize: ${formatBytes(bytes.byteLength)} ` +
        `(${bytes.byteLength} bytes)`;
    const content: CallToolResult["content"] = [{ type: "text", text: summary }];

    if (bytes.byteLength <= INLINE_BLOB_LIMIT_BYTES) {
        content.push({
            type: "resource",
            resource: {
                uri: pathToFileURL(filePath).href,
                mimeType: "application/pdf",
                blob: Buffer.from(bytes).toString("base64"),
            },
        });
    } else {
        content[0] = {
            type: "text",
            text:
                `${summary}\n(Too large to inline — read it from the path above.)`,
        };
    }

    return { content };
}


// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function createServer(client: SheetRenderClient): McpServer {
    const server = new McpServer(
        { name: SERVER_NAME, version: SERVER_VERSION },
        {
            instructions:
                `${WHAT_IS_SHEETRENDER} Use render_pdf for one-off documents built from ` +
                "HTML you write, render_template for documents from a template already saved " +
                "in the user's account (list_templates finds their ids), and create_batch_job " +
                "plus get_job to render one PDF per row of an uploaded spreadsheet.",
        },
    );

    server.registerTool(
        "render_pdf",
        {
            title: "Render HTML to PDF",
            description:
                `${WHAT_IS_SHEETRENDER} This tool renders a single PDF from HTML you supply ` +
                "and returns the path to the saved file.\n\n" +
                "Use it for one-off documents — an invoice, a report, a certificate — where " +
                "you are writing the markup yourself. Use render_template instead when the " +
                "user already has a saved template.\n\n" +
                "`html` must be a complete HTML document (<html>, <head>, <body>) with all CSS " +
                "inline in a <style> tag: external stylesheets, fonts and scripts are not " +
                "fetched. Use @page and mm/cm units for print layout.\n\n" +
                "`data` keys become Jinja template variables, so passing " +
                '{"total": "42.00"} lets the HTML say {{ total }}. Jinja loops and ' +
                "conditionals work too. Omit `data` if the HTML has no placeholders.\n\n" +
                "Returns the temp-file path and size; PDFs under 512 KB are also attached inline.",
            inputSchema: {
                html: z
                    .string()
                    .min(1)
                    .describe(
                        "A complete HTML document with inline CSS. May contain Jinja " +
                            "placeholders filled from `data`.",
                    ),
                data: dataSchema.optional(),
                page_settings: pageSettingsSchema.optional(),
            },
        },
        async ({ html, data, page_settings }) => {
            try {
                const bytes = await client.renderHtml(
                    html,
                    data as Record<string, unknown> | undefined,
                    page_settings as PageSettings | undefined,
                );
                return await deliverPdf(bytes, "Rendered the HTML to a PDF.");
            } catch (error) {
                return toToolError(error);
            }
        },
    );

    server.registerTool(
        "list_templates",
        {
            title: "List SheetRender templates",
            description:
                `${WHAT_IS_SHEETRENDER} This tool lists the templates saved in the user's ` +
                "account, with the id each one needs.\n\n" +
                "Call it first whenever the user refers to a template by name (\"render the " +
                "invoice template\") so you can map that name to an id for render_template or " +
                "create_batch_job. Takes no arguments.",
            inputSchema: {},
        },
        async () => {
            try {
                return textResult(formatTemplates(await client.listTemplates()));
            } catch (error) {
                return toToolError(error);
            }
        },
    );

    server.registerTool(
        "render_template",
        {
            title: "Render a saved template to PDF",
            description:
                `${WHAT_IS_SHEETRENDER} This tool renders one PDF from a template already ` +
                "saved in the user's account and returns the path to the saved file.\n\n" +
                "Use it when the user wants a document in their existing design. Get " +
                "`template_id` from list_templates. Use render_pdf instead when you are " +
                "writing the HTML yourself.\n\n" +
                "`data` supplies one row's worth of values: each key becomes a Jinja variable " +
                "in the template's HTML. To render a PDF for every row of a spreadsheet, use " +
                "create_batch_job rather than calling this repeatedly.\n\n" +
                "Omit `page_settings` to keep the template's own saved page setup — passing it " +
                "overrides that for this render only.\n\n" +
                "Returns the temp-file path and size; PDFs under 512 KB are also attached inline.",
            inputSchema: {
                template_id: z
                    .string()
                    .min(1)
                    .describe("Template id from list_templates."),
                data: dataSchema,
                page_settings: pageSettingsSchema.optional(),
            },
        },
        async ({ template_id, data, page_settings }) => {
            try {
                const bytes = await client.renderTemplate(
                    template_id,
                    data as Record<string, unknown>,
                    page_settings as PageSettings | undefined,
                );
                return await deliverPdf(bytes, `Rendered template ${template_id} to a PDF.`);
            } catch (error) {
                return toToolError(error);
            }
        },
    );

    server.registerTool(
        "create_batch_job",
        {
            title: "Start a batch PDF job",
            description:
                `${WHAT_IS_SHEETRENDER} This tool queues a batch job that renders one PDF per ` +
                "row of an uploaded dataset, and returns the job id.\n\n" +
                "Use it when the user wants many documents at once — \"an invoice for every " +
                "row\", \"one letter per employee\". The dataset must already be uploaded to " +
                "the SheetRender project; this tool cannot upload spreadsheets. Rendering " +
                "happens in the background: poll get_job with the returned id to see progress " +
                "and collect document ids.\n\n" +
                "`filename_template` and `group_by` are saved onto the template/project, so " +
                "they change the defaults for later runs, not just this one. Only pass them " +
                "when the user asked to change how output is named or grouped.",
            inputSchema: {
                template_id: z
                    .string()
                    .min(1)
                    .describe("Template id from list_templates."),
                dataset_id: z
                    .string()
                    .min(1)
                    .describe(
                        "Id of a dataset already uploaded to the same SheetRender project.",
                    ),
                filename_template: z
                    .string()
                    .describe(
                        'Naming pattern for output files, with column placeholders, e.g. ' +
                            '"invoice-{{ invoice_no }}". Saved to the template.',
                    )
                    .optional(),
                group_by: z
                    .string()
                    .describe(
                        "Column name to group rows by, producing one multi-page PDF per " +
                            "distinct value instead of one per row. Saved to the project.",
                    )
                    .optional(),
            },
        },
        async ({ template_id, dataset_id, filename_template, group_by }) => {
            try {
                const job = await client.createJob({
                    template_id,
                    dataset_id,
                    filename_template,
                    group_by,
                });
                return textResult(
                    `Batch job queued.\nJob id: ${job.job_id}\nStatus: queued\n` +
                        `Poll get_job with job_id "${job.job_id}" to track progress and get ` +
                        "the document ids once it finishes.",
                );
            } catch (error) {
                if (error instanceof SheetRenderError && looksLikeMissingRoute(error)) {
                    return errorResult(
                        "Batch jobs aren't available on this SheetRender server version — " +
                            "the /api/v1/jobs endpoint does not exist. Render documents one at " +
                            "a time with render_template instead, or ask the user to start the " +
                            "batch from the SheetRender web app.",
                    );
                }
                return toToolError(error);
            }
        },
    );

    server.registerTool(
        "get_job",
        {
            title: "Check a batch PDF job",
            description:
                `${WHAT_IS_SHEETRENDER} This tool reports the progress of a batch job started ` +
                "by create_batch_job.\n\n" +
                "Returns the status, rows done/failed, and — once the job reaches a finished " +
                'state ("succeeded", "partial", "failed" or "cancelled") — the id and filename ' +
                "of every rendered document. The document list is empty while the job is still " +
                'in "queued", "retry_queued" or "running", so poll again after a short wait ' +
                "rather than assuming zero documents.",
            inputSchema: {
                job_id: z.string().min(1).describe("Job id returned by create_batch_job."),
            },
        },
        async ({ job_id }) => {
            try {
                return textResult(formatJob(await client.getJob(job_id)));
            } catch (error) {
                return toToolError(error);
            }
        },
    );

    return server;
}

async function main(): Promise<void> {
    let client: SheetRenderClient;
    try {
        client = new SheetRenderClient(loadConfig());
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`sheetrender-mcp: ${message}\n`);
        process.exit(1);
    }

    const server = createServer(client);
    const transport = new StdioServerTransport();

    let closing = false;
    const shutdown = (signal: NodeJS.Signals) => {
        if (closing) return;
        closing = true;
        process.stderr.write(`sheetrender-mcp: received ${signal}, shutting down\n`);
        server
            .close()
            .catch((error: unknown) => {
                process.stderr.write(`sheetrender-mcp: error while closing: ${String(error)}\n`);
            })
            .finally(() => process.exit(0));
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    // A stray rejection must not take the server down mid-session.
    process.on("unhandledRejection", (reason: unknown) => {
        process.stderr.write(`sheetrender-mcp: unhandled rejection: ${String(reason)}\n`);
    });

    await server.connect(transport);
    process.stderr.write(
        `sheetrender-mcp ${SERVER_VERSION} ready (API: ${client.baseUrl})\n`,
    );
}

main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`sheetrender-mcp: fatal: ${message}\n`);
    process.exit(1);
});
