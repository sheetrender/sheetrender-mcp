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

/**
 * The directory-policy word check, as the listing's release step runs it.
 * Whole words only, so a name such as "Freeman" or a word such as
 * "explanation" or "planned" passes; "free-form" still matches.
 */
export const BANNED_WORDS =
    /\b(?:free|freely|pric(?:e|es|ed|ing)|plans?|trials?|upgrad(?:e|es|ed|ing)|subscri\w*|discounts?)\b/i;

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
        "must be text, numbers, true/false or null; a text value may hold at most 2000 " +
        "characters unless list_document_templates gives a different limit for that field. " +
        "Renders up to 25 rows per call and up to " +
        "50 documents per month for each user; the response says how many documents remain " +
        "this month (or that the month's limit is shared with other users) and when the count " +
        "resets. Rows missing a required field are reported in " +
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

    /**
     * The `continue.how` field in render_documents' structured output. Plain
     * fact only: the model text carries no sentence about the website.
     */
    continueHow: "create_continue_link loads these rows on the template page at guide_url.",

    /** Describes a text cell in the tools' input schema. */
    cellText:
        "Text. A field's length limit is listed by list_document_templates; 2000 characters " +
        "when none is given.",
    /** A text value over its field's limit. `{row}` counts from 1. */
    cellTooLong:
        "Row {row}, field {field}: the text is longer than the limit of {chars} characters " +
        "or {bytes} UTF-8 bytes. Shorten it and try again.",
    /** A text value with more lines than its field allows. `{row}` counts from 1. */
    cellTooManyLines:
        "Row {row}, field {field}: the text has more than {lines} lines. Shorten it and try again.",

    invoking: "Rendering documents",
    invoked: "Documents ready",
    continueInvoking: "Creating the link",
    continueInvoked: "Link ready",

    /** The flood guard's answer. `{minutes}` is filled in. */
    tooManyCalls:
        "Too many requests from this user in the last hour. Try again in {minutes} minutes.",
    tooManySharedCalls:
        "The document service is receiving too many requests. Try again in {minutes} minutes.",
    /** The coarser per-network flood guard (IPv4 /24, IPv6 /48). */
    tooManyNetworkCalls:
        "Too many requests from this network in the last hour. Try again in {minutes} minutes.",
    /** The volume line when the month's limit that applies is shared with other users. */
    sharedVolume: "This month's document limit is shared with other users",
    /** The backend refused for capacity reasons (HTTP 429 without a volume body). */
    busy: "SheetRender cannot render more documents right now. Try again later.",
    /** The same for create_continue_link. */
    continueBusy: "SheetRender cannot create another continue link right now. Try again later.",
} as const;
