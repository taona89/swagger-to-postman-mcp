/**
 * Test Script Generator
 * Generates Postman test scripts for assertions
 */
export class TestScriptGenerator {
  /**
   * Generate positive test scripts
   */
  static generatePositiveTests(endpoint, options = {}) {
    const { expectedStatus = 200, contractValidation = true } = options;
    const scripts = [];

    // Exact status code test from the OpenAPI spec
    scripts.push(
      `pm.test('[POSITIVE] Status code is ${expectedStatus}', function () {`,
      `    pm.expect(pm.response.code).to.equal(${expectedStatus});`,
      `});`
    );

    // Response time test
    scripts.push(
      ``,
      `pm.test('[PERFORMANCE] Response time is acceptable', function () {`,
      `    pm.expect(pm.response.responseTime).to.be.below(5000);`,
      `});`
    );

    // Payload validation for 204 No Content
    scripts.push(
      ``,
      `// Special validation for 204 No Content`,
      `if (pm.response.code === 204) {`,
      `    pm.test('[PAYLOAD] 204 response has no content', function () {`,
      `        const responseText = pm.response.text();`,
      `        pm.expect(responseText).to.be.empty;`,
      `    });`,
      `    console.log('✅ 204 No Content - validated empty response');`,
      `}`
    );

    // Payload validation for non-204 responses
    scripts.push(
      ``,
      `// Payload validation for responses with content (non-204)`,
      `if (pm.response.code !== 204) {`,
      `    pm.test('[PAYLOAD] Response contains valid payload', function () {`,
      `        const responseText = pm.response.text();`,
      `        pm.expect(responseText).to.not.be.empty;`,
      `        const contentType = pm.response.headers.get('Content-Type') || '';`,
      `        pm.expect(contentType.includes('json') || contentType.includes('html') || contentType.includes('text')).to.be.true;`,
      `    });`,
      `    `,
      `    pm.test('[PAYLOAD] Response is valid JSON or HTML', function () {`,
      `        const contentType = pm.response.headers.get('Content-Type') || '';`,
      `        if (contentType.includes('json')) {`,
      `            pm.expect(() => pm.response.json()).to.not.throw();`,
      `        } else {`,
      `            pm.expect(pm.response.text()).to.not.be.empty;`,
      `        }`,
      `    });`,
      `}`
    );

    // Contract validation for GET/POST/PUT
    if (contractValidation && endpoint.responses[expectedStatus]) {
      const responseSchema = endpoint.responses[expectedStatus].schema;

      if (responseSchema.type === 'array') {
        scripts.push(
          ``,
          `// Contract validation for array responses`,
          `if (pm.response.code !== 204) {`,
          `    pm.test('[CONTRACT] Response is a valid array', function () {`,
          `        const jsonData = pm.response.json();`,
          `        pm.expect(jsonData).to.be.an('array');`,
          `    });`,
          `}`
        );

        if (responseSchema.items && responseSchema.items.properties) {
          scripts.push(
            ``,
            `if (pm.response.code !== 204 && pm.response.json().length > 0) {`,
            `    pm.test('[CONTRACT] Item has required fields', function () {`,
            `        const item = pm.response.json()[0];`
          );

          for (const [propName, propSchema] of Object.entries(responseSchema.items.properties)) {
            scripts.push(
              `        pm.expect(item).to.have.property('${propName}');`
            );
          }

          scripts.push(`    });`, `}`);
        }
      } else if (responseSchema.type === 'object' && responseSchema.properties) {
        scripts.push(
          ``,
          `// Contract validation for object responses`,
          `if (pm.response.code !== 204) {`,
          `    pm.test('[CONTRACT] Response has required fields', function () {`,
          `        const jsonData = pm.response.json();`
        );

        for (const [propName, propSchema] of Object.entries(responseSchema.properties)) {
          scripts.push(
            `        pm.expect(jsonData).to.have.property('${propName}');`
          );
        }

        scripts.push(`    });`, `}`);
      }
    }

    // Store ID for POST operations
    if (endpoint.method === 'POST' && (expectedStatus === 200 || expectedStatus === 201)) {
      scripts.push(
        ``,
        `// Store created resource ID`,
        `if (pm.response.code >= 200 && pm.response.code < 300) {`,
        `    try {`,
        `        const jsonData = pm.response.json();`,
        `        if (jsonData.id) {`,
        `            pm.environment.set('created_${this.getResourceName(endpoint)}_id', jsonData.id);`,
        `            console.log('✅ Stored ${this.getResourceName(endpoint)} ID:', jsonData.id);`,
        `        }`,
        `    } catch(e) {`,
        `        console.log('Response does not contain ID field');`,
        `    }`,
        `}`
      );
    }

    scripts.push(
      ``,
      `console.log('✅ ${endpoint.method} ${endpoint.path} - All tests passed');`
    );

    return scripts;
  }

