import assert from "node:assert/strict";
import { mkdir, mkdtemp, truncate, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import {
    SheetRenderError,
    type DatasetSummary,
    type JobStatus,
} from "../src/client.js";
import {
    buildPdfResult,
    formatBytes,
    formatDataset,
    formatDatasets,
    formatJob,
    formatTemplates,
    INLINE_BLOB_LIMIT_BYTES,
    looksLikeMissingRoute,
    MAX_DATASET_UPLOAD_BYTES,
    readDatasetFile,
    tempPdfPath,
} from "../src/format.js";

describe("looksLikeMissingRoute", () => {
    // The whole point of the helper: /api/v1/jobs answers 404 for a bad template
    // id *and* 404 when the route does not exist, and create_batch_job must not
    // tell the user their server is too old when they simply mistyped an id.
    it("treats FastAPI's unmatched-path body as a missing route", () => {
        assert.equal(
            looksLikeMissingRoute(new SheetRenderError("x", 404, "Not Found")),
            true,
        );
    });

    it("ignores case and surrounding whitespace on that body", () => {
        assert.equal(
            looksLikeMissingRoute(new SheetRenderError("x", 404, "  not found\n")),
            true,
        );
    });

    it("treats 405 as a missing route", () => {
        assert.equal(
            looksLikeMissingRoute(new SheetRenderError("x", 405, "Method Not Allowed")),
            true,
        );
    });

    it("does NOT treat a real 'Template not found' 404 as a missing route", () => {
        assert.equal(
            looksLikeMissingRoute(new SheetRenderError("x", 404, "Template not found")),
            false,
        );
    });

    it("does NOT treat a real 'Template or dataset not found' 404 as a missing route", () => {
        assert.equal(
            looksLikeMissingRoute(
                new SheetRenderError("x", 404, "Template or dataset not found"),
            ),
            false,
        );
    });

    it("does not fire for other statuses or non-string details", () => {
        assert.equal(looksLikeMissingRoute(new SheetRenderError("x", 403, "Not Found")), false);
        assert.equal(looksLikeMissingRoute(new SheetRenderError("x", 500, "Not Found")), false);
        assert.equal(
            looksLikeMissingRoute(new SheetRenderError("x", 404, { message: "Not Found" })),
            false,
        );
        assert.equal(looksLikeMissingRoute(new SheetRenderError("x", 404)), false);
        assert.equal(looksLikeMissingRoute(new SheetRenderError("x")), false);
    });
});

describe("tempPdfPath", () => {
    it("never collides, even for renders in the same millisecond", () => {
        const paths = new Set<string>();
        for (let i = 0; i < 500; i += 1) paths.add(tempPdfPath());

        assert.equal(paths.size, 500, "expected 500 distinct paths");
    });

    it("lands in the system temp directory with a recognisable name", () => {
        const path = tempPdfPath();

        assert.equal(dirname(path), tmpdir());
        assert.match(path, /sheetrender-\d+-[0-9a-f]{6}\.pdf$/);
    });
});

/** First text item of a tool result, narrowed for assertions. */
function textOf(result: { content: unknown[] }): string {
    return (result.content[0] as { text: string }).text;
}

describe("buildPdfResult", () => {
    // Shared by render_pdf, render_template and get_document, so a regression
    // here silently breaks every PDF-returning tool at once.
    const label = "Downloaded document doc_1.";
    const path = "/tmp/sheetrender-123-abc123.pdf";

    it("reports the label, path and size, and inlines a small PDF", () => {
        const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
        const result = buildPdfResult(label, path, bytes);

        assert.equal(result.content.length, 2);
        assert.equal(result.content[0]!.type, "text");
        const text = textOf(result);
        assert.match(text, /^Downloaded document doc_1\./);
        assert.match(text, /Saved to: \/tmp\/sheetrender-123-abc123\.pdf/);
        assert.match(text, /Size: 5 bytes \(5 bytes\)/);

        assert.equal(result.content[1]!.type, "resource");
        const embedded = (result.content[1] as {
            resource: { uri: string; mimeType?: string; blob?: string };
        }).resource;
        assert.equal(embedded.uri, "file:///tmp/sheetrender-123-abc123.pdf");
        assert.equal(embedded.mimeType, "application/pdf");
        assert.deepEqual([...Buffer.from(embedded.blob!, "base64")], [...bytes]);
    });

    it("inlines a PDF exactly at the limit", () => {
        const result = buildPdfResult(label, path, new Uint8Array(INLINE_BLOB_LIMIT_BYTES));

        assert.equal(result.content.length, 2);
        assert.equal(result.content[1]!.type, "resource");
    });

    it("drops the blob one byte over the limit and says why", () => {
        const result = buildPdfResult(label, path, new Uint8Array(INLINE_BLOB_LIMIT_BYTES + 1));

        assert.equal(result.content.length, 1);
        assert.equal(result.content[0]!.type, "text");
        assert.match(textOf(result), /Too large to inline/);
        // The path still has to be there, or the PDF is unreachable.
        assert.match(textOf(result), /Saved to: \/tmp\/sheetrender/);
        assert.match(textOf(result), /Size: 512\.0 KB/);
    });

    it("never marks a delivered PDF as an error", () => {
        assert.equal(buildPdfResult(label, path, new Uint8Array(10)).isError, undefined);
    });
});

describe("formatBytes", () => {
    it("scales the unit to the size", () => {
        assert.equal(formatBytes(0), "0 bytes");
        assert.equal(formatBytes(512), "512 bytes");
        assert.equal(formatBytes(2048), "2.0 KB");
        assert.equal(formatBytes(3 * 1024 * 1024), "3.00 MB");
    });
});

describe("formatTemplates", () => {
    it("points somewhere useful when the account has none", () => {
        assert.match(formatTemplates([]), /No templates found/);
    });

    it("lists ids and falls back to created_at when never updated", () => {
        const text = formatTemplates([
            {
                id: "tpl_1",
                name: "Invoice",
                created_at: "2026-01-01T00:00:00",
                updated_at: "2026-08-01T12:00:00",
            },
            {
                id: "tpl_2",
                name: "Offer letter",
                created_at: "2026-02-01T00:00:00",
                updated_at: null,
            },
        ]);

        assert.match(text, /^2 templates:/);
        assert.match(text, /id: tpl_1/);
        assert.match(text, /updated: 2026-08-01T12:00:00/);
        assert.match(text, /updated: 2026-02-01T00:00:00/);
    });

    it("counts one template in the singular", () => {
        const text = formatTemplates([
            { id: "tpl_1", name: "Invoice", created_at: null, updated_at: null },
        ]);

        assert.match(text, /^1 template:/);
        assert.match(text, /updated: unknown/);
    });
});

describe("formatJob", () => {
    const base: JobStatus = {
        id: "job_1",
        status: "running",
        rows_total: 10,
        rows_done: 3,
        rows_failed: 0,
        created_at: "2026-08-20T10:00:00",
        finished_at: null,
        documents: [],
        merged_available: false,
        zip_available: false,
    };

    it("explains an empty document list while the job is still running", () => {
        const text = formatJob(base);

        assert.match(text, /Status: running \(still running\)/);
        assert.match(text, /Rows: 3\/10 done$/m);
        assert.match(text, /only populated once the job finishes/);
    });

    it("reports failures when there are any", () => {
        assert.match(formatJob({ ...base, rows_failed: 2 }), /Rows: 3\/10 done, 2 failed/);
    });

    it("lists documents once the job is terminal", () => {
        const text = formatJob({
            ...base,
            status: "succeeded",
            rows_done: 2,
            rows_total: 2,
            finished_at: "2026-08-20T10:00:09",
            documents: [
                { id: "doc_1", filename: "invoice-1.pdf" },
                { id: "doc_2", filename: null },
            ],
            merged_available: true,
            zip_available: true,
        });

        assert.match(text, /Status: succeeded \(finished\)/);
        assert.match(text, /Documents: 2/);
        assert.match(text, /invoice-1\.pdf — id: doc_1/);
        assert.match(text, /\(unnamed\) — id: doc_2/);
        assert.doesNotMatch(text, /only populated once/);
        assert.match(text, /merged PDF is available/);
    });

    it("treats every terminal status as finished", () => {
        for (const status of ["succeeded", "partial", "failed", "cancelled"]) {
            assert.match(formatJob({ ...base, status }), /\(finished\)/);
        }
        for (const status of ["queued", "retry_queued", "running"]) {
            assert.match(formatJob({ ...base, status }), /\(still running\)/);
        }
    });

    it("survives null counters", () => {
        const text = formatJob({
            ...base,
            rows_total: null,
            rows_done: null,
            rows_failed: null,
        });

        assert.match(text, /Rows: 0\/0 done/);
    });
});

describe("formatDataset", () => {
    const dataset: DatasetSummary = {
        id: "ds_1",
        filename: "march-invoices.xlsx",
        sheet_name: "Data",
        columns: [
            { key: "invoice_no", original: "Invoice No", inferred_type: "number" },
            { key: "client", original: "client", inferred_type: "string" },
        ],
        row_count: 120,
        created_at: "2026-08-24T10:00:00Z",
    };

    it("leads with the id, file and row count", () => {
        const text = formatDataset(dataset);

        assert.match(text, /^Dataset ds_1$/m);
        assert.match(text, /File: march-invoices\.xlsx \(sheet "Data"\)/);
        assert.match(text, /Rows: 120/);
        assert.match(text, /Created: 2026-08-24T10:00:00Z/);
    });

    it("shows the sanitized key and the header it came from", () => {
        const text = formatDataset(dataset);

        // The key is what group_by and the placeholders address; a model that
        // reads "Invoice No" off this result and passes that to create_batch_job
        // has named a column that does not exist.
        assert.match(text, /use the key in template placeholders/);
        assert.match(text, /- invoice_no \(number\) — from "Invoice No"/);
        // No "from" noise when sanitizing changed nothing.
        assert.match(text, /- client \(string\)$/m);
    });

    it("survives a dataset with no columns and null fields", () => {
        const text = formatDataset({
            ...dataset,
            filename: null,
            sheet_name: null,
            row_count: null,
            created_at: null,
            columns: [],
        });

        assert.match(text, /File: \(unnamed\)$/m);
        assert.match(text, /Rows: 0/);
        assert.match(text, /Columns: none detected\./);
        assert.doesNotMatch(text, /Created:/);
    });
});

describe("formatDatasets", () => {
    const dataset: DatasetSummary = {
        id: "ds_1",
        filename: "clients.csv",
        sheet_name: "Sheet1",
        columns: [{ key: "client", original: "client", inferred_type: "string" }],
        row_count: 2,
        created_at: "2026-08-24T10:00:00Z",
    };

    it("names both ways to make one when there are none", () => {
        const text = formatDatasets([]);

        assert.match(text, /No datasets/);
        assert.match(text, /create_dataset/);
        assert.match(text, /upload_dataset/);
    });

    it("counts and separates the datasets it lists", () => {
        const text = formatDatasets([dataset, { ...dataset, id: "ds_2" }]);

        assert.match(text, /^2 datasets \(newest first\):/);
        assert.match(text, /Dataset ds_1/);
        assert.match(text, /Dataset ds_2/);
    });

    it("uses the singular for one", () => {
        assert.match(formatDatasets([dataset]), /^1 dataset \(newest first\):/);
    });
});

describe("readDatasetFile", () => {
    async function tempFile(name: string, contents: string): Promise<string> {
        const dir = await mkdtemp(join(tmpdir(), "sheetrender-test-"));
        const path = join(dir, name);
        await writeFile(path, contents);
        return path;
    }

    it("reads a .csv and names it by its basename", async () => {
        const path = await tempFile("clients.csv", "client,total\nAcme,42\n");
        const { filename, bytes } = await readDatasetFile(path);

        assert.equal(filename, "clients.csv");
        assert.equal(new TextDecoder().decode(bytes), "client,total\nAcme,42\n");
    });

    it("accepts .xlsx and an uppercase extension", async () => {
        const path = await tempFile("Book1.XLSX", "PKstub");
        assert.equal((await readDatasetFile(path)).filename, "Book1.XLSX");
    });

    it("refuses a format the server cannot parse, and points at create_dataset", async () => {
        const path = await tempFile("report.pdf", "%PDF-1.4");
        await assert.rejects(
            readDatasetFile(path),
            (error: Error) =>
                error instanceof SheetRenderError &&
                /not a spreadsheet SheetRender can read/.test(error.message) &&
                /create_dataset/.test(error.message),
        );
    });

    it("refuses an empty file rather than uploading no rows", async () => {
        const path = await tempFile("empty.csv", "");
        await assert.rejects(readDatasetFile(path), /is empty/);
    });

    it("refuses a file over the 20 MB cap before it is sent", async () => {
        const path = await tempFile("huge.csv", "a");
        // Sparse: 21 MB of stat.size without 21 MB of writing.
        await truncate(path, MAX_DATASET_UPLOAD_BYTES + 1024 * 1024);

        await assert.rejects(
            readDatasetFile(path),
            (error: Error) =>
                /21\.00 MB/.test(error.message) &&
                /20\.00 MB upload limit/.test(error.message) &&
                /Split it into smaller files/.test(error.message),
        );
    });

    it("reports a missing file as a read failure, not a crash", async () => {
        const path = join(tmpdir(), "sheetrender-does-not-exist-1234.csv");
        await assert.rejects(
            readDatasetFile(path),
            (error: Error) =>
                error instanceof SheetRenderError && /Could not read/.test(error.message),
        );
    });

    it("refuses a directory", async () => {
        const dir = await mkdtemp(join(tmpdir(), "sheetrender-test-"));
        const path = join(dir, "data.csv");
        await mkdir(path);

        await assert.rejects(readDatasetFile(path), /is a directory/);
    });

    it("expands a leading ~ to the home directory", async () => {
        // A test writes nothing into $HOME, so the observable effect of the
        // expansion is the resolved path in the failure message.
        await assert.rejects(
            readDatasetFile("~/sheetrender-does-not-exist-1234.csv"),
            (error: Error) => error.message.includes(homedir()),
        );
    });
});
