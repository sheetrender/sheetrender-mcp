# @sheetrender/mcp

MCP server for [SheetRender](https://sheetrender.com) — give your AI assistant
the ability to render PDFs from HTML templates and spreadsheet data.

## Setup

Get an API key from [sheetrender.com](https://sheetrender.com) → Settings →
API keys, then add to your MCP client config:

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

`SHEETRENDER_API_URL` is also read, defaulting to `https://sheetrender.com`. Set
it only to point at a self-hosted or staging instance.

## Tools

### `render_pdf`

Renders one PDF from HTML you supply.

| Argument | Type | |
| --- | --- | --- |
| `html` | string | required — a full HTML document. CSS must be inline in a `<style>` tag; external stylesheets, fonts and scripts are not fetched. |
| `data` | object | optional — keys become Jinja variables, so `{"total": "42.00"}` makes `{{ total }}` available in the HTML. |
| `page_settings` | object | optional — see below. |

Returns the path of the saved PDF and its size. Under 512 KB it is also attached
inline as a base64 resource, so clients that display attachments show the
document itself.

### `list_templates`

No arguments. Returns each saved template's name, id and last-updated date. Call
it to turn a template name the user mentioned into the id the other tools want.

### `render_template`

Renders one PDF from a template already saved in the account.

| Argument | Type | |
| --- | --- | --- |
| `template_id` | string | required — from `list_templates`. |
| `data` | object | required — one row's values, as Jinja variables. |
| `page_settings` | object | optional. Omit it to keep the template's own saved page setup; passing it overrides that for this render. |

Same return as `render_pdf`.

### `create_batch_job`

Queues a background job that renders one PDF per row of a dataset already
uploaded to the project. This server cannot upload spreadsheets.

| Argument | Type | |
| --- | --- | --- |
| `template_id` | string | required — from `list_templates`. |
| `dataset_id` | string | required — a dataset in the same project as the template. |
| `filename_template` | string | optional — output naming pattern, e.g. `invoice-{{ invoice_no }}`. |
| `group_by` | string | optional — column to group rows by, giving one multi-page PDF per distinct value. |

Returns the job id to poll with `get_job`. Note that `filename_template` and
`group_by` are persisted to the template and project respectively, so they
change the defaults for later runs too.

If the server predates the public batch endpoint, the tool reports that batch
jobs are unavailable rather than failing obscurely.

### `get_job`

Takes `job_id`. Returns the status, rows done and failed, and — once the job
reaches `succeeded`, `partial`, `failed` or `cancelled` — the id and filename of
every rendered document. The document list stays empty while the job is
`queued`, `retry_queued` or `running`.

### `page_settings`

Shared by both render tools, every field optional:

```json
{
  "page_size": "a4",
  "orientation": "portrait",
  "margins": { "top": 15, "right": 15, "bottom": 15, "left": 15 }
}
```

`page_size` is lowercase — `a3`, `a4`, `a5`, `letter`, `legal` or `tabloid`.
Margins are plain numbers in millimetres, not CSS lengths.

Rendered PDFs are written to the system temp directory. Errors from the API —
a bad key, a missing template, a rate limit — come back as tool errors carrying
the server's own message.

## Development

No host node/npm needed — `scripts/dev.sh install`, `scripts/dev.sh deno task build`.

MIT licensed.
