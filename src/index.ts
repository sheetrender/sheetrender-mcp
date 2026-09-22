#!/usr/bin/env node
/**
 * SheetRender MCP server (stdio).
 *
 * Nothing may be written to stdout except JSON-RPC frames — every diagnostic
 * goes to stderr.
 */

import { realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
    loadConfig,
    SheetRenderClient,
    SheetRenderError,
} from "./client.js";
import { describeTools } from "./descriptions.js";
import {
    buildInlinePdfResult,
    buildPdfResult,
    decodeExample,
    formatDataset,
    formatDatasets,
    formatDesign,
    formatJob,
    formatTemplates,
    looksLikeMissingRoute,
    readDatasetFile,
    readExampleFile,
    tempPdfPath,
} from "./format.js";

const SERVER_NAME = "sheetrender";

/**
 * The version reported over MCP.
 *
 * package.json sits one level above the compiled dist/ both in the repo and in
 * the published tarball, so this always tracks the release. The unit-test build
 * lands a level deeper, in dist-test/src/, where no manifest sits above it —
 * and a cosmetic version string is not worth refusing to start over, whether
 * that is a test importing the module or a mangled install.
 */
function readVersion(): string {
    try {
        const manifest = createRequire(import.meta.url)("../package.json") as {
            version?: unknown;
        };
        return typeof manifest.version === "string" ? manifest.version : "0.0.0-dev";
    } catch {
        return "0.0.0-dev";
    }
}

export const SERVER_VERSION: string = readVersion();

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
 * As `toToolError`, but names the older-server case.
 *
 * The dataset routes shipped after the rest of the public API, so a self-hosted
 * or staging server can answer them with FastAPI's unmatched-path 404 while
 * every other tool works. Reported plainly, that reads as "your template id is
 * wrong" and the model retries forever.
 */
function datasetToolError(error: unknown): CallToolResult {
    if (error instanceof SheetRenderError && looksLikeMissingRoute(error)) {
        return errorResult(
            "This SheetRender server is too old to manage datasets over the API — the " +
                "/api/v1/templates/{id}/datasets endpoints do not exist on it. Ask the user " +
                "to upload the spreadsheet in the SheetRender web app and pass you the " +
                "dataset id, or render documents one at a time with render_template.",
        );
    }
    return toToolError(error);
}

/** Writes the PDF to a temp file and describes it for the caller. */
async function deliverPdf(bytes: Uint8Array, label: string): Promise<CallToolResult> {
    const filePath = tempPdfPath();
    // Owner-only: the temp directory is shared on a multi-user machine, and a
    // rendered invoice is not something every local account should read.
    await writeFile(filePath, bytes, { mode: 0o600 });
    return buildPdfResult(label, filePath, bytes);
}

