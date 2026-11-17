# How to Run

## Prerequisites

- Node.js 22 or newer
- `npm ci` in the project directory

## MCP server

The server speaks MCP over stdio; it waits silently for a client.

```bash
npm start                                          # node index.js
npx @modelcontextprotocol/inspector node index.js  # browser UI for manual tool calls
```

### Claude Code

```bash
claude mcp add swagger-to-postman -- node /full/path/to/swagger-to-postman-mcp/index.js
```

or in a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "swagger-to-postman": {
      "command": "node",
      "args": ["/full/path/to/swagger-to-postman-mcp/index.js"]
    }
  }
}
```

### Claude Desktop

`%APPDATA%\Claude\claude_desktop_config.json` (Windows) or
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "swagger-to-postman": {
      "command": "node",
      "args": ["C:\\full\\path\\to\\swagger-to-postman-mcp\\index.js"],
      "env": { "SWAGGER_MCP_ALLOWED_DIRS": "C:\\specs;C:\\work\\api-tests" }
    }
  }
}
```

### Which files can the server touch?

Only files inside the allowed roots:

1. the roots your MCP client exposes (usually the open workspace),
2. this project directory (bundled `swagger/` specs, default `generated/` output),
3. directories listed in `SWAGGER_MCP_ALLOWED_DIRS`.

Relative paths resolve against the first root. `generate_tests` and
`generate_bdd` refuse to overwrite existing files unless called with
`overwrite: true`.

### Example prompts

> "Validate swagger/restful_booker.json"
> "Generate tests from ./specs/orders.yaml into ./api-tests with a CSV data file"
> "Verify ./api-tests/Orders_API_Positive.postman_collection.json against ./api-tests/Orders_API_environment.json"

## CLI

```bash
node generate.js <spec> [output-dir] [--data-file csv|json] [--row-count n] \
  [--variables '<json>'|file.json] [--env-file env.json] [--response-time ms] [--bdd] [--no-overwrite]
```

## Running the generated suites

```bash
npx newman run generated/<API>_Positive.postman_collection.json -e generated/<API>_environment.json
npx newman run generated/<API>_Negative.postman_collection.json -e generated/<API>_environment.json

# data-driven
npx newman run generated/<API>_Positive.postman_collection.json -e generated/<API>_environment.json \
  --iteration-data generated/<API>_iteration_data.csv

# HTML report
npx newman run generated/<API>_Positive.postman_collection.json -e generated/<API>_environment.json \
  -r cli,htmlextra --reporter-htmlextra-export results.html
```

Set `baseUrl` and credentials in the environment file first. Use Newman 6.1+
(or a current Postman app): the data-safety guard relies on
`pm.execution.skipRequest()` and fails closed on older runners. Collection
variables you can override from the environment:

| Variable | Default | Meaning |
|----------|---------|---------|
| `responseTimeThresholdMs` | `5000` | Performance assertion threshold |
| `allowMutationOfExistingData` | `false` | Let requests modify records the run did not create (incl. collection-level deletes) |

## Troubleshooting

- **`Access denied: ... outside the allowed directories`**: add the directory to
  `SWAGGER_MCP_ALLOWED_DIRS` or open it as a workspace root in your client.
- **`Refusing to overwrite existing files`**: pass `overwrite: true` or pick another output directory.
- **`[SKIPPED]` lines in Newman output**: a request's prerequisite (a captured id,
  or a resource created by this run) was missing; the line says which.
- **`Unable to resolve $ref pointer`**: external `$ref`s must be files inside the
  spec's folder; `http(s)` refs are not fetched.
