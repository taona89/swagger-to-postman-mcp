# swagger-to-postman-mcp
MCP that generates production-ready Postman test suites (positive, negative, BDD, data-driven) from OpenAPI/Swagger specifications


# swagger-to-postman-mcp

![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)
![MCP](https://img.shields.io/badge/MCP-Model%20Context%20Protocol-blueviolet)
![OpenAPI](https://img.shields.io/badge/OpenAPI-3.0%20%7C%20Swagger%202.0-85EA2D?logo=swagger&logoColor=white)
![Postman](https://img.shields.io/badge/Postman-Collections-FF6C37?logo=postman&logoColor=white)

> **An MCP server that turns any OpenAPI/Swagger spec into a full Postman test suite in seconds** — positive tests, negative tests, BDD scenarios, data-driven iteration files, HTML reports, and documentation. No manual test writing required.

---

## Why This Exists

Writing Postman collections by hand is slow, inconsistent, and error-prone. This tool reads your API contract (OpenAPI/Swagger) and automatically generates production-ready test suites that cover happy paths, error cases, contract validation, and edge cases — all wired up with proper assertions, authentication, and environment variables.

It ships as both a **CLI tool** and an **MCP server**, so it works standalone or directly inside AI clients like Claude Desktop.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Input                                    │
│         OpenAPI 3.0 / Swagger 2.0 (.yaml .json .txt)       │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                  OpenAPI Parser                             │
│   Resolves $ref · Extracts endpoints, schemas, auth        │
│   Handles allOf / oneOf / anyOf composition                │
└──────┬────────────┬──────────────┬───────────┬─────────────┘
       │            │              │           │
       ▼            ▼              ▼           ▼
┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐
│ Positive │ │ Negative │ │   BDD    │ │  Data File   │
│Generator │ │Generator │ │Generator │ │  Generator   │
│          │ │          │ │          │ │ (CSV / JSON) │
└────┬─────┘ └────┬─────┘ └────┬─────┘ └──────┬───────┘
     │            │             │              │
     └────────────┴─────────────┴──────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                   Validators                                │
│      Variable completeness · Coverage % · Script syntax    │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                    Output                                   │
│  *_Positive.json  *_Negative.json  *_environment.json      │
│  *_BDD.feature    *_TechSpec.md    *_Report.html           │
│  *_iteration_data.json/.csv                                │
└─────────────────────────────────────────────────────────────┘
```

---

## Features

| Feature | Details |
|---------|---------|
| **CRUD Detection** | Automatically categorizes endpoints into Create / Read / Update / Delete / List |
| **Positive Tests** | Status codes, response time, payload validation, contract assertions |
| **Negative Tests** | Missing fields, empty values, invalid types, malformed JSON, invalid IDs, no auth |
| **Contract Testing** | Schema validation against OpenAPI response definitions |
| **BDD Generation** | Gherkin `.feature` files with `@positive`, `@negative`, `@contract` tags |
| **Data-Driven Tests** | CSV/JSON iteration files for Newman `--iteration-data` with smart value generation |
| **$ref Resolution** | Resolves `$ref`, `allOf`, `oneOf`, `anyOf` for nested schema extraction |
| **Auth Handling** | Cookie-based auth, bearer tokens, API keys |
| **Environment Files** | Ready-to-use Postman environment with smart example values |
| **Variable Injection** | Override or pre-fill env variables at generation time |
| **Post-Generation Checks** | Variable completeness, endpoint coverage %, script syntax validation |
| **HTML Reports** | Visual summary of generated suite — importable into Postman |

---

## Demo

### CLI — Generate from an OpenAPI spec

```bash
node generate.js swagger/my-api.yaml generated --data-file json --row-count 5 --bdd
```

```
✅ Parsed: My API v1.0.0 — 24 endpoints
[1/4] Generating positive test collection...   ✅ My_API_Positive.postman_collection.json
[2/4] Generating negative test collection...   ✅ My_API_Negative.postman_collection.json
[3/4] Generating environment file...           ✅ My_API_environment.json (18 variables)
[4/4] Generating documentation...              ✅ My_API_TechSpec.md

VERIFICATION
✅ 16/18 variables resolved
✅ 24/24 endpoints covered in positive tests (100%)
✅ 29/29 test scripts have valid syntax
```

### Run data-driven tests with Newman

```bash
npx newman run generated/My_API_Positive.postman_collection.json \
  -e generated/My_API_environment.json \
  --iteration-data generated/My_API_iteration_data.json \
  --reporters cli,htmlextra \
  --reporter-htmlextra-export results.html
```

---

## Installation

```bash
git clone https://github.com/your-username/swagger-to-postman-mcp.git
cd swagger-to-postman-mcp
npm install
```

**Requirements:** Node.js >= 18.0.0

---

## Usage

### Option 1 — CLI

```bash
# Basic generation
node generate.js swagger/my-api.yaml generated

# With data-driven iteration file (JSON or CSV)
node generate.js swagger/my-api.yaml generated --data-file json --row-count 5

# With BDD feature files
node generate.js swagger/my-api.yaml generated --bdd

# Inject custom variables
node generate.js swagger/my-api.yaml generated --variables '{"baseUrl":"https://staging.example.com"}'

# Reuse values from an existing environment file
node generate.js swagger/my-api.yaml generated --env-file ./existing_environment.json
```

### Option 2 — MCP Server (Claude Desktop / Claude Code)

Start the server:

```bash
node index.js
```

Add to Claude Desktop (`%APPDATA%\Claude\claude_desktop_config.json` on Windows, `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

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

Then ask Claude:

> "Generate the full test suite from `swagger/my-api.yaml`"
> "Generate BDD feature files from `swagger/my-api.yaml`"
> "Verify the collection at `generated/My_API_Positive.postman_collection.json`"

### Option 3 — MCP Inspector (browser UI, no client needed)

```bash
npx @modelcontextprotocol/inspector node index.js
```

---

## MCP Tools

| Tool | Description |
|------|-------------|
| `list_swagger_files` | List all OpenAPI specs in the `swagger/` directory |
| `analyze_openapi` | Parse and inspect a spec without generating files |
| `validate_spec` | Validate a spec before generation |
| `generate_tests` | Generate full test suite — positive, negative, environment, report, data file |
| `verify_collection` | Check variable completeness, script syntax, and endpoint coverage |
| `generate_bdd` | Generate Gherkin `.feature` files |

### `generate_tests` parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `spec_path` | string | required | Path to OpenAPI/Swagger file |
| `output_dir` | string | `./generated` | Output directory |
| `generate_data_file` | boolean | false | Generate Newman iteration data file |
| `data_format` | `csv` \| `json` | `json` | Data file format |
| `row_count` | integer | 3 | Number of data rows to generate |
| `variables` | string (JSON) | — | Custom variables to inject into environment |
| `env_file` | string | — | Existing environment file to reuse values from |

---

## Generated Output

```
generated/
├── My_API_Positive.postman_collection.json   # Happy-path CRUD tests
├── My_API_Negative.postman_collection.json   # Error / edge case tests
├── My_API_environment.json                   # Postman environment variables
├── My_API_TechSpec.md                        # Full API technical specification
├── My_API_Report.html                        # Visual HTML summary
├── My_API_BDD.feature                        # Gherkin scenarios (with --bdd)
└── My_API_iteration_data.json                # Data-driven test rows (with --data-file)
```

### Positive Collection Structure

```
0. Authentication       → Login, store auth token/cookie
1. Setup               → Extract reference IDs for downstream tests
2. LIST Operations     → GET endpoints (no path params)
3. CREATE Operations   → POST endpoints
4. READ Operations     → GET endpoints with ID
5. UPDATE Operations   → PUT / PATCH endpoints
6. DELETE Operations   → DELETE endpoints
```

### Negative Collection Structure

```
Per writable endpoint:
  ├── Missing Required Field: [field]
  ├── Empty [field]
  ├── Invalid [field] Type
  ├── Malformed JSON Body
  ├── Invalid ID
  ├── Non-existent ID
  └── No Authentication
```

---

## Data-Driven Generation

The data file generator produces varied test rows by extracting all parameterizable fields from the spec:

- **Path parameters** — `GET /bookings/{id}`
- **Query parameters** — `GET /bookings?status=active`
- **Request body properties** — with full `$ref`, `allOf`, `oneOf`, `anyOf` resolution and nested object flattening

Value generation respects:
- `format` — `uuid`, `date`, `date-time`, `email`, `uri`
- `enum` — rotates through defined values
- `minimum` / `maximum` — for numeric fields
- `minLength` — pads strings to meet constraint
- `pattern` — surfaces `PATTERN:<regex>` placeholder
- `example` — uses spec-provided examples first
- Name heuristics — `email`, `status`, `role`, `priority`, `city`, `country`, etc.

```bash
# Generate 10 rows in CSV format
node generate.js swagger/my-api.yaml generated --data-file csv --row-count 10

# Run with Newman
npx newman run generated/My_API_Positive.postman_collection.json \
  -e generated/My_API_environment.json \
  --iteration-data generated/My_API_iteration_data.csv
```

---

## Project Structure

```
swagger-to-postman-mcp/
├── index.js                          # MCP server entry point
├── generate.js                       # CLI entry point
├── swagger/                          # Place your OpenAPI specs here
└── src/
    ├── parsers/
    │   └── openapi-parser.js         # OpenAPI 3.0 + Swagger 2.0 parser
    ├── generators/
    │   ├── positive-generator.js     # Positive test collection builder
    │   ├── negative-generator.js     # Negative test collection builder
    │   ├── test-script-generator.js  # Postman test assertion scripts
    │   ├── data-file-generator.js    # CSV/JSON iteration data generator
    │   ├── bdd-generator.js          # Gherkin BDD feature file generator
    │   ├── html-report-generator.js  # HTML report generator
    │   └── tech-spec-generator.js    # Markdown tech spec generator
    ├── validators/
    │   ├── variable-checker.js       # {{variable}} completeness check
    │   ├── coverage-checker.js       # Endpoint coverage %
    │   └── script-checker.js         # Test script syntax validation
    └── utils/
        └── openapi-wrapper.js        # Auto-wraps partial .txt specs
```

---

## Tech Stack

- **Runtime:** Node.js (ESM)
- **MCP Protocol:** `@modelcontextprotocol/sdk`
- **Spec Parsing:** `swagger-parser`, `js-yaml`
- **Test Running:** `newman`, `newman-reporter-htmlextra`
- **ID Generation:** `uuid`

---

## Contributing

1. Add new test patterns → `src/generators/test-script-generator.js`
2. Modify collection structure → `src/generators/positive-generator.js` / `negative-generator.js`
3. Add new output formats → create a generator in `src/generators/`
4. Add new validators → create a checker in `src/validators/`
5. Add new MCP tools → `index.js`

---

## License

MIT
