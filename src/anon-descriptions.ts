/**
 * The text a model reads for the anonymous tools (hosted mode with
 * SHEETRENDER_DEMO_API_KEY set): server instructions, tool titles and
 * descriptions, and the fixed sentences the tools return.
 *
 * Kept apart from descriptions.ts because the app directories hold this text to
 * stricter rules than the API-key tools: nothing here may mention pricing,
 * subscriptions, trials, upgrades or anything "free", and nothing may read as
 * an advertisement. `BANNED_WORDS` is that rule as a regex; the tests run it
 * over every string in this file, the widget and the tools' output.
 */

/** The directory-policy word check, as the listing's release step runs it. */
export const BANNED_WORDS = /free|pricing|price|plan|trial|upgrade|subscri|discount/i;

/** The four built-in templates, in catalogue order. */
export const TEMPLATE_KEYS = ["certificate", "letter", "donation_receipt", "job_offer_letter"] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

/**
 * Each built-in template's public page on the website, which is also the seed
 * the website uses when a continue link has expired. One for one, fixed.
 */
export const TEMPLATE_SLUGS: Record<TemplateKey, string> = {
    certificate: "certificate-of-completion",
    letter: "mail-merge-letter",
    donation_receipt: "donation-receipt",
    job_offer_letter: "job-offer-letter",
};

/** Plain names, used when the catalogue is unavailable or omits one. */
export const TEMPLATE_NAMES: Record<TemplateKey, string> = {
    certificate: "Certificate of completion",
    letter: "Letter",
    donation_receipt: "Donation receipt",
    job_offer_letter: "Job offer letter",
};

export const RENDER_ROW_LIMIT = 25;
export const CONTINUE_ROW_LIMIT = 100;

export const ANON_TEXT = {
    instructions:
        "SheetRender fills built-in document templates (certificate of completion, letter, " +
        "donation receipt, job offer letter) from rows of data and returns one PDF per row. " +
        "The usual order is: list_document_templates, then map the user's columns onto one " +
        "template's field keys, then render_documents. Call create_continue_link only when " +
        "the user asks to continue on the SheetRender website, keep the rows, repeat or " +
        "schedule the job, or have the documents delivered by email.",

    listTitle: "List document templates",
    list:
        "List the document templates this server can fill from rows of data: certificate of " +
        "completion, letter, donation receipt and job offer letter. Returns each template's " +
        "key, name, a one-line description, page size and orientation, the link to its guide " +
        "page, and its fields (key, label, whether it is required, an example value, and how " +
        "the value is printed). Call this first " +
        "when the user wants PDFs made from a spreadsheet, a table, a CSV or a list of people, " +
        "so you can map their columns onto a template's field keys before calling " +
        "render_documents. Takes no arguments.",

    renderTitle: "Render documents from rows",
    render:
        "Render one PDF per row of data with a built-in template, and return a PNG preview and " +
        "a PDF download link for each document. Use when the user has a spreadsheet, table, " +
        "CSV or list and wants a certificate of completion, letter, donation receipt or job " +
        "offer letter for each row. Get the field keys from list_document_templates, map the " +
        "user's columns onto them, and pass each row as an object keyed by field key; values " +
        "must be text, numbers, true/false or null. Renders up to 25 rows per call and up to " +
        "50 documents per month for each user; the response says how many documents remain " +
        "this month and when the count resets. Rows missing a required field are reported in " +
        "missing_fields. Preview and PDF links expire after one hour. This tool only fills the " +
        "built-in templates; it does not accept HTML or custom designs.",

    continueTitle: "Create a continue link",
    continue:
        "Create a link to the template's page on the SheetRender website with the user's rows " +
        "loaded. From that page the rows can be kept as a project, connected to a Google " +
        "Sheet, rendered again on a schedule, or delivered as a zip, a merged PDF or by email. " +
        "Call this only when the user asks to continue on the website, to keep or save the " +
        "rows, to repeat or schedule the job, or to have the documents delivered by email; do " +
        "not call it otherwise. Accepts up to 100 rows. The rows are stored until they are " +
        "loaded into a project or for 7 days, whichever comes first, and the link expires " +
        "after 7 days.",

    /** The `continue.how` sentence in render_documents output. */
    continueHow:
        "On the template page the same rows can be kept as a project, connected to a Google " +
        "Sheet, rendered on a schedule, and delivered as a zip, merged PDF or email.",

    invoking: "Rendering documents",
    invoked: "Documents ready",
    continueInvoking: "Creating the link",
    continueInvoked: "Link ready",

    /** The flood guard's answer. `{minutes}` is filled in. */
    tooManyCalls:
        "Too many requests from this user in the last hour. Try again in {minutes} minutes.",
    tooManySharedCalls:
        "The document service is receiving too many requests. Try again in {minutes} minutes.",
    /** The backend refused for capacity reasons (HTTP 429 without a volume body). */
    busy: "SheetRender cannot render more documents right now. Try again later.",
    /** The same for create_continue_link. */
    continueBusy: "SheetRender cannot create another continue link right now. Try again later.",
} as const;
