# How to Run the Swagger-to-Postman MCP Server

## Prerequisites

- **Node.js** >= 18.0.0
- An MCP-compatible client (Claude Desktop, VS Code with MCP extension, etc.)

## Installation

```bash
cd swagger-to-postman-mcp
npm install
```

## Running the Server

### Option 1: Direct execution

```bash
node index.js
```

### Option 2: npm script

```bash
npm start
```

### Option 3: Watch mode (auto-restart on file changes)

```bash
npm run dev
```

The server communicates over **stdio** (standard input/output). You will not see a running prompt — this is expected. The server waits for MCP protocol messages.

### Option 4: Test with MCP Inspector (browser UI)

```bash
npx @modelcontextprotocol/inspector node index.js
```

This opens a browser-based UI where you can call each tool interactively and inspect responses — useful for testing without a full MCP client.

---

## Connecting via Claude Desktop

Add the server to your Claude Desktop config file:

**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

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

Restart Claude Desktop after saving. The tools will appear automatically.

---

## Connecting via Claude Code (CLI)

```bash
claude mcp add swagger-to-postman node /full/path/to/swagger-to-postman-mcp/index.js
```

Or add it to your project's `.mcp.json`:

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

---

## Available Tools

| Tool | Description |
|------|-------------|
| `list_swagger_files` | List OpenAPI/Swagger specs in the `swagger/` directory |
| `analyze_openapi` | Parse a spec and inspect its structure (no file output) |
| `validate_spec` | Validate an OpenAPI spec before generating tests |
| `generate_tests` | Generate full Postman test suite (positive + negative + environment + report) |
| `verify_collection` | Check variable completeness, test script syntax, and coverage |
| `generate_bdd` | Generate BDD Gherkin `.feature` files from an OpenAPI spec |

---

## Usage Examples

### 1. List available specs

Ask your AI client:
> "List the swagger files available"

### 2. Validate a spec

> "Validate the spec at `./swagger/my-api.yaml`"

### 3. Generate tests

> "Generate tests from `./swagger/my-api.yaml` and save to `./output`"

With custom variables:
> "Generate tests from `./swagger/my-api.yaml` with variables `{"baseUrl": "https://api.example.com", "username": "admin"}`"

Reusing an existing environment file:
> "Generate tests from `./swagger/my-api.yaml` reusing values from `./generated/MyAPI_environment.json`"

### 4. Generate BDD feature files

> "Generate BDD tests from `./swagger/my-api.yaml`"

### 5. Verify a collection

> "Verify `./generated/MyAPI_Positive.postman_collection.json` against `./generated/MyAPI_environment.json`"

---

## Running Generated Collections with Newman

After generating tests, run them headlessly with Newman:

```bash
# Install Newman (already in devDependencies)
npm install

# Run positive tests
npx newman run generated/MyAPI_Positive.postman_collection.json \
  -e generated/MyAPI_environment.json

# Run negative tests
npx newman run generated/MyAPI_Negative.postman_collection.json \
  -e generated/MyAPI_environment.json

# Run with HTML report
npx newman run generated/MyAPI_Positive.postman_collection.json \
  -e generated/MyAPI_environment.json \
  -r htmlextra --reporter-htmlextra-export results.html

# Run with iteration data file
npx newman run generated/MyAPI_Positive.postman_collection.json \
  -e generated/MyAPI_environment.json \
  --iteration-data generated/MyAPI_iteration_data.json
```

---

## Project Structure

```
swagger-to-postman-mcp/
├── index.js              # MCP server entry point
├── generate.js           # Core generation utilities
├── swagger/              # Place your OpenAPI specs here (.yaml, .json, .txt)
├── generated/            # Output directory for generated files
└── src/
    ├── parsers/          # OpenAPI spec parsers
    ├── generators/       # Collection, BDD, HTML, data file generators
    ├── validators/       # Variable, coverage, script checkers
    └── utils/            # Shared utilities
```

---

## Supported Spec Formats

- OpenAPI 3.x (`.yaml`, `.json`)
- Swagger 2.x (`.yaml`, `.json`)
- Plain text files (`.txt`) — the server will auto-detect and extract the spec

## Troubleshooting

**Server exits immediately:** This is correct behavior — the MCP server only runs while a client is connected via stdio.

**`swagger/` directory not found:** Create it and place your spec files inside before calling `list_swagger_files`.

**`Error: Cannot find module`:** Run `npm install` to install dependencies.
