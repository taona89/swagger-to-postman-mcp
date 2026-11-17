# Swagger-to-Postman MCP Server – Summary

Generates runnable Postman suites from OpenAPI 3.0/3.1 and Swagger 2.0 specs and
exposes them as MCP tools.

| Tool | Writes | Description |
|------|:---:|-------------|
| `list_swagger_files` | no | Specs in `swagger/` |
| `analyze_openapi` | no | Operations, parameters, auth schemes |
| `validate_spec` | no | Schema validation |
| `generate_tests` | yes | Positive + negative collections, environment, data file, docs |
| `verify_collection` | no | Script syntax and risky APIs, variable resolution, coverage |
| `generate_bdd` | yes | Gherkin feature files |

```bash
npm ci
npm start      # MCP server on stdio
npm test       # unit, CLI, MCP protocol and Newman end-to-end tests
```

See [README.md](README.md) for behaviour, security model and limitations, and
[HOW_TO_RUN.md](HOW_TO_RUN.md) for client setup.
