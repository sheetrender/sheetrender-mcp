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
installed. It supports **OAuth sign-in for account tools** in ChatGPT and
Claude connectors. Add the server URL; the three built-in document tools work
without signing in, and calling an account tool prompts for sign-in. Discovery
lists all 15 tools both before and after OAuth sign-in.

Existing clients can continue sending an API key on each request:

```
Authorization: Bearer sr_live_...
```

The key goes straight through to the SheetRender API for that one request.

OAuth access tokens deliberately carry both the MCP URL and API audiences.
Forwarding them unchanged to the same operator's public API is an intentional
exception to the [MCP token-forwarding restriction](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#access-token-privilege-restriction).
The MCP server introspects them before account calls, and the API independently
re-validates each forwarded token, including its audience, expiry, revocation
and required scopes.

Only SHA-256 digests key the in-memory credential caches; raw credentials are
never logged or persisted.
There are no authenticated MCP sessions: every request stands alone.

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
- **claude.ai, Claude Desktop and ChatGPT custom connectors**: add
  `https://mcp.sheetrender.com/mcp` and use OAuth sign-in when an account tool
  asks to connect. The staging verification of each host's per-tool sign-in
  prompt is still required before directory rollout.

Two differences from the stdio server follow from the process not running on
your machine. Rendered PDFs come back inline as a base64 resource (up to 8 MB;
larger ones are reported with their size and left for the web app) instead of
as a temp-file path, and `upload_dataset` is not offered because there is no
local file to read — send rows with `create_dataset` instead. OAuth discovery
also omits `render_pdf`; it remains available with an API key or over stdio.
The legacy API-key and stdio registries retain their existing tools and
behavior. The new profile and schedule tools are in the hosted OAuth registry.

`GET /healthz` answers 200 without credentials. Request bodies are capped at
25 MB; anything larger is a 413.

A key that merely starts with `sr_` proves nothing, so the server waits for
the SheetRender API to accept it. Until a call made with the key has
succeeded (normally the first tool call, e.g. `list_templates`), its requests
get the same bounds as requests without a key, described below: bodies up to
2 MB, at most 4 JSON-RPC messages per batch, and every message counted toward
the per-network budgets. Once the API has accepted the key, the server
remembers a hash of it (never the key) for an hour after its latest
successful call, and its requests get the 25 MB body cap and batches of up to
20 messages. MCP clients send one message per request, so the batch caps only
matter to hand-written clients. If the very first call is a body over 2 MB
(a large `create_dataset`), it gets a 413 that says to make a small call
first and retry. Every request, with a key or without, counts toward the
server-wide in-flight cap.

Bodies over 2 MB also take one of a few server-wide large-body slots, 1 by
default (`LARGE_BODY_MAX_IN_FLIGHT`). A slot is taken before reading when
`Content-Length` declares such a body, or as soon as a streamed body passes
2 MB, and is held until the response ends. When all are taken, the request
gets a 503 with `Retry-After: 5` and the rest of its body is not read. One 25 MB
body can take around 100 MB of heap while it is decoded, parsed and passed
on, so raise this only with the heap (the hosted container runs a 192 MB
heap).

### Built-in document tools (ChatGPT and Claude directory listings)

With `SHEETRENDER_DEMO_API_KEY` set, these three tools fill SheetRender's built-in templates
(certificate of completion, letter, donation receipt, job offer letter) from
rows in the chat, through a dedicated rendering account:

- `list_document_templates`: the templates, their fields (key, label,
  required, example, character and line limits) and each one's page on the
  website.
- `render_documents`: up to 25 rows per call, one PDF per row; returns a PNG
  preview and a PDF link per document (both expire after an hour), the rows
  that missed a required field, and how many of the month's 50 documents per
  user remain. When a limit shared with other users is what cut or refused the
  call, it says the limit is shared instead of showing a count. A value over
  its field's character or line limit is refused before the API is called, and
  the API's own reason for refusing rows (row number, field and rule, never the
  value) is passed on.
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
counted by IP. The hosted server fetches that list at startup and every 24
hours, keeping the built-in copy (then the last good fetch) whenever a fetch
fails or returns anything malformed or empty; it logs one line per refresh. It
also logs, at most once an hour, how many calls sent an `openai/subject` from
outside the list, so a stale list shows up.

