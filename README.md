# mcp-cnpj-br

CNPJ Brazil MCP — Brazilian company-registry (Receita Federal) lookup via

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1306+ live data sources.

## Tools

| Tool | Description |
|------|-------------|

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "cnpj-br": {
      "url": "https://gateway.pipeworx.io/cnpj-br/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 1306+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Cnpj Br data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [All tools and guides](https://github.com/pipeworx-io/examples)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
