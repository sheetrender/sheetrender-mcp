import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
    SheetRenderError,
    type DatasetSummary,
    type SheetRenderClient,
} from "../src/client.js";
// Importing the server module is safe: it only takes over stdio and reads the
// environment when it is the process entrypoint, which node --test is not.
import { createServer } from "../src/index.js";

/**
 * A stand-in for the HTTP client. Only the methods a test needs are present, so
 * a handler that calls anything else fails as a TypeError rather than quietly
 * reaching the network.
 */
type FakeClient = Partial<SheetRenderClient>;

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
    // node --test does not exit while a transport pair is still open.
    while (closers.length) await closers.pop()!();
});

/** Drives the real server in-process over a linked in-memory transport. */
async function connect(fake: FakeClient): Promise<Client> {
    const server = createServer(fake as unknown as SheetRenderClient);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    closers.push(async () => {
        await client.close();
        await server.close();
    });
    return client;
}

/**
 * First text item of a tool result, narrowed for assertions. `callTool` types
 * its result as the union with the legacy `{toolResult}` shape, which no tool
 * here returns.
 */
function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
    return (result.content as { text: string }[])[0]!.text;
}

async function tempFile(name: string, contents: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "sheetrender-test-"));
    const path = join(dir, name);
    await writeFile(path, contents);
    return path;
}

const DATASET: DatasetSummary = {
    id: "ds_1",
    filename: "march-invoices.xlsx",
    sheet_name: "Data",
    columns: [
        { key: "invoice_no", original: "Invoice No", inferred_type: "number" },
        { key: "client", original: "client", inferred_type: "string" },
    ],
    row_count: 2,
    created_at: "2026-08-24T10:00:00Z",
};

describe("tool registration", () => {
    it("advertises every tool the batch workflow needs", async () => {
        const client = await connect({});
        const { tools } = await client.listTools();

        assert.deepEqual(tools.map((tool) => tool.name).sort(), [
            "create_batch_job",
            "create_dataset",
            "get_document",
            "get_job",
            "list_datasets",
            "list_templates",
            "render_pdf",
            "render_template",
            "upload_dataset",
        ]);
    });

    it("marks each dataset tool's arguments required, not optional", async () => {
        // The model only sends what the schema says it must; an argument that
        // slipped to optional here reads to it as "omit unless you have one".
        const client = await connect({});
        const tools = new Map(
            (await client.listTools()).tools.map((tool) => [tool.name, tool]),
        );

        assert.deepEqual(
            tools.get("create_dataset")?.inputSchema.required?.slice().sort(),
            ["rows", "template_id"],
        );
        assert.deepEqual(
            tools.get("upload_dataset")?.inputSchema.required?.slice().sort(),
            ["file_path", "template_id"],
        );
        assert.deepEqual(
            tools.get("list_datasets")?.inputSchema.required?.slice().sort(),
            ["template_id"],
        );
    });
});

describe("create_dataset", () => {
    const rows = [
        { "Invoice No": 1, client: "Acme" },
        { "Invoice No": 2, client: "Globex" },
    ];

    it("passes the arguments through and hands off to create_batch_job", async () => {
        const calls: Array<[string, Record<string, unknown>[], string | undefined]> = [];
        const client = await connect({
            createDatasetFromRows: async (templateId, sent, name) => {
                calls.push([templateId, sent, name]);
                return DATASET;
            },
        });

        const result = await client.callTool({
            name: "create_dataset",
            arguments: { template_id: "tpl_1", rows, name: "march-invoices" },
        });

        assert.deepEqual(calls, [["tpl_1", rows, "march-invoices"]]);
        const text = textOf(result);
        assert.match(text, /Created a dataset from 2 rows\./);
        assert.match(text, /Dataset ds_1/);
        // The sanitized key, not the header text, is what the next call needs.
        assert.match(text, /- invoice_no \(number\) — from "Invoice No"/);
        assert.match(
            text,
            /Next: create_batch_job with template_id "tpl_1" and dataset_id "ds_1"\./,
        );
        assert.equal(result.isError, undefined);
    });

    it("reports a rejected payload as a tool error, keeping the server's wording", async () => {
        const client = await connect({
            createDatasetFromRows: async () => {
                throw new SheetRenderError(
                    "Creating a dataset on template tpl_1 failed: rows must not be empty " +
                        "(HTTP 400).",
                    400,
                    "rows must not be empty",
                );
            },
        });

        const result = await client.callTool({
            name: "create_dataset",
            arguments: { template_id: "tpl_1", rows },
        });

        assert.equal(result.isError, true);
        assert.match(textOf(result), /rows must not be empty/);
        assert.match(textOf(result), /HTTP 400/);
    });

    it("names the older-server case rather than blaming the template id", async () => {
        // FastAPI answers an unmatched path with this body, and the dataset
        // routes shipped after the rest of the API — so a server without them
        // 404s here while every other tool works.
        const client = await connect({
            createDatasetFromRows: async () => {
                throw new SheetRenderError(
                    "Creating a dataset on template tpl_1 failed: not found (HTTP 404). " +
                        "Check template_id against list_templates.",
                    404,
                    "Not Found",
                );
            },
        });

        const result = await client.callTool({
            name: "create_dataset",
            arguments: { template_id: "tpl_1", rows },
        });

        assert.equal(result.isError, true);
        assert.match(textOf(result), /too old to manage datasets over the API/);
        assert.doesNotMatch(textOf(result), /Check template_id/);
    });

    it("leaves a genuine 'Template not found' 404 alone", async () => {
        const message = "Creating a dataset on template tpl_gone failed: Template not " +
            "found (HTTP 404). Check template_id against list_templates.";
        const client = await connect({
            createDatasetFromRows: async () => {
                throw new SheetRenderError(message, 404, "Template not found");
            },
        });

        const result = await client.callTool({
            name: "create_dataset",
            arguments: { template_id: "tpl_gone", rows },
        });

        assert.equal(result.isError, true);
        assert.equal(textOf(result), message);
        assert.doesNotMatch(textOf(result), /too old/);
    });
});

