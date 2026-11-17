# Changelog

## 2.0.0

Breaking changes are marked **(breaking)**.

### Test correctness
- `$ref`s are now dereferenced (`@apidevtools/swagger-parser`); contract checks and
  field-level negative tests work for specs that use components.
- Swagger 2.0 body/formData parameters, response schemas, `definitions` and
  `securityDefinitions` are normalized; OpenAPI 3.1 is supported.
- Contract checks validate the full documented schema with
  `pm.response.to.have.jsonSchema()` instead of property-presence checks.
- Positive status assertions accept every documented 2xx code.
- CRUD chaining: created ids are captured from the response schema's id field (or
  `Location`); read/update/delete use them. Update/delete never touch records the
  run did not create (opt-out: `allowMutationOfExistingData`). **(breaking: path
  variables are now named after their collection, e.g. `booking_id`)**
- Negative tests change exactly one thing per request and use a disposable resource
  created in setup and deleted in teardown. Status oracles combine HTTP semantics
  with documented codes; gaps are reported as spec gaps.
- "No credentials" tests respect per-operation security (`security: []`), and
  disable the cookie jar.
- API-key auth uses the scheme's real header/query/cookie name; HTTP basic,
  bearer, OAuth2 and API keys in query or cookie are supported.
- Data-driven bodies restore JSON types and nested objects; CSV files no longer
  start with a comment line; iteration data never overrides chained ids.
- Optional query parameters are disabled by default.
- BDD scenarios use the same oracles as the Postman suites.

### Security
- Script injection from spec content is no longer possible (JSON-literal embedding,
  U+2028/U+2029 escaped, no spec text in comments; `__proto__` keys preserved).
- Data-safety guard covers every request that can modify existing data, checks
  that the captured id is the one in use, and fails closed on old runners.
- Path policy rejects paths lexically before any filesystem access (no UNC/SMB
  lookups); output is never written through symlinks; `$ref` resolution re-checks
  real paths.
- Markdown outputs keep spec fields on one line; the curl example is shell-quoted.
- HTML report escapes all spec content and sets a restrictive CSP.
- MCP file access is limited to allowed roots (MCP roots, project dir,
  `SWAGGER_MCP_ALLOWED_DIRS`). **(breaking)**
- Read-only tools never write; `.txt` partial specs are wrapped in memory.
- Generation refuses to overwrite unless `overwrite: true`. **(breaking for MCP)**
- External `$ref`s: no HTTP fetching; file refs only inside the spec's folder.
- `verify_collection` warns about `pm.sendRequest`, `eval` and similar APIs.
- Credentials are marked as `secret` in environments; tokens are no longer logged.

### MCP server
- `registerTool` with titles, annotations, output schemas and `structuredContent`.
- Result shapes changed **(breaking)**: `analyze_openapi` returns `requestBody`
  (content type or null) instead of `hasRequestBody` and no longer returns the
  spec description; `validate_spec` returns `errors: string[]` instead of `error`
  and no longer returns `info.endpoints`; `generate_tests` returns
  `stats.positiveRequests/negativeRequests`, `specGaps` and `warnings`.
- Iteration-data columns are named `body.<field>` **(breaking)**.
- `variables` accepts an object (a JSON string still works).
- `validate_spec` performs real schema validation.
- Default output directory no longer depends on the server's working directory.
- Version read from `package.json`.

### Engineering
- Shared `generateSuite()` service used by CLI and MCP (removed duplicated, drifting logic).
- CLI works on Linux/macOS (entry-point check removed); flags may precede arguments.
- Test suite (`node:test`): unit, CLI, MCP protocol, and Newman runs against a
  spec-compliant mock with fault injection. ESLint. CI on Ubuntu/Windows/macOS × Node 22/24.
- Removed product-specific leftovers and dead code; replaced deprecated
  `swagger-parser` and `uuid`; declared `zod` explicitly; Node ≥ 22.
