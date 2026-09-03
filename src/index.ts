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
    type PageSettings,
} from "./client.js";
import {
    buildInlinePdfResult,
    buildPdfResult,
    formatDataset,
    formatDatasets,
    formatJob,
    formatTemplates,
    looksLikeMissingRoute,
    readDatasetFile,
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
    await writeFile(filePath, bytes);
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
    // Description fragments that differ between the two deployments. The
    // stdio wording is the original; the hosted one drops the file-based tool.
    const pdfReturns = hosted
        ? "Returns the PDF inline as a base64 resource (up to 8 MB) along with its size."
        : "Returns the temp-file path and size; PDFs under 512 KB are also attached inline.";
    const pdfHandoff = hosted
        ? "and returns the PDF itself."
        : "and returns the path to the saved file.";
    const datasetSources = hosted
        ? "create_dataset (rows you hold as JSON)"
        : "create_dataset (rows you hold as JSON) or upload_dataset (a local .csv/.xlsx)";
    const datasetTools = hosted ? "create_dataset" : "create_dataset or upload_dataset";
    const keyReporters = hosted
        ? "create_dataset and list_datasets both report"
        : "create_dataset, upload_dataset and list_datasets all report";

    const server = new McpServer(
        { name: SERVER_NAME, version: SERVER_VERSION },
        {
            instructions:
                `${WHAT_IS_SHEETRENDER} Use render_pdf for one-off documents built from ` +
                "HTML you write, and render_template for documents from a template already " +
                "saved in the user's account (list_templates finds their ids).\n\n" +
                "For many documents at once, the whole batch runs from here without the web " +
                `app: list_templates -> ${datasetSources} -> create_batch_job -> get_job ` +
                "to poll -> get_document to download each PDF. list_datasets finds datasets that " +
                "already exist on a template's project.",
        },
    );

    server.registerTool(
        "render_pdf",
        {
            title: "Render HTML to PDF",
            description:
                `${WHAT_IS_SHEETRENDER} This tool renders a single PDF from HTML you supply ` +
                `${pdfHandoff}\n\n` +
                "Use it for one-off documents — an invoice, a report, a certificate — where " +
                "you are writing the markup yourself. Use render_template instead when the " +
                "user already has a saved template.\n\n" +
                "`html` must be a complete HTML document (<html>, <head>, <body>) with all CSS " +
                "inline in a <style> tag: external stylesheets, fonts and scripts are not " +
                "fetched. Use @page and mm/cm units for print layout.\n\n" +
                "`data` keys become Jinja template variables, so passing " +
                '{"total": "42.00"} lets the HTML say {{ total }}. Jinja loops and ' +
                "conditionals work too. Omit `data` if the HTML has no placeholders.\n\n" +
                "Two server limits to plan for: HTML over 2 MB is rejected, measured both on " +
                "what you send and on the result after `data` is substituted in, so keep large " +
                "tables paginated rather than emitting one enormous document; and accounts on " +
                'the free plan get a "Made with SheetRender" footer added to every PDF, which ' +
                "is expected, not a bug — mention it if the user seems surprised.\n\n" +
                pdfReturns,
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
            description:
                `${WHAT_IS_SHEETRENDER} This tool lists the templates saved in the user's ` +
                "account, with the id each one needs.\n\n" +
                "Call it first whenever the user refers to a template by name (\"render the " +
                "invoice template\") so you can map that name to an id — every other tool " +
                "here takes a template_id, including create_dataset and list_datasets. Takes " +
                "no arguments.",
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
                `saved in the user's account ${pdfHandoff}\n\n` +
                "Use it when the user wants a document in their existing design. Get " +
                "`template_id` from list_templates. Use render_pdf instead when you are " +
                "writing the HTML yourself.\n\n" +
                "`data` supplies one row's worth of values: each key becomes a Jinja variable " +
                "in the template's HTML. To render a PDF for every row of a spreadsheet, load " +
                `the rows with ${datasetTools} and run create_batch_job ` +
                "rather than calling this repeatedly.\n\n" +
                "Omit `page_settings` to keep the template's own saved page setup — passing it " +
                "overrides that for this render only.\n\n" +
                'Free-plan accounts get a "Made with SheetRender" footer on the PDF, same as ' +
                "render_pdf — expected, not a bug.\n\n" +
                pdfReturns,
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
            description:
                `${WHAT_IS_SHEETRENDER} This tool turns rows you already hold — as JSON — ` +
                "into a dataset a batch job can render, and returns the dataset id plus the " +
                "column keys.\n\n" +
                "This is the normal way to start a batch: the user asks for \"an invoice for " +
                "each of these clients\" or \"a letter per employee\", you assemble the rows, " +
                "and this uploads them. " +
                (hosted
                    ? ""
                    : "Use upload_dataset instead when the data is already a file on disk, and ") +
                `${hosted ? "Use " : ""}list_datasets when the user is referring to a dataset ` +
                "that already exists.\n\n" +
                "`rows` is a flat array of flat objects, one per document: " +
                '[{"client": "Acme", "total": 42}, {"client": "Globex", "total": 17}]. ' +
                "The header is the union of every row's keys in first-seen order, so rows " +
                "need not agree on their keys — a missing one is a blank cell, not a shifted " +
                "row. Values must be strings, numbers, booleans or null; nested objects and " +
                "arrays are rejected, so flatten or stringify them first. So are NaN, Infinity " +
                "and whole numbers past 2^53 (send those as strings to keep them exact).\n\n" +
                "The dataset is attached to the template's project, which means every template " +
                "in that project can render it and it stays available to later jobs.\n\n" +
                "Limits: 50,000 rows and 500,000 cells (rows x columns) per call. " +
                (hosted
                    ? "A bigger sheet has to be split across several datasets and jobs, or " +
                        "uploaded by the user in the SheetRender web app. "
                    : "The row cap applies to JSON rows only — a bigger sheet can still go " +
                        "through upload_dataset as a file, which is bounded by size and cells " +
                        "rather than rows. ") +
                "Creating a dataset is free; only rendering counts against the account's " +
                "plan.\n\n" +
                "Returns the dataset id and, for each column, the sanitized `key`. That key — " +
                "not the original header — is what the template's placeholders, " +
                "`filename_template` and `group_by` address, so read it off this result " +
                "rather than guessing from the header text.",
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
                    rows as Record<string, unknown>[],
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

    if (!hosted) server.registerTool(
        "upload_dataset",
        {
            title: "Upload a spreadsheet as a dataset",
            description:
                `${WHAT_IS_SHEETRENDER} This tool uploads a local .csv or .xlsx file as a ` +
                "dataset a batch job can render, and returns the dataset id plus the column " +
                "keys.\n\n" +
                "Use it when the user points at a file they already have — an export, a " +
                "spreadsheet they attached, something you just wrote to disk. Use " +
                "create_dataset instead when you are holding the rows as JSON: it avoids " +
                "writing a file only to read it straight back.\n\n" +
                "`file_path` is a path on the machine running this MCP server, which is the " +
                "user's machine, not SheetRender's. The first row must be the header. Other " +
                "spreadsheet formats (.xls, .ods, .numbers) and .pdf are not parsed — convert " +
                "to .csv or .xlsx first.\n\n" +
                "Limits: 20 MB per file and 500,000 cells; larger data has to be split across " +
                "several datasets and jobs. Uploading is free; only rendering counts against " +
                "the account's plan.\n\n" +
                "Returns the dataset id and each column's sanitized `key` — the name the " +
                "template's placeholders, `filename_template` and `group_by` use, which is " +
                'often not the header text verbatim ("Invoice No" becomes invoice_no).',
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

    server.registerTool(
        "list_datasets",
        {
            title: "List datasets for a template",
            description:
                `${WHAT_IS_SHEETRENDER} This tool lists the datasets a batch job can render ` +
                "with a given template — everything in that template's project, newest " +
                "first — with each one's id, row count and column keys.\n\n" +
                "Call it when the user refers to data they have already loaded (\"use the " +
                "customer list I uploaded\") so you can find its id, or to re-run a batch over " +
                "an existing dataset instead of creating a duplicate. When there is nothing " +
                `suitable, create one with ${datasetTools}.\n\n` +
                "It is also the quickest way to see a dataset's sanitized column keys before " +
                "writing a `filename_template` or choosing `group_by`.",
            inputSchema: {
                template_id: z
                    .string()
                    .min(1)
                    .describe("Template id from list_templates."),
            },
        },
        async ({ template_id }) => {
            try {
                return textResult(formatDatasets(await client.listDatasets(template_id)));
            } catch (error) {
                return datasetToolError(error);
            }
        },
    );

    server.registerTool(
        "create_batch_job",
        {
            title: "Start a batch PDF job",
            description:
                `${WHAT_IS_SHEETRENDER} This tool queues a batch job that renders one PDF per ` +
                "row of a dataset, and returns the job id.\n\n" +
                "Use it when the user wants many documents at once — \"an invoice for every " +
                "row\", \"one letter per employee\" — rather than calling render_template in a " +
                "loop.\n\n" +
                "The full sequence, all of it available here:\n" +
                "1. list_templates — the user's designs, and the template_id for the rest.\n" +
                `2. ${datasetSources} — returns the dataset_id. list_datasets finds one that ` +
                "already exists.\n" +
                "3. create_batch_job — this tool, returning a job id.\n" +
                "4. get_job — poll until the status is finished; it then lists the document " +
                "ids.\n" +
                "5. get_document — download any of those PDFs.\n\n" +
                "The dataset must belong to the same template's project, which is where " +
                `${datasetTools} put${hosted ? "s" : ""} it. Rendering happens in the ` +
                "background, so the job id comes back long before the PDFs do.\n\n" +
                "`filename_template` and `group_by` name columns by their sanitized key, which " +
                `${keyReporters} — it is often not ` +
                'the header text verbatim ("Invoice No" becomes invoice_no). Both are saved ' +
                "onto the template/project, so they change the defaults for later runs, not " +
                "just this one. Only pass them when the user asked to change how output is " +
                "named or grouped.",
            inputSchema: {
                template_id: z
                    .string()
                    .min(1)
                    .describe("Template id from list_templates."),
                dataset_id: z
                    .string()
                    .min(1)
                    .describe(
                        "Dataset id from create_dataset, upload_dataset or list_datasets. " +
                            "It must belong to the same template's project.",
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
                "rather than assuming zero documents.\n\n" +
                "Pass those document ids to get_document to download the individual PDFs.",
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
            description:
                `${WHAT_IS_SHEETRENDER} This tool downloads one PDF produced by a batch job ` +
                `${pdfHandoff}\n\n` +
                "`document_id` comes from get_job on a finished batch — that is the only place " +
                "these ids appear, so call get_job first and take an id from its document list. " +
                "A document id is not a template id or a job id.\n\n" +
                "Use it to fetch a specific output the user asked about, or to spot-check a " +
                "batch. Fetching every document of a large batch one at a time is slow; point " +
                "the user at the SheetRender web app for the merged PDF or ZIP instead.\n\n" +
                pdfReturns,
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