describe("upload_dataset", () => {
    it("sends the file's own bytes under its basename", async () => {
        const path = await tempFile("clients.csv", "client,total\nAcme,42\n");
        const calls: Array<[string, string, string]> = [];
        const client = await connect({
            uploadDataset: async (templateId, filename, data) => {
                calls.push([templateId, filename, new TextDecoder().decode(data)]);
                return { ...DATASET, filename };
            },
        });

        const result = await client.callTool({
            name: "upload_dataset",
            arguments: { template_id: "tpl_1", file_path: path },
        });

        assert.deepEqual(calls, [["tpl_1", "clients.csv", "client,total\nAcme,42\n"]]);
        const text = textOf(result);
        assert.match(text, /Uploaded clients\.csv as a dataset\./);
        assert.match(text, /File: clients\.csv/);
        assert.match(
            text,
            /Next: create_batch_job with template_id "tpl_1" and dataset_id "ds_1"\./,
        );
    });

    it("refuses a format the server cannot parse before uploading anything", async () => {
        const path = await tempFile("report.pdf", "%PDF-1.4");
        let uploads = 0;
        const client = await connect({
            uploadDataset: async () => {
                uploads += 1;
                return DATASET;
            },
        });

        const result = await client.callTool({
            name: "upload_dataset",
            arguments: { template_id: "tpl_1", file_path: path },
        });

        assert.equal(result.isError, true);
        assert.match(textOf(result), /not a spreadsheet SheetRender can read/);
        assert.match(textOf(result), /create_dataset/);
        // The guard is local, so a bad file costs no request at all.
        assert.equal(uploads, 0);
    });
});

describe("list_datasets", () => {
    it("lists what the template's project holds", async () => {
        const calls: string[] = [];
        const client = await connect({
            listDatasets: async (templateId) => {
                calls.push(templateId);
                return [DATASET];
            },
        });

        const result = await client.callTool({
            name: "list_datasets",
            arguments: { template_id: "tpl_1" },
        });

        assert.deepEqual(calls, ["tpl_1"]);
        assert.match(textOf(result), /^1 dataset \(newest first\):/);
        assert.match(textOf(result), /Dataset ds_1/);
    });

    it("points at both ways to make one when there are none", async () => {
        const client = await connect({ listDatasets: async () => [] });

        const result = await client.callTool({
            name: "list_datasets",
            arguments: { template_id: "tpl_1" },
        });

        assert.equal(result.isError, undefined);
        assert.match(textOf(result), /No datasets/);
        assert.match(textOf(result), /create_dataset/);
        assert.match(textOf(result), /upload_dataset/);
    });
});

describe("create_batch_job", () => {
    it("returns the job id and sends the caller to get_job", async () => {
        const calls: unknown[] = [];
        const client = await connect({
            createJob: async (input) => {
                calls.push(input);
                return { job_id: "job_1" };
            },
        });

        const result = await client.callTool({
            name: "create_batch_job",
            arguments: { template_id: "tpl_1", dataset_id: "ds_1" },
        });

        assert.deepEqual(calls, [{
            template_id: "tpl_1",
            dataset_id: "ds_1",
            filename_template: undefined,
            group_by: undefined,
        }]);
        const text = textOf(result);
        assert.match(text, /Job id: job_1/);
        assert.match(text, /Poll get_job with job_id "job_1"/);
    });
});
