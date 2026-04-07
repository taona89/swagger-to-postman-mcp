# Swagger-to-Postman MCP Server – Summary

## What It Does

Generates Postman test collections (positive + negative), environments, BDD feature files, HTML reports, and tech specs from OpenAPI/Swagger specifications — exposed as MCP tools for AI clients.

## Available Tools

| Tool | Description |
|------|-------------|
| `list_swagger_files` | List specs in the `swagger/` directory |
| `analyze_openapi` | Inspect spec structure without generating files |
| `validate_spec` | Validate a spec before generating tests |
| `generate_tests` | Generate full test suite (collections, environment, report) |
| `verify_collection` | Check variable completeness, script syntax, and coverage |
| `generate_bdd` | Generate Gherkin `.feature` files |

## How to Run

```bash
npm install
node index.js
```

## How to Test (MCP Inspector)

```bash
npx @modelcontextprotocol/inspector node index.js
```

Opens a browser UI to call tools interactively without needing a full MCP client.

## Connect to Claude Desktop

`%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "swagger-to-postman": {
      "command": "node",
      "args": ["/path/to/swagger-to-postman-mcp/index.js"]
    }
  }
}
```

## Output Files (after `generate_tests`)

| File | Description |
|------|-------------|
| `*_Positive.postman_collection.json` | Happy-path test collection |
| `*_Negative.postman_collection.json` | Error/edge case test collection |
| `*_environment.json` | Postman environment variables |
| `*_TechSpec.md` | Technical specification |
| `*_Report.html` | HTML coverage report |
| `*_BDD.feature` | Gherkin BDD scenarios |

## Run Collections with Newman

```bash
npx newman run generated/MyAPI_Positive.postman_collection.json \
  -e generated/MyAPI_environment.json
```
