/**
 * README for a generated suite (same content for CLI and MCP).
 */
export function generateSuiteReadme({ apiSpec, files, dataFile, specGaps = [] }) {
  const data = dataFile ? ` \\\n  --iteration-data "${dataFile}"` : '';
  return `# ${apiSpec.info.title} - Test Suite

Generated from the OpenAPI specification (${apiSpec.specVersion}).

- **Version:** ${apiSpec.info.version}
- **Base URL:** ${apiSpec.baseUrl || '(not set in the spec - set baseUrl in the environment)'}
- **Operations:** ${apiSpec.endpoints.length}

## Files

| File | Purpose |
|------|---------|
| \`${files.positive}\` | Positive suite: documented success codes, schema contract checks, CRUD chaining |
| \`${files.negative}\` | Negative suite: one fault per request, status codes checked against the spec |
| \`${files.environment}\` | Environment (baseUrl, credentials, static path values) |
| \`${files.techSpec}\` | Technical specification |
| \`${files.report}\` | HTML summary |
${dataFile ? `| \`${dataFile}\` | Iteration data for the positive suite |\n` : ''}
## How the suites behave

- **Chaining:** create requests capture the new resource's id; read/update/delete
  requests use it. Update and delete requests only run against resources created
  by the same run (set the collection variable \`allowMutationOfExistingData\` to
  \`true\` to opt out).
- **Negative tests** use a disposable resource created in setup and remove it in
  teardown. Each request contains exactly one fault.
- **Response time** threshold: collection variable \`responseTimeThresholdMs\`.
- Requests whose prerequisites are missing are skipped with a \`[SKIPPED]\` log line.

## Run with Newman

\`\`\`bash
npx newman run "${files.positive}" -e "${files.environment}"${data}
npx newman run "${files.negative}" -e "${files.environment}"
\`\`\`

Fill in \`baseUrl\` and any credentials in the environment first. Values marked
as secrets should come from a secure store rather than being committed.
${specGaps.length > 0 ? `
## Spec gaps

These scenarios have no documented status code; the tests assert the
HTTP-conventional codes instead:

${specGaps.map(g => `- \`${g.operation}\` - ${g.scenario} (asserting ${g.assertedCodes.join('/')})`).join('\n')}
` : ''}
## Operations

${apiSpec.endpoints.map(e => `- \`${e.method} ${e.path}\`${e.summary ? ` - ${e.summary.replace(/\r?\n/g, ' ')}` : ''}`).join('\n')}
`;
}
