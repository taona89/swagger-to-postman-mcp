# swagger-to-postman-mcp

![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)
![MCP](https://img.shields.io/badge/MCP-Model%20Context%20Protocol-blueviolet)
![OpenAPI](https://img.shields.io/badge/OpenAPI-3.0%20%7C%203.1%20%7C%20Swagger%202.0-85EA2D?logo=swagger&logoColor=white)

> An MCP server and CLI that turn an OpenAPI / Swagger spec into runnable Postman
> suites: positive tests with response-schema contract checks, negative tests with
> one fault per request, a Postman environment, optional data-driven iteration
> files, BDD scenarios, a tech spec and an HTML summary.

The generated suites are verified in this repo's own test suite: they are run
with Newman against a spec-compliant mock API and must pass with zero failures,
must leave the API's existing data untouched, and must **fail** when the mock is
switched into one of several deliberately broken modes (wrong types accepted,
response contract broken, auth not enforced, ...).

---

## What gets generated

| Output | Contents |
|--------|----------|
| `*_Positive.postman_collection.json` | One request per operation. Status code asserted against **all documented 2xx codes**; JSON body validated with `pm.response.to.have.jsonSchema()` against the documented schema; response-time threshold. CRUD chaining: create → read → update → delete on the resource the run created. |
| `*_Negative.postman_collection.json` | Per operation: missing required field (each, except readOnly), wrong type (each property, up to 25 per operation), empty string (only where the schema forbids it), malformed JSON, invalid id format, non-existent id (only when a guaranteed-unused id exists), no credentials (only where auth is required). Disposable test data is created in setup and deleted in teardown. |
| `*_environment.json` | `baseUrl`, credentials (marked `secret`), and values for path parameters that cannot be chained. |
| `*_iteration_data.{csv,json}` | Optional. Rows for every request-body field, in columns named `body.<field>` (nested fields as `body.a.b`, so they never shadow variables like `{{username}}`); the positive suite becomes data-driven and restores JSON types. |
| `*_BDD.feature` | Optional. Gherkin scenarios using the same status oracles as the Postman suites (specification-level, no step definitions). |
| `*_TechSpec.md`, `*_Report.html`, `*_README.md` | Documentation, HTML summary with coverage and spec gaps, run instructions. |

### How the tests decide pass/fail

- **Positive status:** any status code the spec documents as 2xx for that operation.
- **Negative status:** the codes that are correct for the scenario, intersected with
  the codes the spec documents:

  | Scenario | Acceptable codes |
  |----------|-----------------|
  | missing field / wrong type / empty value | 400, 422 |
  | malformed JSON | 400 |
  | invalid id format | 400, 404, 422 |
  | non-existent id | 404, 410 |
  | no credentials | 401, 403 |

  If the spec documents none of them, the conventional codes are asserted and the
  operation is listed as a **spec gap** (tool result, README, HTML report).
- **Contract:** the documented schema of whichever status code came back, converted
  to a JSON Schema the Postman sandbox (Ajv 6) accepts (`nullable`, boolean
  `exclusiveMinimum`, OpenAPI-only formats and keywords handled).

### Data safety

- Every request that can modify existing data (PUT, PATCH, DELETE, and POST to a
  path with a parameter such as `/orders/{id}/cancel`) only runs when **every
  resource in its path was created by the same run**, and the id actually used is
  the captured one (an environment value of the same name does not count).
  Collection-level updates/deletes (`DELETE /todos`) and paths whose values come
  from the environment never qualify. Guarded requests are skipped with a
  `[SKIPPED]` log line and listed as warnings at generation time. Set the
  collection variable `allowMutationOfExistingData=true` to opt out.
- The guard uses `pm.execution.skipRequest()` (Newman 6.1+, current Postman app).
  On older runners it fails closed: headers, auth and body are stripped and the
  request is sent to the loopback discard port instead of the API.
- The first request of each run clears captured ids, so stale ids from an earlier
  run are never reused.
- Optional query parameters are included but disabled, so they never filter results
  by accident.

---

## Install

```bash
git clone https://github.com/taona89/swagger-to-postman-mcp.git
cd swagger-to-postman-mcp
npm ci
```

Requires Node.js 22 or newer.

## Use as an MCP server

Claude Code:

```bash
claude mcp add swagger-to-postman -- node /absolute/path/to/swagger-to-postman-mcp/index.js
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "swagger-to-postman": {
      "command": "node",
      "args": ["/absolute/path/to/swagger-to-postman-mcp/index.js"],
      "env": { "SWAGGER_MCP_ALLOWED_DIRS": "/absolute/path/to/your/specs" }
    }
  }
}
```

Try it without a client: `npx @modelcontextprotocol/inspector node index.js`

### Tools

| Tool | Writes files | Description |
|------|:---:|-------------|
| `list_swagger_files` | no | Specs in this repo's `swagger/` directory |
| `analyze_openapi` | no | Operations, parameters, auth schemes |
| `validate_spec` | no | Schema validation (OpenAPI 3.0/3.1, Swagger 2.0) |
| `generate_tests` | yes | Full suite; see parameters below |
| `verify_collection` | no | Script syntax, risky script APIs (`pm.sendRequest`, `eval`...), variable resolution, coverage |
| `generate_bdd` | yes | Gherkin feature file(s) |

All tools declare MCP annotations (`readOnlyHint`, `destructiveHint`) and an
`outputSchema`; results are returned as `structuredContent`.

`generate_tests` parameters: `spec_path` (required), `output_dir`,
`generate_data_file`, `data_format` (`csv`|`json`), `row_count`, `variables`
(object of environment overrides), `env_file`, `overwrite` (default **false**),
`response_time_ms`.

### Security model

Tool arguments are chosen by a language model, which can be influenced by text
inside the specs it reads. The server therefore:

- only reads and writes inside **allowed roots**: the client's MCP roots, this
  project directory, and the directories in `SWAGGER_MCP_ALLOWED_DIRS`
  (separated by `;` on Windows, `:` elsewhere). Paths are checked lexically
  first (so UNC paths never trigger network lookups), then again after
  resolving symlinks and junctions. Relative paths resolve against the first
  root (the client's workspace when it provides roots).
- never writes from read-only tools (partial `.txt` specs are wrapped in memory);
- refuses to overwrite existing files unless `overwrite: true`, and never writes
  through a symbolic link;
- never fetches `http(s)` `$ref`s and follows file `$ref`s only inside the spec's
  folder (also after resolving symlinks);
- embeds spec text in generated scripts only as JSON literals (never in comments),
  HTML-escapes it in reports and keeps Markdown output to one line per field, so a
  hostile spec cannot inject code; the CLI exits with code 2 if a generated script
  fails to compile or uses `pm.sendRequest`, `eval` or similar;
- marks text copied from the spec as untrusted in tool results.

Pass credentials through `env_file` rather than `variables`, so they do not
appear in the conversation.

## Use as a CLI

```bash
node generate.js swagger/restful_booker.json ./generated
node generate.js ./api.yaml ./out --data-file csv --row-count 5 --bdd
node generate.js ./api.yaml ./out --variables '{"baseUrl":"https://staging.example.com"}'
node generate.js ./api.yaml ./out --env-file ./existing_environment.json --no-overwrite
```

Re-running into the same directory keeps values you already put in the
environment file. Then:

```bash
npx newman run generated/Restful_Booker_Positive.postman_collection.json -e generated/Restful_Booker_environment.json
npx newman run generated/Restful_Booker_Negative.postman_collection.json -e generated/Restful_Booker_environment.json
```

---

## Project structure

```
index.js                     MCP server (tools, path policy, structured results)
generate.js                  CLI
src/core/                    shared logic
  suite.js                   generateSuite()/generateBdd(): used by CLI and MCP
  schema.js                  example generation, OpenAPI → Ajv 6 JSON Schema, cycle-safe
  endpoints.js               CRUD classification and status-code oracles
  auth.js                    auth endpoint detection, per-operation security
  plan.js                    request chaining (which variable feeds which path parameter)
  request.js                 Postman request/URL/body builders
  environment.js             environment builder, variable scanning
  paths.js                   allowed-roots file access policy
  escape.js                  JS / HTML / Markdown / Gherkin escaping
src/parsers/openapi-parser.js  @apidevtools/swagger-parser + Swagger 2.0 normalization
src/generators/              positive, negative, data file, BDD, tech spec, HTML, README
src/validators/              variable, coverage and script checkers
test/                        unit, CLI, MCP-protocol and Newman integration tests
test/fixtures/restful-booker-mock.js  spec-compliant mock with switchable defects
```

## Development

```bash
npm test        # node:test: unit, CLI, MCP protocol and Newman end-to-end tests
npm run lint    # ESLint
```

CI runs lint and tests on Ubuntu, Windows and macOS with Node 22 and 24.

## Known limitations

- BDD output is specification-level Gherkin; no step definitions are generated.
- If a broken API wrongly accepts an invalid POST from the negative suite, the
  record it creates is not cleaned up (the test still fails).
- Resources created by the suites are only deleted when the spec has a DELETE for
  them (generation warns otherwise).
- Non-JSON, non-form request bodies (XML, plain text) are sent as the spec's
  example text, without field-level negative tests.
- POST "actions" on a collection path without a parameter (e.g.
  `POST /orders/bulk-delete`, `POST /admin/reset`) look like creates and are not
  guarded. Review such operations before running the positive suite against
  shared data.
- Path parameters whose collection has no create or list endpoint are read from
  the environment; update/delete on those resources are skipped unless
  `allowMutationOfExistingData=true`.
- Examples use the first `oneOf`/`anyOf` branch; field-level negative tests cover
  JSON object bodies only.
- Formats the Postman sandbox does not know (e.g. `int32`, `byte`) are not
  enforced by the contract checks.

## License

MIT