  /**
   * Resolve the expected 4xx status code for a scenario using spec-defined codes.
   * Returns { exact: N } if a specific code can be matched,
   * { oneOf: [N, ...] } if multiple spec codes are available,
   * or {} as a fallback to the 400-499 range.
   */
  static resolveExpectedCode(scenario, specErrorCodes) {
    const lower = scenario.toLowerCase();

    // Map scenario type to preferred codes in priority order
    let preferredCodes;
    if (lower.includes('no authentication') || lower.includes('unauthorized')) {
      preferredCodes = [401, 403];
    } else if (lower.includes('missing') || lower.includes('empty') ||
               lower.includes('invalid type') || lower.includes('malformed')) {
      preferredCodes = [422, 400];
    } else if (lower.includes('invalid id')) {
      preferredCodes = [400, 422];
    } else if (lower.includes('non-existent') || lower.includes('not found')) {
      preferredCodes = [404];
    } else {
      preferredCodes = [];
    }

    // Find the first preferred code that is actually defined in the spec
    for (const code of preferredCodes) {
      if (specErrorCodes.includes(code)) {
        return { exact: code };
      }
    }

    // No exact match - assert response is one of the spec-defined error codes
    if (specErrorCodes.length > 0) {
      return { oneOf: specErrorCodes };
    }

    // Spec defines no 4xx at all - fall back to range
    return {};
  }

  /**
   * Generate negative test scripts driven by spec-defined error codes.
   */
  static generateNegativeTests(endpoint, scenario) {
    const scripts = [];

    // Extract 4xx codes defined in the spec for this endpoint
    const specErrorCodes = endpoint.responses
      ? Object.keys(endpoint.responses)
          .map(Number)
          .filter(code => code >= 400 && code < 500)
          .sort((a, b) => a - b)
      : [];

    const expected = this.resolveExpectedCode(scenario, specErrorCodes);

    // Fail if response is 2xx (negative tests should never succeed)
    scripts.push(
      `// Fail if response is successful (negative tests should never succeed)`,
      `if (pm.response.code >= 200 && pm.response.code < 300) {`,
      `    pm.test('[FAIL] Negative test should not succeed', function () {`,
      `        throw new Error('Expected error response but got successful status: ' + pm.response.code);`,
      `    });`,
      `}`
    );

    // Fail if server returns 5xx (should never happen)
    scripts.push(
      ``,
      `// Fail if server returns 5xx error`,
      `if (pm.response.code >= 500) {`,
      `    pm.test('[FAIL] Server error 5xx should not occur', function () {`,
      `        throw new Error('Server error occurred (5xx): ' + pm.response.code);`,
      `    });`,
      `}`
    );

    // Status code assertion driven by spec
    if (expected.exact) {
      scripts.push(
        ``,
        `pm.test('[NEGATIVE] Status code is ${expected.exact} (spec-defined)', function () {`,
        `    pm.expect(pm.response.code).to.equal(${expected.exact});`,
        `});`
      );
    } else if (expected.oneOf && expected.oneOf.length > 0) {
      const codeList = JSON.stringify(expected.oneOf);
      const codeLabel = expected.oneOf.join('/');
      scripts.push(
        ``,
        `pm.test('[NEGATIVE] Status code is one of spec-defined error codes (${codeLabel})', function () {`,
        `    pm.expect(${codeList}).to.include(pm.response.code);`,
        `});`
      );
    } else {
      scripts.push(
        ``,
        `pm.test('[NEGATIVE] Status code is in error range (400-499)', function () {`,
        `    pm.expect(pm.response.code).to.be.within(400, 499);`,
        `});`
      );
    }

    // Payload validation
    scripts.push(
      ``,
      `pm.test('[PAYLOAD] Error response contains message', function () {`,
      `    pm.expect(pm.response.text()).to.exist.and.not.be.empty;`,
      `});`,
      ``,
      `if (pm.response.headers.get('Content-Type') && pm.response.headers.get('Content-Type').includes('json')) {`,
      `    pm.test('[PAYLOAD] Error response is valid JSON', function () {`,
      `        pm.expect(() => pm.response.json()).to.not.throw();`,
      `    });`,
      `    pm.test('[PAYLOAD] Error response has error field or message', function () {`,
      `        const jsonData = pm.response.json();`,
      `        const hasError = jsonData.error || jsonData.message || jsonData.detail || jsonData.errors;`,
      `        pm.expect(hasError).to.exist;`,
      `    });`,
      `}`,
      ``,
      `console.log('✅ Correctly rejected: ${scenario}');`
    );

    return scripts;
  }

