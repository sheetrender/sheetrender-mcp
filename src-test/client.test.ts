import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { loadConfig, SheetRenderClient, SheetRenderError } from "../src/client.js";

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

function client(): SheetRenderClient {
    return new SheetRenderClient({ baseUrl: "https://api.test", apiKey: "sr_live_test" });
}

/**
 * Replaces global fetch. Pass a `Response` to answer with it, or an `Error` to
 * make the fetch itself reject the way a refused connection does.
 */
function stubFetch(outcome: Response | Error): { calls: Request[] } {
    const calls: Request[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push(new Request(typeof input === "string" ? input : input.toString(), init));
        if (outcome instanceof Error) throw outcome;
        return outcome;
    }) as typeof fetch;
    return { calls };
}

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

async function expectError(promise: Promise<unknown>): Promise<SheetRenderError> {
    try {
        await promise;
    } catch (error) {
        assert.ok(error instanceof SheetRenderError, `expected SheetRenderError, got ${error}`);
        return error;
    }
    throw new Error("expected the call to reject, but it resolved");
}

describe("error mapping", () => {
    it("turns 429 into a retry-shortly message and keeps the server's wording", async () => {
        stubFetch(jsonResponse(429, { detail: "Public API rate limit exceeded" }));
        const error = await expectError(client().listTemplates());

        assert.equal(error.status, 429);
        assert.match(error.message, /rate limited, retry shortly/);
        assert.match(error.message, /Public API rate limit exceeded/);
        assert.match(error.message, /HTTP 429/);
    });

    it("flattens the nested 403 plan-limit detail into its message and code", async () => {
        stubFetch(jsonResponse(403, {
            detail: {
                code: "plan_limit",
                kind: "documents",
                message: "Monthly document limit reached. Please upgrade to continue.",
            },
        }));
        const error = await expectError(
            client().createJob({ template_id: "tpl_1", dataset_id: "ds_1" }),
        );

        assert.equal(error.status, 403);
        assert.match(error.message, /Monthly document limit reached/);
        assert.match(error.message, /\(plan_limit\)/);
        // The raw detail survives for callers that want to branch on the code.
        assert.deepEqual((error.detail as { code: string }).code, "plan_limit");
    });

    it("names the unreachable host when fetch itself fails", async () => {
        stubFetch(new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") }));
        const error = await expectError(client().listTemplates());

        assert.equal(error.status, undefined);
        assert.match(error.message, /could not reach the SheetRender API at https:\/\/api\.test/);
        assert.match(error.message, /fetch failed/);
        assert.match(error.message, /ECONNREFUSED/);
    });

    it("summarises the 422 validation array rather than dumping JSON", async () => {
        stubFetch(jsonResponse(422, {
            detail: [{ loc: ["body", "html"], msg: "Field required", type: "missing" }],
        }));
        const error = await expectError(client().listTemplates());

        assert.match(error.message, /body\.html: Field required/);
    });

    it("falls back to a status hint when the body carries no detail", async () => {
        stubFetch(new Response("<html>gateway</html>", {
            status: 502,
            headers: { "content-type": "text/html" },
        }));
        const error = await expectError(client().listTemplates());

        assert.equal(error.status, 502);
        assert.match(error.message, /HTTP 502/);
    });

    it("keeps the 404 detail verbatim so callers can tell routes from ids", async () => {
        stubFetch(jsonResponse(404, { detail: "Template not found" }));
        const error = await expectError(client().getJob("job_1"));

        assert.equal(error.status, 404);
        assert.equal(error.detail, "Template not found");
    });
});

describe("requests", () => {
    it("sends the bearer token and JSON content type", async () => {
        const stub = stubFetch(jsonResponse(200, []));
        await client().listTemplates();

        const request = stub.calls[0]!;
        assert.equal(request.url, "https://api.test/api/v1/templates");
        assert.equal(request.headers.get("authorization"), "Bearer sr_live_test");
        assert.equal(request.headers.get("accept"), "application/json");
    });

    it("omits page_settings from a template render so stored settings survive", async () => {
        const stub = stubFetch(pdfResponse());
        await client().renderTemplate("tpl_1", { customer: "Acme" });

        const body = await stub.calls[0]!.json() as Record<string, unknown>;
        assert.deepEqual(body, { data: { customer: "Acme" } });
        assert.ok(!("page_settings" in body));
    });

    it("passes page_settings through when supplied", async () => {
        const stub = stubFetch(pdfResponse());
        await client().renderHtml("<html></html>", undefined, {
            page_size: "letter",
            orientation: "landscape",
            margins: { top: 10 },
        });

        const body = await stub.calls[0]!.json() as Record<string, unknown>;
        assert.deepEqual(body, {
            html: "<html></html>",
            page_settings: {
                page_size: "letter",
                orientation: "landscape",
                margins: { top: 10 },
            },
        });
    });

    it("percent-encodes ids into the path", async () => {
        const stub = stubFetch(pdfResponse());
        await client().getDocument("doc/../secret");

        assert.equal(stub.calls[0]!.url, "https://api.test/api/v1/documents/doc%2F..%2Fsecret");
    });

    it("returns the document bytes verbatim", async () => {
        const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x00, 0xff]);
        stubFetch(new Response(pdf, {
            status: 200,
            headers: { "content-type": "application/pdf" },
        }));
        const bytes = await client().getDocument("doc_1");

        assert.deepEqual([...bytes], [...pdf]);
    });

    it("surfaces a missing document as a 404 error", async () => {
        stubFetch(jsonResponse(404, { detail: "Document not found" }));
        const error = await expectError(client().getDocument("doc_gone"));

        assert.equal(error.status, 404);
        assert.match(error.message, /Downloading document doc_gone failed: Document not found/);
    });

    it("rejects an empty PDF body", async () => {
        stubFetch(new Response(new Uint8Array(), {
            status: 200,
            headers: { "content-type": "application/pdf" },
        }));
        const error = await expectError(client().getDocument("doc_1"));

        assert.match(error.message, /empty PDF/);
    });

    it("rejects a non-PDF body on a PDF route", async () => {
        stubFetch(new Response("not a pdf", {
            status: 200,
            headers: { "content-type": "text/html" },
        }));
        const error = await expectError(client().renderHtml("<html></html>"));

        assert.match(error.message, /expected a PDF/);
    });

    it("rejects a non-JSON body on a JSON route", async () => {
        stubFetch(new Response("<html>hi</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
        }));
        const error = await expectError(client().listTemplates());

        assert.match(error.message, /non-JSON response/);
    });
});

