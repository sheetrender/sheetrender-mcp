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

## Hosted endpoint

The same server runs at **`https://mcp.sheetrender.com/mcp`** over Streamable
HTTP, so clients that can't spawn a local process can use it too. Nothing is
installed; each request carries your API key:

```
Authorization: Bearer sr_live_...
```

Requests without that header get a 401. The key goes straight through to the
SheetRender API for that one request and is never stored — the server keeps no
sessions, so every request stands alone.

Where the key goes depends on the client:

- **Claude Code**:
  `claude mcp add --transport http sheetrender https://mcp.sheetrender.com/mcp --header "Authorization: Bearer sr_live_..."`
- **Cursor, Windsurf, VS Code** and other clients with an `mcp.json`:

  ```json
  {
    "mcpServers": {
      "sheetrender": {
        "url": "https://mcp.sheetrender.com/mcp",
        "headers": { "Authorization": "Bearer sr_live_..." }
      }
    }
  }
  ```

- **Claude API** (the Messages API's MCP connector): add
  `{"type": "url", "url": "https://mcp.sheetrender.com/mcp", "name": "sheetrender", "authorization_token": "sr_live_..."}`
  to `mcp_servers`.
- **claude.ai, Claude Desktop and ChatGPT custom connectors** take a server URL
  and an OAuth client, not a static header. Until the endpoint speaks OAuth,
  use the stdio package above there — it's the same tools, with the key in
  `env` — or bridge with `npx mcp-remote https://mcp.sheetrender.com/mcp --header "Authorization: Bearer sr_live_..."`
  as the command.

Two differences from the stdio server follow from the process not running on
your machine. Rendered PDFs come back inline as a base64 resource (up to 8 MB;
larger ones are reported with their size and left for the web app) instead of
as a temp-file path, and `upload_dataset` is not offered because there is no
local file to read — send rows with `create_dataset` instead.

`GET /healthz` answers 200 without credentials. Request bodies are capped at
25 MB; anything larger is a 413.

### Without a key (ChatGPT and Claude directory listings)

When the server runs with `SHEETRENDER_DEMO_API_KEY` set, a request that
sends **no** `Authorization` header gets a different, smaller tool set
instead of a 401. These tools fill SheetRender's built-in templates
(certificate of completion, letter, donation receipt, job offer letter) from
rows in the chat, through a dedicated rendering account:

- `list_document_templates`: the templates, their fields (key, label,
  required, example) and each one's page on the website.
- `render_documents`: up to 25 rows per call, one PDF per row; returns a PNG
  preview and a PDF link per document (both expire after an hour), the rows
  that missed a required field, and how many of the month's 50 documents per
  user remain.
- `create_continue_link`: up to 100 rows, stored for 7 days, and a link to the
  template's page on the website with those rows loaded. Called only when the
  user wants to continue there.

`render_documents` comes with an [MCP Apps](https://apps.extensions.modelcontextprotocol.io/)
view, `ui://sheetrender/documents.html` (`text/html;profile=mcp-app`): a strip
of previews with PDF links and a "Continue in SheetRender with these rows"
button. Its script, `src/widget/documents.ts`, is bundled by esbuild into
`dist/widget/documents.js` during `deno task build` and inlined into the page
when the resource is read.

Calls are counted per user: ChatGPT's anonymised `openai/subject`, else the
client IP. Any caller can send `openai/subject`, so it is believed only from
OpenAI's published egress ranges ([chatgpt-connectors.json](https://openai.com/chatgpt-connectors.json),
overridable with `OPENAI_EGRESS_CIDRS`); from anywhere else the call is
counted by IP. The server allows 30 render or continue calls per subject or IP
per hour (`ANON_CALLS_PER_HOUR`). All traffic from Claude's
`160.79.104.0/21` network shares a separate 3,000-call hourly bucket
(`CLAUDE_CALLS_PER_HOUR`), so its shared addresses do not exhaust an
individual user's flood guard. Neither User-Agent text nor `_meta` can claim
or leave this bucket.
The SheetRender API still applies the monthly document volume against the
hashed subject or IP. The subject and IP are sent to the API only as SHA-256
hashes, and the request log carries a fingerprint, the detected client (`chatgpt`,
`claude` or `other`) and the row count, never the rows.

Anonymous HTTP bodies are capped at 2 MB, enough for 25 rows at every
field's limit; a continue link's rows are capped at 256 KB. A private socket peer is
treated as a proxy and only the final valid IP in `X-Forwarded-For` is
trusted. Keep this listener behind Caddy, with no publicly exposed container
port, as in the deployment's Compose topology.

A request carrying a SheetRender bearer key uses the API-key tools above.
A malformed `Authorization` header is rejected. The stdio server never
offers the anonymous tools.

### Running it yourself

`sheetrender-mcp-http` is a second bin in the package. It reads `PORT`
(default 8080), `HOST` (default `0.0.0.0`), `SHEETRENDER_API_URL`,
`MAX_BODY_BYTES` and `IDLE_TIMEOUT_MS` (default 60000), and logs one JSON
line per request to stdout — method, path, status, duration, the JSON-RPC
method and tool name, and a fingerprint of the key, never the key.

For the anonymous tools it also reads:

| Variable | |
| --- | --- |
| `SHEETRENDER_DEMO_API_KEY` | The dedicated rendering account's `sr_` key. Unset: no anonymous tools, keyless requests get a 401. |
| `MCP_PUBLIC_URL` | The URL users paste, byte for byte, e.g. `https://mcp.sheetrender.com/mcp`. Sets the view's sandbox origin (Claude hashes this exact string). |
| `OPENAI_APPS_CHALLENGE` | OpenAI's domain-verification token, served as plain text at `GET /.well-known/openai-apps-challenge` (404 when unset). |
| `ANON_CALLS_PER_HOUR` | Render and continue calls per subject or IP per hour, default 30. |
| `CLAUDE_CALLS_PER_HOUR` | Shared render and continue calls per hour for all traffic from `160.79.104.0/21`, default 3000. |
| `OPENAI_EGRESS_CIDRS` | Comma- or space-separated CIDRs whose `openai/subject` is believed, replacing the built-in copy of [chatgpt-connectors.json](https://openai.com/chatgpt-connectors.json); `none` believes no subject. |

With `SHEETRENDER_DEMO_API_KEY` set, the server refuses to start if the view
bundle (`dist/widget/documents.js`) is missing. The `Dockerfile` in this repo
builds a non-root runtime image for it:

```sh
docker build -t sheetrender-mcp .
docker run --rm -p 8080:8080 sheetrender-mcp
```

## Tools

- `design_template`: Design from exactly one of `dataset_id`, inline `rows`, `data_base64` plus `data_filename`, or stdio-only `data_path`, and an example, brief or style. Data files must be CSV or XLSX, up to 10 MB. Waits up to 3 minutes and returns status, template details and an authenticated preview URL. Examples use `example_base64` plus `example_filename`, or stdio-only `example_path`.
- `get_design`: Poll a `design_id` for its status, template id, name, column mapping and preview URL.

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

HTML over 2 MB is rejected, and that's measured both on
what you send and on the document after `data` is substituted in, so a template
that expands a long dataset can cross the line even when the markup you wrote
doesn't. A "Made with SheetRender" footer is added when required by the
rendering account's settings. That applies to `render_pdf` and
`render_template` alike.

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

Creating a dataset does not consume document volume; only rendering does.

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
`scripts/dev.sh deno task build` and `scripts/dev.sh deno task test`.
`scripts/dev.sh node dist/http.js` runs the HTTP server on the host network.

MIT licensed.