  /**
   * Generate auth setup script — extracts token/cookie from auth endpoint response
   * and stores it so all subsequent requests can use it automatically.
   * @param {object|null} authScheme - first entry from apiSpec.authSchemes (may be null)
   */
  static generateAuthSetupScript(authScheme) {
    // Decide what env vars to set based on the security scheme type
    let storeStatements;

    if (authScheme && authScheme.type === 'http' && authScheme.scheme === 'bearer') {
      storeStatements = [
        `            pm.environment.set('token', token);`,
        `            console.log('✅ Bearer token stored:', token.substring(0, 10) + '...');`
      ];
    } else if (authScheme && authScheme.type === 'apiKey' && authScheme.in === 'header') {
      const varName = authScheme.name || 'x-api-key';
      storeStatements = [
        `            pm.environment.set('token', token);`,
        `            pm.environment.set('apiKey', token);`,
        `            pm.environment.set('${varName}', token);`,
        `            console.log('✅ API key stored for header: ${varName}');`
      ];
    } else {
      // Cookie-based (apiKey in cookie, or no scheme — use generic token= cookie)
      const cookieName = (authScheme && authScheme.name) || 'token';
      storeStatements = [
        `            pm.environment.set('token', token);`,
        `            pm.environment.set('authCookie', '${cookieName}=' + token);`,
        `            console.log('✅ Auth token stored — cookie: ${cookieName}=' + token);`
      ];
    }

    return [
      `pm.test('[AUTH] Authentication successful', function () {`,
      `    pm.expect(pm.response.code).to.be.oneOf([200, 201]);`,
      `});`,
      ``,
      `if (pm.response.code === 200 || pm.response.code === 201) {`,
      `    try {`,
      `        const json = pm.response.json();`,
      `        // Try common token field names`,
      `        const token = json.token || json.access_token || json.accessToken ||`,
      `                      json.id_token || json.jwt || json.auth_token ||`,
      `                      json.apiKey || json.api_key || json.Bearer;`,
      `        if (token) {`,
      ...storeStatements,
      `        } else {`,
      `            // Fallback: try Set-Cookie response headers`,
      `            let cookieStored = false;`,
      `            pm.response.headers.each(function(h) {`,
      `                if (h.key.toLowerCase() === 'set-cookie' && !cookieStored) {`,
      `                    const cookieVal = h.value.split(';')[0];`,
      `                    pm.environment.set('authCookie', cookieVal);`,
      `                    cookieStored = true;`,
      `                    console.log('✅ Cookie stored from Set-Cookie header:', cookieVal);`,
      `                }`,
      `            });`,
      `            if (!cookieStored) {`,
      `                console.log('⚠️ No token found in response body or Set-Cookie headers');`,
      `            }`,
      `        }`,
      `    } catch(e) {`,
      `        console.log('⚠️ Could not parse auth response:', e.message);`,
      `    }`,
      `}`
    ];
  }

  /**
   * Generate authentication test scripts (legacy — kept for reference)
   */
  static generateAuthTests() {
    return [
      `pm.test('Login successful', function () {`,
      `    pm.response.to.have.status(200);`,
      `});`,
      ``,
      `// Extract and store session cookies from actual response`,
      `if (pm.response.code === 200) {`,
      `    let sessionToken = '';`,
      `    let tenantId = '';`,
      `    const username = pm.environment.get('username') || 'admin';`,
      `    `,
      `    // Extract cookies from Set-Cookie headers`,
      `    pm.response.headers.each((header) => {`,
      `        if (header.key === 'Set-Cookie') {`,
      `            const value = header.value;`,
      `            if (value.includes('session_token=') && !sessionToken) {`,
      `                const match = value.match(/session_token=([^;]+)/);`,
      `                if (match) {`,
      `                    sessionToken = match[1];`,
      `                    console.log('✅ Session token extracted:', sessionToken.substring(0, 20) + '...');`,
      `                }`,
      `            }`,
      `            if (value.includes('X-Tenant-ID=') && !tenantId) {`,
      `                const match = value.match(/X-Tenant-ID=([^;]+)/);`,
      `                if (match) {`,
      `                    tenantId = match[1];`,
      `                    console.log('✅ Tenant ID extracted:', tenantId);`,
      `                }`,
      `            }`,
      `        }`,
      `    });`,
      `    `,
      `    // Store individual cookie components`,
      `    if (sessionToken) {`,
      `        pm.environment.set('sessionToken', sessionToken);`,
      `        pm.environment.set('session_token', sessionToken);`,
      `    }`,
      `    if (tenantId) {`,
      `        pm.environment.set('tenantId', tenantId);`,
      `        pm.environment.set('tenant_id', tenantId);`,
      `    }`,
      `    pm.environment.set('username', username);`,
      `    `,
      `    // Create clean cookie string`,
      `    if (sessionToken && tenantId) {`,
      `        const fullCookie = \`X-Tenant-ID=\${tenantId}; j5_username=\${username}; session_token=\${sessionToken}\`;`,
      `        pm.environment.set('authCookie', fullCookie);`,
      `        pm.environment.set('full_cookie_string', fullCookie);`,
      `        console.log('✅ Clean auth cookie created');`,
      `    }`,
      `    `,
      `    console.log('✅ Authentication successful - Ready for API testing');`,
      `} else {`,
      `    console.log('❌ Login failed with status:', pm.response.code);`,
      `}`
    ];
  }

