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

## Tools

(Documented with v0.1.0.)

## Development

No host node/npm needed — `scripts/dev.sh install`, `scripts/dev.sh deno task build`.

MIT licensed.