describe("datasets", () => {
    const dataset = {
        id: "ds_1",
        filename: "api-rows.xlsx",
        sheet_name: "Data",
        columns: [
            { key: "invoice_no", original: "Invoice No", inferred_type: "number" },
            { key: "client", original: "client", inferred_type: "string" },
        ],
        row_count: 2,
        created_at: "2026-08-24T10:00:00Z",
    };

    it("posts rows to the JSON route and returns the dataset", async () => {
        const stub = stubFetch(jsonResponse(201, dataset));
        const created = await client().createDatasetFromRows("tpl_1", [
            { client: "Acme", total: 42 },
            { client: "Globex" },
        ]);

        const request = stub.calls[0]!;
        assert.equal(request.method, "POST");
        assert.equal(request.url, "https://api.test/api/v1/templates/tpl_1/datasets/rows");
        assert.equal(request.headers.get("content-type"), "application/json");
        assert.deepEqual(await request.json(), {
            rows: [{ client: "Acme", total: 42 }, { client: "Globex" }],
        });
        assert.equal(created.id, "ds_1");
        assert.equal(created.columns[0]!.key, "invoice_no");
    });

    it("omits name unless one was given, and sends it when it was", async () => {
        const first = stubFetch(jsonResponse(201, dataset));
        await client().createDatasetFromRows("tpl_1", [{ a: 1 }]);
        assert.ok(!("name" in (await first.calls[0]!.json() as object)));

        const second = stubFetch(jsonResponse(201, dataset));
        await client().createDatasetFromRows("tpl_1", [{ a: 1 }], "march-invoices");
        assert.deepEqual(await second.calls[0]!.json(), {
            rows: [{ a: 1 }],
            name: "march-invoices",
        });
    });

    it("sends rows verbatim, leaving the header union to the server", async () => {
        // Rows disagreeing on their keys is the documented case: the server
        // builds the header from the union in first-seen order, so the client
        // must not helpfully normalise them into a rectangle first.
        const stub = stubFetch(jsonResponse(201, dataset));
        await client().createDatasetFromRows("tpl_1", [
            { b: 1 },
            { a: 2, b: null },
            {},
        ]);

        assert.deepEqual(await stub.calls[0]!.json(), {
            rows: [{ b: 1 }, { a: 2, b: null }, {}],
        });
    });

    it("refuses the values JSON.stringify would quietly rewrite", async () => {
        // NaN and Infinity serialise to null and an undefined value drops its
        // key, so the server's own 400 never fires and the bad number lands in
        // the spreadsheet as a blank cell. These have to be caught here or not
        // at all — and before the request, so nothing is uploaded.
        for (const [value, expected] of [
            [Number.NaN, /NaN/],
            [Number.POSITIVE_INFINITY, /Infinity/],
            [Number.NEGATIVE_INFINITY, /-Infinity/],
        ] as [number, RegExp][]) {
            const stub = stubFetch(jsonResponse(201, dataset));
            const error = await expectError(
                client().createDatasetFromRows("tpl_1", [{ ok: 1 }, { total: value }]),
            );

            assert.match(error.message, /Row 2, column "total"/);
            assert.match(error.message, expected);
            assert.equal(stub.calls.length, 0, "nothing should have been sent");
        }
    });

    it("refuses an undefined cell and names the alternative", async () => {
        const stub = stubFetch(jsonResponse(201, dataset));
        const error = await expectError(
            client().createDatasetFromRows("tpl_1", [{ total: undefined }]),
        );

        assert.match(error.message, /Row 1, column "total" is undefined/);
        assert.match(error.message, /Use null for a blank cell/);
        assert.equal(stub.calls.length, 0);
    });

    it("passes every value a spreadsheet cell can hold", async () => {
        const stub = stubFetch(jsonResponse(201, dataset));
        await client().createDatasetFromRows("tpl_1", [
            { text: "Acme", count: 42, fraction: 1.5, flag: true, blank: null, zero: 0 },
        ]);

        assert.deepEqual(await stub.calls[0]!.json(), {
            rows: [
                { text: "Acme", count: 42, fraction: 1.5, flag: true, blank: null, zero: 0 },
            ],
        });
    });

    it("uploads a file as multipart with a boundary and a `file` part", async () => {
        const stub = stubFetch(jsonResponse(201, dataset));
        const bytes = new TextEncoder().encode("client,total\nAcme,42\n");
        await client().uploadDataset("tpl_1", "clients.csv", bytes);

        const request = stub.calls[0]!;
        assert.equal(request.url, "https://api.test/api/v1/templates/tpl_1/datasets");
        // Set by fetch from the FormData, not by us — without the boundary the
        // server cannot split the parts.
        assert.match(request.headers.get("content-type") ?? "", /^multipart\/form-data; boundary=/);

        const form = await request.formData();
        const file = form.get("file") as File;
        assert.equal(file.name, "clients.csv");
        assert.equal(await file.text(), "client,total\nAcme,42\n");
    });

    it("uploads only the requested bytes of a pooled Buffer", async () => {
        // Buffer.subarray shares a larger pooled allocation; a Blob over the
        // raw view would ship the neighbours' bytes too.
        const pool = Buffer.from("XXXXclient\nAcme\nYYYY");
        const view = pool.subarray(4, pool.length - 4);
        const stub = stubFetch(jsonResponse(201, dataset));
        await client().uploadDataset("tpl_1", "clients.csv", view);

        const form = await stub.calls[0]!.formData();
        assert.equal(await (form.get("file") as File).text(), "client\nAcme\n");
    });

    it("lists datasets for a template", async () => {
        const stub = stubFetch(jsonResponse(200, [dataset]));
        const datasets = await client().listDatasets("tpl 1/2");

        assert.equal(stub.calls[0]!.method, "GET");
        assert.equal(
            stub.calls[0]!.url,
            "https://api.test/api/v1/templates/tpl%201%2F2/datasets",
        );
        assert.equal(datasets.length, 1);
        assert.equal(datasets[0]!.row_count, 2);
    });

    it("appends split-it advice to a 413, keeping the server's cap", async () => {
        stubFetch(jsonResponse(413, { detail: "File too large (max 20 MB)" }));
        const error = await expectError(
            client().uploadDataset("tpl_1", "big.xlsx", new Uint8Array([1])),
        );

        assert.equal(error.status, 413);
        assert.match(error.message, /File too large \(max 20 MB\)/);
        assert.match(error.message, /Split it into smaller datasets/);
    });

    it("appends data-shape advice to a dataset 400", async () => {
        stubFetch(jsonResponse(400, {
            detail: "Too many rows for a JSON payload (max 50,000). Upload a .csv or .xlsx instead.",
        }));
        const error = await expectError(
            client().createDatasetFromRows("tpl_1", [{ a: 1 }]),
        );

        assert.equal(error.status, 400);
        assert.match(error.message, /max 50,000/);
        assert.match(error.message, /no nested objects or arrays/);
    });

    it("points a 404 back at list_templates instead of leaking existence", async () => {
        stubFetch(jsonResponse(404, { detail: "Template not found" }));
        const error = await expectError(client().listDatasets("tpl_gone"));

        assert.equal(error.status, 404);
        assert.match(error.message, /Template not found/);
        assert.match(error.message, /Check template_id against list_templates/);
    });

    it("still reports a rate limit as one on a dataset route", async () => {
        stubFetch(jsonResponse(429, { detail: "Public API rate limit exceeded" }));
        const error = await expectError(
            client().createDatasetFromRows("tpl_1", [{ a: 1 }]),
        );

        assert.equal(error.status, 429);
        assert.match(error.message, /rate limited, retry shortly/);
    });

    it("leaves other routes' errors free of dataset advice", async () => {
        stubFetch(jsonResponse(404, { detail: "Template not found" }));
        const error = await expectError(
            client().createJob({ template_id: "tpl_1", dataset_id: "ds_1" }),
        );

        assert.ok(!/list_templates/.test(error.message), error.message);
    });
});

describe("loadConfig", () => {
    it("defaults the base URL and trims trailing slashes", () => {
        const config = loadConfig({ SHEETRENDER_API_KEY: "sr_live_x" } as NodeJS.ProcessEnv);
        assert.equal(config.baseUrl, "https://sheetrender.com");

        const custom = loadConfig({
            SHEETRENDER_API_KEY: "sr_live_x",
            SHEETRENDER_API_URL: "http://localhost:8000/",
        } as NodeJS.ProcessEnv);
        assert.equal(custom.baseUrl, "http://localhost:8000");
    });

    it("fails with an actionable message when the key is missing", () => {
        assert.throws(
            () => loadConfig({} as NodeJS.ProcessEnv),
            /SHEETRENDER_API_KEY is not set/,
        );
    });

    it("rejects a malformed base URL", () => {
        assert.throws(
            () => loadConfig({
                SHEETRENDER_API_KEY: "sr_live_x",
                SHEETRENDER_API_URL: "not a url",
            } as NodeJS.ProcessEnv),
            /not a valid URL/,
        );
    });
});

function pdfResponse(): Response {
    return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]), {
        status: 200,
        headers: { "content-type": "application/pdf" },
    });
}