export interface ServerOptions {
    /**
     * True for the Streamable HTTP server at mcp.sheetrender.com, where the
     * process runs on SheetRender's side rather than the user's machine. That
     * changes two things: PDFs come back inline instead of as a temp-file path
     * the caller could never open, and `upload_dataset` — which reads a file
     * off the local disk — is not offered at all. Everything else, including
     * the stdio server's behaviour, is unchanged.
     */
    hosted?: boolean;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function createServer(
    client: SheetRenderClient,
    options: ServerOptions = {},
): McpServer {
    const hosted = options.hosted === true;
    const deliver = hosted
        ? async (bytes: Uint8Array, label: string) => buildInlinePdfResult(label, bytes)
        : deliverPdf;
    const text = describeTools(hosted);

    const server = new McpServer(
        { name: SERVER_NAME, version: SERVER_VERSION },
        { instructions: text.instructions },
    );

    server.registerTool(
        "render_pdf",
        {
            title: "Render HTML to PDF",
            description: text.renderPdf,
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
                    data,
                    page_settings,
                );
                return await deliver(bytes, "Rendered the HTML to a PDF.");
            } catch (error) {
                return toToolError(error);
            }
        },
    );

    server.registerTool(
        "list_templates",
        {
            title: "List SheetRender templates",
            description: text.listTemplates,
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
        "design_template",
        {
            title: "Design a template",
            description: text.designTemplate,
            inputSchema: {
                dataset_id: z.string().min(1).describe("Existing dataset id; omit when passing rows.").optional(),
                rows: z.array(z.record(z.string(), z.unknown())).min(1)
                    .describe("Flat data rows; omit when passing dataset_id.").optional(),
                brief: z.string().trim().min(1).describe("Written design instructions.").optional(),
                example_base64: z.string().min(1).describe("Base64 example file contents.").optional(),
                example_filename: z.string().min(1).describe("Example filename including its extension.").optional(),
                ...(!hosted ? {
                    example_path: z.string().min(1).describe("Local example file path; ~ is expanded.").optional(),
                } : {}),
                style_id: z.string().min(1).describe("Saved style id.").optional(),
                name: z.string().trim().min(1).describe("Template name.").optional(),
                fit_one_page: z.boolean().describe("Fit the design onto one page.").optional(),
            },
        },
        async ({ dataset_id, rows, brief, example_base64, example_filename, example_path, style_id, name, fit_one_page }) => {
            try {
                if (Boolean(dataset_id) === Boolean(rows)) {
                    throw new SheetRenderError("Provide exactly one of dataset_id or rows.");
                }
                if (Boolean(example_base64) !== Boolean(example_filename)) {
                    throw new SheetRenderError("Provide example_base64 and example_filename together.");
                }
                if (example_path && (hosted || example_base64)) {
                    throw new SheetRenderError("example_path is stdio-only and cannot be combined with example_base64.");
                }
                const hasExample = Boolean(example_path || example_base64);
                if (!hasExample && !brief && !style_id) {
                    throw new SheetRenderError("Provide an example, brief or style_id.");
                }
                if (hasExample && (brief || style_id)) {
                    throw new SheetRenderError("Use an example alone, or a brief and optional style_id.");
                }
                const example = example_path
                    ? await readExampleFile(example_path)
                    : example_base64 && example_filename
                    ? decodeExample(example_base64, example_filename)
                    : undefined;
                const created = await client.createDesign({
                    dataset_id, rows, brief, style_id, name, fit_one_page, example,
                });
                const design = await client.waitForDesign(created);
                const result = formatDesign(design, client.baseUrl);
                return design.status === "failed" ? errorResult(result) : textResult(result);
            } catch (error) {
                return toToolError(error);
            }
        },
    );

    server.registerTool(
        "get_design",
        {
            title: "Check a template design",
            description: text.getDesign,
            inputSchema: {
                design_id: z.string().min(1).describe("Design id returned by design_template."),
            },
        },
        async ({ design_id }) => {
            try {
                const design = await client.getDesign(design_id);
                const result = formatDesign(design, client.baseUrl);
                return design.status === "failed" ? errorResult(result) : textResult(result);
            } catch (error) {
                return toToolError(error);
            }
        },
    );

    server.registerTool(
        "render_template",
        {
            title: "Render a saved template to PDF",
            description: text.renderTemplate,
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
                    data,
                    page_settings,
                );
                return await deliver(bytes, `Rendered template ${template_id} to a PDF.`);
            } catch (error) {
                return toToolError(error);
            }
        },
    );

    server.registerTool(
        "create_dataset",
        {
            title: "Create a dataset from JSON rows",
            description: text.createDataset,
            inputSchema: {
                template_id: z
                    .string()
                    .min(1)
                    .describe(
                        "Template id from list_templates. The dataset lands in that " +
                            "template's project.",
                    ),
                rows: z
                    .array(z.record(z.string(), z.unknown()))
                    .min(1)
                    .describe(
                        "One flat object per document. Keys become spreadsheet columns; " +
                            "values must be scalars (string, number, boolean or null).",
                    ),
                name: z
                    .string()
                    .describe(
                        "Optional label for the dataset, used as its stored filename so the " +
                            'user recognises it later, e.g. "march-invoices".',
                    )
                    .optional(),
            },
        },
        async ({ template_id, rows, name }) => {
            try {
                const dataset = await client.createDatasetFromRows(
                    template_id,
                    rows,
                    name,
                );
                return textResult(
                    `Created a dataset from ${rows.length} row${rows.length === 1 ? "" : "s"}.\n` +
                        `${formatDataset(dataset)}\n\n` +
                        `Next: create_batch_job with template_id "${template_id}" and ` +
                        `dataset_id "${dataset.id}".`,
                );
            } catch (error) {
                return datasetToolError(error);
            }
        },
    );

    // Reads a file off the local disk, which the hosted server does not have.
    if (!hosted) {
        server.registerTool(
            "upload_dataset",
            {
                title: "Upload a spreadsheet as a dataset",
                description: text.uploadDataset,
                inputSchema: {
                    template_id: z
                        .string()
                        .min(1)
                        .describe(
                            "Template id from list_templates. The dataset lands in that " +
                                "template's project.",
                        ),
                    file_path: z
                        .string()
                        .min(1)
                        .describe(
                            "Path to a .csv or .xlsx file on the user's machine. Absolute is " +
                                "safest; `~` is expanded.",
                        ),
                },
            },
            async ({ template_id, file_path }) => {
                try {
                    const { filename, bytes } = await readDatasetFile(file_path);
                    const dataset = await client.uploadDataset(template_id, filename, bytes);
                    return textResult(
                        `Uploaded ${filename} as a dataset.\n${formatDataset(dataset)}\n\n` +
                            `Next: create_batch_job with template_id "${template_id}" and ` +
                            `dataset_id "${dataset.id}".`,
                    );
                } catch (error) {
                    return datasetToolError(error);
                }
            },
        );
    }

    server.registerTool(
        "list_datasets",
        {
            title: "List datasets for a template",
            description: text.listDatasets,
            inputSchema: {
                template_id: z
                    .string()
                    .min(1)
                    .describe("Template id from list_templates."),
            },
        },
        async ({ template_id }) => {
            try {
                return textResult(formatDatasets(await client.listDatasets(template_id), hosted));
            } catch (error) {
                return datasetToolError(error);
            }
        },
    );

    server.registerTool(
        "create_batch_job",
        {
            title: "Start a batch PDF job",
            description: text.createBatchJob,
            inputSchema: {
                template_id: z
                    .string()
                    .min(1)
                    .describe("Template id from list_templates."),
                dataset_id: z
                    .string()
                    .min(1)
                    .describe(text.batchJobDatasetId),
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
            description: text.getJob,
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

    server.registerTool(
        "get_document",
        {
            title: "Download a rendered document",
            description: text.getDocument,
            inputSchema: {
                document_id: z
                    .string()
                    .min(1)
                    .describe("Document id from a finished job's document list in get_job."),
            },
        },
        async ({ document_id }) => {
            try {
                const bytes = await client.getDocument(document_id);
                return await deliver(bytes, `Downloaded document ${document_id}.`);
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

/**
 * True when this module is the program being run, rather than an import.
 *
 * The unit tests drive the real server over an in-memory transport, and
 * importing it must not seize stdio or exit the process over a missing API key.
 * Symlinks are resolved on both sides because a `npx`-installed bin is a link
 * into node_modules, and anything unexpected answers "yes" — the failure worth
 * avoiding is the published executable silently doing nothing.
 */
export function runningAsExecutable(moduleUrl: string = import.meta.url): boolean {
    const entry = process.argv[1];
    if (!entry) return false;
    try {
        return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
    } catch {
        return true;
    }
}

if (runningAsExecutable()) {
    main().catch((error: unknown) => {
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        process.stderr.write(`sheetrender-mcp: fatal: ${message}\n`);
        process.exit(1);
    });
}