The server allows 30 render or continue calls per subject or IP per hour
(`ANON_CALLS_PER_HOUR`). Callers counted by IP also share a second bucket per
IPv4 /24 or IPv6 /48, 300 calls an hour (`ANON_NETWORK_CALLS_PER_HOUR`), so a
block of cheap addresses counts as one caller. All traffic from Claude's
`160.79.104.0/21` network (Anthropic's published outbound range, which the
Claude API's MCP connector also uses) shares a separate 3,000-call hourly
bucket (`CLAUDE_CALLS_PER_HOUR`); each Claude conversation that sends its
`Mcp-Session-Id` also gets the 30-call per-subject bucket inside it. Neither
User-Agent text nor `_meta` can claim or leave these buckets.
The SheetRender API still applies the monthly document volume against the
hashed subject or IP. The subject and IP are sent to the API only as SHA-256
hashes, and the request log carries a fingerprint, the detected client (`chatgpt`,
`claude` or `other`) and the row count, never the rows.

Anonymous HTTP bodies are capped at 2 MB, enough for 25 rows at every
field's limit; a continue link's rows are capped at 256 KB. A private socket peer is
treated as a proxy and only the final valid IP in `X-Forwarded-For` is
trusted. Keep this listener behind Caddy, with no publicly exposed container
port, as in the deployment's Compose topology.

Anonymous requests have three more bounds, so a small request cannot make
the server generate a lot of output. A JSON-RPC batch may carry at most 4
messages (MCP dropped batching in protocol version 2025-06-18, and ChatGPT
and Claude send one message per request); a larger one gets a 400 before
anything in it runs. Messages other than tool calls (`initialize`,
`tools/list`, `resources/read`, ...) count 600 an hour per IPv4 /24 or IPv6
/48 (`ANON_RPC_PER_HOUR`); traffic from OpenAI's and Claude's egress ranges
is not counted there, since each of those addresses carries many users. And
at most 64 requests, with a key or without, are answered at once (`ANON_MAX_IN_FLIGHT`),
8 per network outside those ranges (`ANON_NETWORK_MAX_IN_FLIGHT`); past
either, the answer is a 503 or 429 with `Retry-After: 5`. Requests with an
API key the SheetRender API has not yet accepted get all three bounds, with
tool calls counted toward the 600 as well; once the key is accepted they
count only toward the overall in-flight cap, and their batches may carry 20
messages.

A request carrying a SheetRender bearer key uses the API-key tools above.
The stdio server never offers the anonymous tools.

### OAuth account tools

With OAuth enabled, keyless and OAuth callers see the same three built-in
tools plus these account tools. Every account tool declares an `oauth2`
security scheme; built-in tools declare `noauth`.

| Scope | Account tools |
| --- | --- |
| `profile` | `get_profile` — account UUID, name and email (possibly null); marked `openai/profile`. |
| `render` | `list_templates`, `render_template`, `create_dataset`, `list_datasets`. |
| `design` | `design_template`, `get_design`. |
| `jobs` | `create_batch_job`, `get_job`, `get_document`, `create_schedule`, `list_schedules`. |

Protected calls without an active token receive HTTP 401 before the MCP SDK,
with `WWW-Authenticate: Bearer resource_metadata="<MCP origin>/.well-known/oauth-protected-resource/mcp", scope="profile render design jobs", error="invalid_token", error_description="Requires a signed-in SheetRender account."`.
Tokens missing a tool's scope receive HTTP 403 with `error="insufficient_scope"`
and that scope. Both challenges include an `error_description`. ChatGPT callers
receive the corresponding HTTP 200 tool error with `_meta["mcp/www_authenticate"]`
instead. `openai/*` request metadata and User-Agent select this response format
only; they grant no access or limits.

The resource documents at `/.well-known/oauth-protected-resource/mcp` and
`/.well-known/oauth-protected-resource` name the configured issuer and exact
`MCP_PUBLIC_URL`, with all four scopes and header-only bearer authentication.

An `sro_` prefix proves nothing. A token's first small account-tool call is admitted
under the same 2 MB, four-message and network bounds as an unconfirmed API
key, then checked at `POST /api/oauth/introspect`. Only `active: true` with
the exact MCP audience, a future expiry and access-token type lifts those
bounds for subsequent requests. Positive results last up to 60 seconds
(never past token expiry), inactive results 5 seconds; concurrent checks
of one token share a request. API success does not extend this OAuth cache.
Network errors, invalid introspection responses and upstream failures return
HTTP 503 with `Retry-After: 5`; expired cached results are never reused.
Discovery and built-in tools do not require introspection and remain usable
during sign-in outages. All callers remain subject to the global and
large-body in-flight limits.

**Built-in tools always use the demo account**, including calls carrying an
active OAuth token. Their row caps, subject/network buckets, document volume,
widget and continue link retain Phase 1 behavior. Sign-in enables account
tools; it does not change a built-in tool into an account render.

`create_schedule` accepts `template_id`, `dataset_id` (same project), and
`cadence` (`every_15_min`, `hourly`, `daily`, `weekly`, `monthly`). Optional
fields are `name` (200 characters), `hour_utc` (0–23, default 9), `weekday`
(Monday 0 to Sunday 6, default Monday), `day_of_month` (1–31, default creation
day, clamped in shorter months), and `delivery_email` (one recipient, up to
320 characters). Hour is ignored for hourly and quarter-hour cadences.
The tool creates an enabled schedule and returns its next run time.
`list_schedules` returns schedule details and enabled/paused state.
Both use `/api/v1/schedules`; neither exposes trigger credentials. Per-row
email and Drive delivery are outside this public API.

### Running it yourself

`sheetrender-mcp-http` is a second bin in the package. It reads `PORT`
(default 8080), `HOST` (default `0.0.0.0`), `SHEETRENDER_API_URL`,
`MAX_BODY_BYTES` and `IDLE_TIMEOUT_MS` (default 60000), and logs one JSON
line per request to stdout — method, path, status, duration, the JSON-RPC
method and tool name, a fingerprint of the credential (never the credential),
and `key_verified`, whether that credential had already been accepted at
admission (by the API for keys, or by cached introspection for OAuth tokens).

For the anonymous tools, and the request bounds above (which also apply to
keyed requests when no demo key is set), it also reads:

| Variable | |
| --- | --- |
| `SHEETRENDER_DEMO_API_KEY` | The dedicated rendering account's `sr_` key, needed to run the built-in document tools. With OAuth off and this unset, keyless requests get a 401. |
| `MCP_PUBLIC_URL` | The URL users paste, byte for byte, e.g. `https://mcp.sheetrender.com/mcp`. Sets the view's sandbox origin (Claude hashes this exact string). |
| `OAUTH_ISSUER` | Authorization server origin: `https://sheetrender.com` in production or `https://staging.sheetrender.com` in staging. No inferred host or default. |
| `MCP_INTROSPECT_SECRET` | Shared secret for the backend's introspection endpoint. Must match the backend setting; sent only to that endpoint as a Bearer credential. |
| `OPENAI_APPS_CHALLENGE` | OpenAI's domain-verification token, served as plain text at `GET /.well-known/openai-apps-challenge` (404 when unset). |
| `ANON_CALLS_PER_HOUR` | Render and continue calls per subject or IP per hour, default 30. |
| `ANON_NETWORK_CALLS_PER_HOUR` | Render and continue calls per hour per IPv4 /24 or IPv6 /48, for callers counted by IP, default 300. |
| `CLAUDE_CALLS_PER_HOUR` | Shared render and continue calls per hour for all traffic from `160.79.104.0/21`, default 3000. |
| `ANON_RPC_PER_HOUR` | Anonymous messages other than tool calls, plus every message sent with a key the API has not yet accepted, per hour per IPv4 /24 or IPv6 /48, outside the OpenAI and Claude ranges, default 600. |
| `ANON_MAX_IN_FLIGHT` | Requests answered at once, all callers together (with a key or without), default 64. |
| `ANON_NETWORK_MAX_IN_FLIGHT` | Anonymous requests, and requests with a key the API has not yet accepted, answered at once per IPv4 /24 or IPv6 /48, outside the OpenAI and Claude ranges, default 8. |
| `LARGE_BODY_MAX_IN_FLIGHT` | Requests with a body over 2 MB handled at once, server-wide, default 1. Requires a key the API accepted or a cached active OAuth token. |
| `OPENAI_EGRESS_CIDRS` | Comma- or space-separated CIDRs whose `openai/subject` is believed, replacing both the built-in copy and the live fetch of [chatgpt-connectors.json](https://openai.com/chatgpt-connectors.json); `none` believes no subject. |

OAuth is enabled only when both `OAUTH_ISSUER` and `MCP_INTROSPECT_SECRET` are
set. Enabling it also requires `MCP_PUBLIC_URL`. If either OAuth setting is
unset, resource metadata returns 404 and the v0.5.3 authentication and tool
selection behavior is retained: keyless callers get only demo tools when a
demo key is set, malformed Authorization is rejected, and API keys select
the legacy tools. OAuth does not require a demo key for discovery or account
tools, but built-in renders need the separately configured demo credential.
The reverse proxy must route both protected-resource metadata paths to this
server. Deployment must pass the new issuer variable as well as the shared
secret to the MCP process.

With `SHEETRENDER_DEMO_API_KEY` set or OAuth enabled, the server refuses to start if the view
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
