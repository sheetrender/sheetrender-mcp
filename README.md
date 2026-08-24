# @sheetrender/mcp

MCP server for [SheetRender](https://sheetrender.com). It lets your AI assistant
render PDFs from HTML templates and spreadsheet data.

## Setup

Get an API key from [sheetrender.com](https://sheetrender.com) under Settings →
API keys, then add this to your MCP client config:

```json
{
  "mcpServers": {
    "sheetrender": {
      "command": "npx",
      "args": ["-y", "@sheetrender/mcp"],
      "env": { "SHEETRENDER_API_KEY": "sr_live_..." }
    }
  }
}
```

`SHEETRENDER_API_URL` is also read, and defaults to `https://sheetrender.com`.
Set it only if you're pointing at a self-hosted or staging instance.

## Tools

### `render_pdf`

Renders one PDF from HTML you supply.

| Argument | Type | |
| --- | --- | --- |
| `html` | string | Required. A full HTML document. CSS has to be inline in a `<style>` tag; external stylesheets, fonts and scripts are not fetched. |
| `data` | object | Optional. Keys become Jinja variables, so `{"total": "42.00"}` makes `{{ total }}` available in the HTML. |
| `page_settings` | object | Optional, see below. |

Returns the path of the saved PDF and its size. Under 512 KB it's also attached
inline as a base64 resource, so clients that display attachments show the
document itself.

Two server limits apply. HTML over 2 MB is rejected, and that's measured both on
what you send and on the document after `data` is substituted in, so a template
that expands a long dataset can cross the line even when the markup you wrote
doesn't. The other is the free plan, where every rendered PDF carries a "Made
with SheetRender" footer. That applies to `render_pdf` and `render_template`
alike. Paid plans don't get it.

### `list_templates`

No arguments. Returns each saved template's name, id and last-updated date. Call
it to turn a template name the user mentioned into the id the other tools want.

### `render_template`

Renders one PDF from a template already saved in the account.

| Argument | Type | |
| --- | --- | --- |
| `template_id` | string | Required, from `list_templates`. |
| `data` | object | Required. One row's values, as Jinja variables. |
| `page_settings` | object | Optional. Omit it to keep the template's own saved page setup; passing it overrides that for this render. |

Same return as `render_pdf`.

### `create_dataset`

Turns JSON rows into a dataset a batch job can render. This is the usual way to
start a batch: assemble the rows, send them, get back a `dataset_id`.

| Argument | Type | |
| --- | --- | --- |
| `template_id` | string | Required, from `list_templates`. The dataset lands in that template's project. |
| `rows` | array of objects | Required. One flat object per document. |
| `name` | string | Optional label, used as the stored filename. |

The header is the union of every row's keys in first-seen order, so rows don't
have to agree on their keys — a missing one is a blank cell rather than a
shifted row. Values have to be scalars: strings, numbers, booleans or null.
Nested objects and arrays are rejected, and so are NaN, Infinity and whole
numbers past 2^53 (send those as strings to keep them exact). The caps are
50,000 rows and 500,000 cells per call.

Returns the dataset id, row count and, for each column, the **sanitized key**.
That key is what template placeholders, `filename_template` and `group_by`
address, and it's often not the header verbatim — `Invoice No` becomes
`invoice_no`. Read it off this result instead of guessing.

Creating a dataset is free; only rendering counts against the plan.

### `upload_dataset`

The same thing from a file that already exists.

| Argument | Type | |
| --- | --- | --- |
| `template_id` | string | Required, from `list_templates`. |
| `file_path` | string | Required. A `.csv` or `.xlsx` on the machine running this server — the user's machine, not SheetRender's. `~` is expanded. |

The first row has to be the header. Files over 20 MB, the wrong extension and
empty files are refused locally, before anything is uploaded. Same return as
`create_dataset`.

### `list_datasets`

Takes `template_id` and lists every dataset in that template's project, newest
first, with ids, row counts and column keys. Use it to find data the user
already loaded, or to read a dataset's column keys before writing a
`filename_template` or picking `group_by`.

### `create_batch_job`

Queues a background job that renders one PDF per row of a dataset. The whole
loop runs from here — `list_templates` → `create_dataset` or `upload_dataset` →
`create_batch_job` → `get_job` → `get_document`.

| Argument | Type | |
| --- | --- | --- |
| `template_id` | string | Required, from `list_templates`. |
| `dataset_id` | string | Required, from `create_dataset`, `upload_dataset` or `list_datasets`. Must be in the same project as the template. |
| `filename_template` | string | Optional. Output naming pattern, e.g. `invoice-{{ invoice_no }}`. |
| `group_by` | string | Optional. Column key to group rows by, giving one multi-page PDF per distinct value. |

Returns the job id to poll with `get_job`. Worth knowing: `filename_template`
and `group_by` are persisted to the template and the project respectively, so
they change the defaults for later runs too.

If the server predates the public batch endpoint, the tool reports that batch
jobs are unavailable rather than failing obscurely. The three dataset tools do
the same for a server that predates the dataset endpoints.

### `get_job`

Takes `job_id`. Returns the status, rows done and failed, and the id and
filename of every rendered document. That document list stays empty while the
job is `queued`, `retry_queued` or `running`, and fills in once the job reaches
`succeeded`, `partial`, `failed` or `cancelled`. Those document ids are what
`get_document` takes.

### `get_document`

Takes `document_id` and downloads that single rendered PDF. The ids come from
`get_job` on a finished batch, and there's no other way to get one. Same return
as `render_pdf`: path, size, and an inline blob under 512 KB.

If you want a whole batch, the merged PDF and ZIP in the web app beat fetching
each document in turn.

### `page_settings`

Shared by both render tools. Every field is optional:

```json
{
  "page_size": "a4",
  "orientation": "portrait",
  "margins": { "top": 15, "right": 15, "bottom": 15, "left": 15 }
}
```

`page_size` is lowercase: `a3`, `a4`, `a5`, `letter`, `legal` or `tabloid`.
Margins are plain numbers in millimetres, not CSS lengths.

Rendered PDFs are written to the system temp directory. API errors like a bad
key, a missing template or a rate limit come back as tool errors carrying the
server's own message.

The public API allows 120 requests per minute per API key. Past that it returns
429, and the tool reports that you're rate limited and should retry shortly.
Batch job creation is metered separately and more tightly.

## Development

You don't need node or npm on the host: `scripts/dev.sh install`, then
`scripts/dev.sh deno task build`.

MIT licensed.
