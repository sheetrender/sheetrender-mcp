import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { describe, it } from "node:test";

import { SheetRenderError, type JobStatus } from "../src/client.js";
import {
    formatBytes,
    formatJob,
    formatTemplates,
    looksLikeMissingRoute,
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