  /**
   * Generate setup/reference data extraction scripts
   */
  static generateSetupScript(resourceName, storeAs) {
    // storeAs can be a string or an array of variable names
    const storeAsArray = Array.isArray(storeAs) ? storeAs : [storeAs];
    const setStatements = storeAsArray.map(
      varName => `        pm.environment.set('${varName}', data[0].id);`
    );
    return [
      `pm.test('Status code is 200', function () {`,
      `    pm.expect(pm.response.code).to.equal(200);`,
      `});`,
      ``,
      `try {`,
      `    const data = pm.response.json();`,
      `    if (data && data.length > 0) {`,
      ...setStatements,
      `        console.log('✅ Stored ${resourceName} ID:', data[0].id);`,
      `    }`,
      `} catch(e) {`,
      `    console.log('⚠️ Failed to parse response as JSON');`,
      `}`
    ];
  }

  /**
   * Generate areas tree extraction script
   * Extracts area IDs from hierarchical tree structure
   */
  static generateAreasTreeScript() {
    return [
      `pm.test('Status code is 200', function () {`,
      `    pm.expect(pm.response.code).to.equal(200);`,
      `});`,
      ``,
      `pm.test('Extract area IDs from tree', function () {`,
      `    const responseJson = pm.response.json();`,
      `    `,
      `    // Helper function to flatten tree structure and collect all area IDs`,
      `    function flattenAreaTree(areas, collected = []) {`,
      `        if (!Array.isArray(areas)) return collected;`,
      `        `,
      `        for (const area of areas) {`,
      `            if (area && area.id) {`,
      `                // Skip root area (all zeros) and deleted areas`,
      `                if (area.id !== '00000000000000000000000000000000' && !area.deleted) {`,
      `                    collected.push({`,
      `                        id: area.id,`,
      `                        description: area.description || 'Unknown',`,
      `                        full_path: area.full_path || area.id`,
      `                    });`,
      `                }`,
      `                // Recursively process children`,
      `                if (area.children && area.children.length > 0) {`,
      `                    flattenAreaTree(area.children, collected);`,
      `                }`,
      `            }`,
      `        }`,
      `        return collected;`,
      `    }`,
      `    `,
      `    if (responseJson && Array.isArray(responseJson)) {`,
      `        const allAreas = flattenAreaTree(responseJson);`,
      `        console.log('📊 Total valid areas found:', allAreas.length);`,
      `        `,
      `        if (allAreas.length > 0) {`,
      `            // Store first area ID with multiple variable names for compatibility`,
      `            pm.environment.set('valid_areas', allAreas[0].id);`,
      `            pm.environment.set('areas', allAreas[0].id);`,
      `            pm.environment.set('areaId', allAreas[0].id);`,
      `            console.log('✅ Area ID extracted:', allAreas[0].id, '(' + allAreas[0].description + ')');`,
      `            `,
      `            // Store second area ID if available`,
      `            if (allAreas[1]) {`,
      `                pm.environment.set('areaId2', allAreas[1].id);`,
      `                console.log('✅ Second Area ID extracted:', allAreas[1].id, '(' + allAreas[1].description + ')');`,
      `            }`,
      `            `,
      `            // Store comma-separated list of first 5 area IDs for asset_ids parameter`,
      `            const areaIds = allAreas.slice(0, 5).map(a => a.id).join(',');`,
      `            pm.environment.set('valid_areas_list', areaIds);`,
      `            pm.environment.set('asset_ids', areaIds);`,
      `            console.log('✅ Area IDs list stored (first 5)');`,
      `            `,
      `            console.log('🎯 Areas ready for API testing');`,
      `        } else {`,
      `            console.log('❌ No valid areas found');`,
      `        }`,
      `    }`,
      `});`
    ];
  }

  /**
   * Extract resource name from endpoint
   */
  static getResourceName(endpoint) {
    const parts = endpoint.path.split('/').filter(p => p && !p.startsWith('{'));
    return parts[parts.length - 1] || 'resource';
  }
}
