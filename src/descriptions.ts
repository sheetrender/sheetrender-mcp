/**
 * The text the model reads: the server instructions and each tool's
 * description.
 *
 * Kept apart from `index.ts` so that file is schemas and handlers only. The
 * wording differs between the two deployments in a handful of places, all of
 * them because the hosted server cannot see the user's disk: it returns PDFs
 * inline rather than as a temp-file path, and it has no `upload_dataset`.
 */

const WHAT_IS_SHEETRENDER =
    "SheetRender turns HTML templates plus spreadsheet rows into rendered PDFs.";

export interface ToolDescriptions {
    instructions: string;
    renderPdf: string;
    listTemplates: string;
    designTemplate: string;
    getDesign: string;
    renderTemplate: string;
    createDataset: string;
    /** Registered by the stdio server only. */
    uploadDataset: string;
    listDatasets: string;
    createBatchJob: string;
    /** The `dataset_id` parameter of create_batch_job. */
    batchJobDatasetId: string;
    getJob: string;
    getDocument: string;
}

export function describeTools(hosted: boolean): ToolDescriptions {
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
    const datasetToolsPutIt = hosted
        ? "create_dataset puts it"
        : "create_dataset or upload_dataset put it";
    const keyReporters = hosted
        ? "create_dataset and list_datasets both report"
        : "create_dataset, upload_dataset and list_datasets all report";
    const otherDatasetTools = hosted
        ? "Use list_datasets when the user is referring to a dataset that already exists."
        : "Use upload_dataset instead when the data is already a file on disk, and " +
            "list_datasets when the user is referring to a dataset that already exists.";
    const pastTheRowCap = hosted
        ? "A bigger sheet has to be split across several datasets and jobs, or " +
            "uploaded by the user in the SheetRender web app."
        : "The row cap applies to JSON rows only — a bigger sheet can still go " +
            "through upload_dataset as a file, which is bounded by size and cells " +
            "rather than rows.";

    return {
        instructions:
            `${WHAT_IS_SHEETRENDER} Use render_pdf for one-off documents built from ` +
            "HTML you write, and render_template for documents from a template already " +
            "saved in the user's account (list_templates finds their ids).\n\n" +
            "Use design_template to create a template from data and an example or brief.\n\n" +
            "For many documents at once, the whole batch runs from here without the web " +
            `app: list_templates -> ${datasetSources} -> create_batch_job -> get_job ` +
            "to poll -> get_document to download each PDF. list_datasets finds datasets that " +
            "already exist on a template's project.",

        designTemplate:
            "Design a saved template from exactly one of dataset_id, inline rows, or " +
            "data_base64 with data_filename (CSV or XLSX, up to 10 MB), and an example, brief, " +
            "or style_id. Use an example alone, or a brief with optional style_id. " +
            "Examples accept PDF, PNG, JPG, WebP or DOCX as base64 with a filename. " +
            (hosted ? "" : "Local data_path can supply the data; example_path can supply the example. ") +
            "Waits up to 3 minutes; returns the design status, template id, mapping and preview URL.",

        getDesign:
            "Get a design's status and, when complete, its template id, name, mapping and preview URL.",

        renderPdf:
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

        listTemplates:
            `${WHAT_IS_SHEETRENDER} This tool lists the templates saved in the user's ` +
            "account, with the id each one needs.\n\n" +
            "Call it first whenever the user refers to a template by name (\"render the " +
            "invoice template\") so you can map that name to an id — every other tool " +
            "here takes a template_id, including create_dataset and list_datasets. Takes " +
            "no arguments.",

        renderTemplate:
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

        createDataset:
            `${WHAT_IS_SHEETRENDER} This tool turns rows you already hold — as JSON — ` +
            "into a dataset a batch job can render, and returns the dataset id plus the " +
            "column keys.\n\n" +
            "This is the normal way to start a batch: the user asks for \"an invoice for " +
            "each of these clients\" or \"a letter per employee\", you assemble the rows, " +
            `and this uploads them. ${otherDatasetTools}\n\n` +
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
            `${pastTheRowCap} ` +
            "Creating a dataset is free; only rendering counts against the account's " +
            "plan.\n\n" +
            "Returns the dataset id and, for each column, the sanitized `key`. That key — " +
            "not the original header — is what the template's placeholders, " +
            "`filename_template` and `group_by` address, so read it off this result " +
            "rather than guessing from the header text.",

        uploadDataset:
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

        listDatasets:
            `${WHAT_IS_SHEETRENDER} This tool lists the datasets a batch job can render ` +
            "with a given template — everything in that template's project, newest " +
            "first — with each one's id, row count and column keys.\n\n" +
            "Call it when the user refers to data they have already loaded (\"use the " +
            "customer list I uploaded\") so you can find its id, or to re-run a batch over " +
            "an existing dataset instead of creating a duplicate. When there is nothing " +
            `suitable, create one with ${datasetTools}.\n\n` +
            "It is also the quickest way to see a dataset's sanitized column keys before " +
            "writing a `filename_template` or choosing `group_by`.",

        createBatchJob:
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
            `${datasetToolsPutIt}. Rendering happens in the ` +
            "background, so the job id comes back long before the PDFs do.\n\n" +
            "`filename_template` and `group_by` name columns by their sanitized key, which " +
            `${keyReporters} — it is often not ` +
            'the header text verbatim ("Invoice No" becomes invoice_no). Both are saved ' +
            "onto the template/project, so they change the defaults for later runs, not " +
            "just this one. Only pass them when the user asked to change how output is " +
            "named or grouped.",

        batchJobDatasetId:
            `Dataset id from ${
                hosted
                    ? "create_dataset or list_datasets"
                    : "create_dataset, upload_dataset or list_datasets"
            }. It must belong to the same template's project.`,

        getJob:
            `${WHAT_IS_SHEETRENDER} This tool reports the progress of a batch job started ` +
            "by create_batch_job.\n\n" +
            "Returns the status, rows done/failed, and — once the job reaches a finished " +
            'state ("succeeded", "partial", "failed" or "cancelled") — the id and filename ' +
            "of every rendered document. The document list is empty while the job is still " +
            'in "queued", "retry_queued" or "running", so poll again after a short wait ' +
            "rather than assuming zero documents.\n\n" +
            "Pass those document ids to get_document to download the individual PDFs.",

        getDocument:
            `${WHAT_IS_SHEETRENDER} This tool downloads one PDF produced by a batch job ` +
            `${pdfHandoff}\n\n` +
            "`document_id` comes from get_job on a finished batch — that is the only place " +
            "these ids appear, so call get_job first and take an id from its document list. " +
            "A document id is not a template id or a job id.\n\n" +
            "Use it to fetch a specific output the user asked about, or to spot-check a " +
            "batch. Fetching every document of a large batch one at a time is slow; point " +
            "the user at the SheetRender web app for the merged PDF or ZIP instead.\n\n" +
            pdfReturns,
    };
}
