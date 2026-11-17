/**
 * HTML Report Generator
 * Static summary of a generated suite. Every value that originates from the
 * spec or the collections is HTML-escaped (spec content is untrusted input).
 */
import { escapeHtml } from '../core/escape.js';

const esc = escapeHtml;
const countRequests = collection => {
  let n = 0;
  const walk = items => (items || []).forEach(item => (item.item ? walk(item.item) : n++));
  walk(collection.item);
  return n;
};

export class HTMLReportGenerator {
  /**
   * @param {object} apiSpec parsed spec
   * @param {object} positiveCollection
   * @param {object} negativeCollection
   * @param {object} [extras] { coverage, specGaps }
   */
  static generate(apiSpec, positiveCollection, negativeCollection, extras = {}) {
    const timestamp = new Date().toISOString();
    const coverage = extras.coverage;
    const specGaps = extras.specGaps || [];
    const contractCount = [positiveCollection, negativeCollection]
      .flatMap(c => JSON.stringify(c).match(/to\.have\.jsonSchema/g) || []).length;

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <title>${esc(apiSpec.info.title)} - Test Collection Report</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            padding: 20px;
            line-height: 1.6;
        }

        .container {
            max-width: 1400px;
            margin: 0 auto;
            background: white;
            border-radius: 12px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.3);
            overflow: hidden;
        }

        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 40px;
            text-align: center;
        }

        .header h1 {
            font-size: 42px;
            margin-bottom: 10px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.2);
        }

        .header .version {
            font-size: 18px;
            opacity: 0.9;
            margin-bottom: 5px;
        }

        .header .timestamp {
            font-size: 14px;
            opacity: 0.8;
        }

        .summary {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            padding: 30px;
            background: #f8f9fa;
            border-bottom: 1px solid #e0e0e0;
        }

        .summary-card {
            background: white;
            padding: 25px;
            border-radius: 10px;
            border-left: 5px solid #667eea;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            transition: transform 0.2s;
        }

        .summary-card:hover {
            transform: translateY(-5px);
            box-shadow: 0 5px 20px rgba(0,0,0,0.15);
        }

        .summary-card.positive { border-left-color: #10b981; }
        .summary-card.negative { border-left-color: #ef4444; }
        .summary-card.endpoints { border-left-color: #f59e0b; }

        .summary-card h3 {
            font-size: 14px;
            color: #666;
            margin-bottom: 10px;
            text-transform: uppercase;
            letter-spacing: 1px;
        }

        .summary-card .value {
            font-size: 42px;
            font-weight: bold;
            color: #333;
            margin-bottom: 5px;
        }

        .summary-card .subtitle {
            font-size: 14px;
            color: #999;
        }

        .content {
            padding: 30px;
        }

        .section {
            margin-bottom: 40px;
        }

        .section-header {
            display: flex;
            align-items: center;
            margin-bottom: 20px;
            padding-bottom: 10px;
            border-bottom: 3px solid #667eea;
        }

        .section-header h2 {
            font-size: 28px;
            color: #333;
            margin-right: 15px;
        }

        .section-header .badge {
            background: #667eea;
            color: white;
            padding: 5px 15px;
            border-radius: 20px;
            font-size: 14px;
            font-weight: bold;
        }

        .api-info {
            background: #f8f9fa;
            padding: 25px;
            border-radius: 10px;
            margin-bottom: 30px;
        }

        .api-info-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
        }

        .api-info-item {
            display: flex;
            align-items: start;
        }

        .api-info-item strong {
            color: #667eea;
            min-width: 120px;
            font-weight: 600;
        }

        .api-info-item span {
            color: #555;
            word-break: break-word;
        }

        .endpoints-table {
            width: 100%;
            border-collapse: collapse;
            background: white;
            border-radius: 10px;
            overflow: hidden;
            box-shadow: 0 2px 10px rgba(0,0,0,0.05);
        }

        .endpoints-table thead {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }

        .endpoints-table th {
            padding: 15px;
            text-align: left;
            font-weight: 600;
            text-transform: uppercase;
            font-size: 13px;
            letter-spacing: 1px;
        }

        .endpoints-table td {
            padding: 15px;
            border-bottom: 1px solid #f0f0f0;
        }

        .endpoints-table tbody tr:hover {
            background: #f8f9fa;
        }

        .method-badge {
            display: inline-block;
            padding: 5px 12px;
            border-radius: 5px;
            font-weight: bold;
            font-size: 12px;
            text-transform: uppercase;
        }

        .method-GET { background: #10b981; color: white; }
        .method-POST { background: #3b82f6; color: white; }
        .method-PUT { background: #f59e0b; color: white; }
        .method-PATCH { background: #8b5cf6; color: white; }
        .method-DELETE { background: #ef4444; color: white; }

        .collection-folder {
            background: white;
            border: 1px solid #e0e0e0;
            border-radius: 8px;
            margin-bottom: 15px;
            overflow: hidden;
            transition: box-shadow 0.2s;
        }

        .collection-folder:hover {
            box-shadow: 0 5px 15px rgba(0,0,0,0.1);
        }

        .folder-header {
            background: linear-gradient(to right, #f8f9fa, #fff);
            padding: 15px 20px;
            border-bottom: 1px solid #e0e0e0;
            cursor: pointer;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .folder-header:hover {
            background: #f8f9fa;
        }

        .folder-name {
            font-weight: 600;
            color: #333;
            font-size: 16px;
        }

        .folder-count {
            background: #667eea;
            color: white;
            padding: 3px 10px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: bold;
        }

        .folder-items {
            padding: 0;
        }

        .folder-item {
            padding: 12px 20px 12px 40px;
            border-bottom: 1px solid #f0f0f0;
        }

        .folder-item:last-child {
            border-bottom: none;
        }

        .folder-item:hover {
            background: #fafafa;
        }

        .item-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }

        .item-name {
            color: #555;
            flex: 1;
            font-weight: 600;
        }

        .item-type {
            background: #e0e7ff;
            color: #667eea;
            padding: 3px 10px;
            border-radius: 5px;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
        }

        .test-details {
            margin-top: 10px;
            padding: 10px;
            background: #fafafa;
            border-radius: 5px;
            font-size: 13px;
        }

        .test-section {
            margin-bottom: 10px;
        }

        .test-section:last-child {
            margin-bottom: 0;
        }

        .test-label {
            font-weight: 600;
            color: #667eea;
            margin-bottom: 5px;
            font-size: 12px;
            text-transform: uppercase;
        }

        .test-content {
            color: #555;
            padding-left: 10px;
        }

        .test-url {
            background: #fff;
            padding: 8px;
            border-radius: 4px;
            border: 1px solid #e0e0e0;
            font-family: 'Courier New', monospace;
            font-size: 12px;
            word-break: break-all;
        }

        .test-body {
            background: #fff;
            padding: 8px;
            border-radius: 4px;
            border: 1px solid #e0e0e0;
            font-family: 'Courier New', monospace;
            font-size: 11px;
            white-space: pre-wrap;
            max-height: 200px;
            overflow-y: auto;
        }

        .test-assertions {
            list-style: none;
            padding: 0;
            margin: 0;
        }

        .test-assertions li {
            padding: 5px 0;
            padding-left: 20px;
            position: relative;
            color: #555;
        }

        .test-assertions li:before {
            content: "✓";
            position: absolute;
            left: 0;
            color: #10b981;
            font-weight: bold;
        }

        .header-item {
            padding: 4px 0;
            font-size: 12px;
            font-family: 'Courier New', monospace;
        }

        .header-key {
            color: #667eea;
            font-weight: 600;
        }

        .header-value {
            color: #555;
        }

        .negative-scenarios {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
            gap: 15px;
        }

        .scenario-card {
            background: white;
            border: 2px solid #fee2e2;
            border-radius: 8px;
            padding: 15px;
            transition: all 0.2s;
        }

        .scenario-card:hover {
            border-color: #ef4444;
            box-shadow: 0 3px 10px rgba(239, 68, 68, 0.2);
            transform: translateY(-2px);
        }

        .scenario-title {
            font-weight: 600;
            color: #991b1b;
            margin-bottom: 8px;
            font-size: 14px;
        }

        .scenario-desc {
            font-size: 13px;
            color: #666;
        }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-top: 20px;
        }

        .stat-box {
            background: white;
            padding: 20px;
            border-radius: 8px;
            border-left: 4px solid #667eea;
            box-shadow: 0 2px 5px rgba(0,0,0,0.05);
        }

        .stat-label {
            font-size: 12px;
            color: #666;
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-bottom: 5px;
        }

        .stat-value {
            font-size: 24px;
            font-weight: bold;
            color: #333;
        }

        .footer {
            background: #2d3748;
            color: white;
            padding: 30px;
            text-align: center;
        }

        .footer-content {
            margin-bottom: 15px;
        }

        .footer-links {
            display: flex;
            justify-content: center;
            gap: 30px;
            flex-wrap: wrap;
        }

        .footer-link {
            color: #a0aec0;
            text-decoration: none;
            font-size: 14px;
            transition: color 0.2s;
        }

        .footer-link:hover {
            color: white;
        }

        .auth-info {
            background: #fffbeb;
            border-left: 4px solid #f59e0b;
            padding: 15px 20px;
            border-radius: 8px;
            margin-bottom: 20px;
        }

        .auth-info h4 {
            color: #92400e;
            margin-bottom: 8px;
        }

        .auth-info ul {
            list-style: none;
            padding-left: 0;
        }

        .auth-info li {
            color: #78350f;
            padding: 5px 0;
            font-size: 14px;
        }

        .auth-info li:before {
            content: "🔐 ";
            margin-right: 5px;
        }

        @media print {
            body {
                background: white;
                padding: 0;
            }
            .container {
                box-shadow: none;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📊 ${esc(apiSpec.info.title)}</h1>
            <div class="version">Version ${esc(apiSpec.info.version)}</div>
            <div class="timestamp">Generated: ${esc(timestamp)}</div>
        </div>

        <div class="summary">
            <div class="summary-card endpoints">
                <h3>Total Endpoints</h3>
                <div class="value">${apiSpec.endpoints.length}</div>
                <div class="subtitle">API Operations</div>
            </div>
            <div class="summary-card positive">
                <h3>Positive Tests</h3>
                <div class="value">${countRequests(positiveCollection)}</div>
                <div class="subtitle">Requests</div>
            </div>
            <div class="summary-card negative">
                <h3>Negative Tests</h3>
                <div class="value">${countRequests(negativeCollection)}</div>
                <div class="subtitle">Requests</div>
            </div>
            <div class="summary-card">
                <h3>Operation Coverage</h3>
                <div class="value">${coverage ? `${coverage.positivePercent}%` : 'n/a'}</div>
                <div class="subtitle">${coverage ? `negative: ${coverage.negativePercent}% of writable operations` : 'not computed'}</div>
            </div>
        </div>

        <div class="content">
            <!-- API Information -->
            <div class="section">
                <div class="section-header">
                    <h2>📋 API Information</h2>
                </div>
                <div class="api-info">
                    <div class="api-info-grid">
                        <div class="api-info-item">
                            <strong>Title:</strong>
                            <span>${esc(apiSpec.info.title)}</span>
                        </div>
                        <div class="api-info-item">
                            <strong>Version:</strong>
                            <span>${esc(apiSpec.info.version)}</span>
                        </div>
                        <div class="api-info-item">
                            <strong>Base URL:</strong>
                            <span>${esc(apiSpec.baseUrl || '(not set in spec)')}</span>
                        </div>
                        <div class="api-info-item">
                            <strong>Total Endpoints:</strong>
                            <span>${apiSpec.endpoints.length}</span>
                        </div>
                    </div>
                    ${apiSpec.info.description ? `
                    <div style="margin-top: 15px; padding-top: 15px; border-top: 1px solid #e0e0e0;">
                        <strong style="color: #667eea;">Description:</strong>
                        <p style="color: #555; margin-top: 8px;">${esc(apiSpec.info.description)}</p>
                    </div>
                    ` : ''}
                </div>

                ${apiSpec.authSchemes.length > 0 ? `
                <div class="auth-info">
                    <h4>🔐 Authentication</h4>
                    <ul>
                        ${apiSpec.authSchemes.map(auth => `
                            <li>${esc(auth.key)} (${esc(auth.type)}${auth.scheme ? ': ' + esc(auth.scheme) : ''}${auth.paramName ? ` - ${esc(auth.in)} "${esc(auth.paramName)}"` : ''})</li>
                        `).join('')}
                    </ul>
                </div>
                ` : ''}
            </div>

            <!-- Endpoints Overview -->
            <div class="section">
                <div class="section-header">
                    <h2>🌐 API Endpoints</h2>
                    <span class="badge">${apiSpec.endpoints.length} endpoints</span>
                </div>
                <table class="endpoints-table">
                    <thead>
                        <tr>
                            <th>Method</th>
                            <th>Path</th>
                            <th>Summary</th>
                            <th>Tags</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${apiSpec.endpoints.map(endpoint => `
                            <tr>
                                <td><span class="method-badge method-${esc(endpoint.method)}">${esc(endpoint.method)}</span></td>
                                <td><code>${esc(endpoint.path)}</code></td>
                                <td>${esc(endpoint.summary || 'No description')}</td>
                                <td>${esc(endpoint.tags.join(', ') || '-')}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>

                <div class="stats-grid">
                    ${this.generateMethodStats(apiSpec.endpoints)}
                </div>
            </div>

            <!-- Positive Test Collection -->
            <div class="section">
                <div class="section-header">
                    <h2>✅ Positive Test Collection</h2>
                    <span class="badge">${positiveCollection.item.length} folders</span>
                </div>
                ${positiveCollection.item.map(folder => `
                    <div class="collection-folder">
                        <div class="folder-header">
                            <span class="folder-name">${esc(folder.name)}</span>
                            <span class="folder-count">${folder.item ? folder.item.length : 0} tests</span>
                        </div>
                        ${folder.item && folder.item.length > 0 ? `
                            <div class="folder-items">
                                ${folder.item.map(item => this.generateTestItemDetails(item)).join('')}
                            </div>
                        ` : ''}
                    </div>
                `).join('')}
            </div>

            <!-- Negative Test Collection -->
            <div class="section">
                <div class="section-header">
                    <h2>❌ Negative Test Collection</h2>
                    <span class="badge">${negativeCollection.item.length} folders</span>
                </div>
                ${negativeCollection.item.map(folder => `
                    <div class="collection-folder">
                        <div class="folder-header">
                            <span class="folder-name">${esc(folder.name)}</span>
                            <span class="folder-count" style="background: #ef4444;">${folder.item ? folder.item.length : 0} tests</span>
                        </div>
                        ${folder.item && folder.item.length > 0 ? `
                            <div class="folder-items">
                                ${folder.item.map(item => this.generateTestItemDetails(item)).join('')}
                            </div>
                        ` : ''}
                    </div>
                `).join('')}
            </div>

            <!-- Test Coverage Summary -->
            <div class="section">
                <div class="section-header">
                    <h2>📈 Test Coverage Summary</h2>
                </div>
                <div class="api-info">
                    <h3 style="color: #667eea; margin-bottom: 15px;">Generated Test Types</h3>
                    <ul style="list-style: none; padding: 0;">
                        <li style="padding: 10px 0; border-bottom: 1px solid #f0f0f0;">
                            ✅ <strong>Positive Tests:</strong> documented success codes, CRUD chaining on resources created by the run
                        </li>
                        <li style="padding: 10px 0; border-bottom: 1px solid #f0f0f0;">
                            ❌ <strong>Negative Tests:</strong> one fault per request (missing/wrong-type/empty fields, malformed JSON, invalid and unknown ids, missing credentials)
                        </li>
                        <li style="padding: 10px 0; border-bottom: 1px solid #f0f0f0;">
                            📋 <strong>Contract Testing:</strong> ${contractCount} schema check${contractCount === 1 ? '' : 's'} against documented response schemas
                        </li>
                        <li style="padding: 10px 0;">
                            ⚡ <strong>Performance:</strong> response time below <code>responseTimeThresholdMs</code>
                        </li>
                    </ul>
                </div>
            </div>

            ${specGaps.length > 0 ? `
            <div class="section">
                <div class="section-header">
                    <h2>🕳️ Spec Gaps</h2>
                    <span class="badge">${specGaps.length}</span>
                </div>
                <div class="api-info">
                    <p style="margin-bottom: 10px;">These scenarios have no documented status code; tests assert the HTTP-conventional codes instead.</p>
                    <ul style="padding-left: 20px;">
                        ${specGaps.map(g => `<li><code>${esc(g.operation)}</code> - ${esc(g.scenario)} (asserting ${esc(g.assertedCodes.join('/'))})</li>`).join('')}
                    </ul>
                </div>
            </div>
            ` : ''}
        </div>

        <div class="footer">
            <div class="footer-content">
                <p><strong>Generated by Swagger to Postman MCP Server</strong></p>
                <p style="margin-top: 10px; color: #a0aec0;">
                    Import these collections into Postman or run with Newman for comprehensive API testing
                </p>
            </div>
        </div>
    </div>
</body>
</html>
    `;
  }

  /**
   * Generate method statistics
   */
  static generateMethodStats(endpoints) {
    const methodCount = {};
    endpoints.forEach(e => {
      methodCount[e.method] = (methodCount[e.method] || 0) + 1;
    });
    const colors = { GET: '#10b981', POST: '#3b82f6', PUT: '#f59e0b', PATCH: '#8b5cf6', DELETE: '#ef4444' };
    return Object.entries(methodCount)
      .map(([method, count]) => `
        <div class="stat-box" style="border-left-color: ${colors[method] || '#667eea'}">
          <div class="stat-label">${esc(method)}</div>
          <div class="stat-value">${count}</div>
        </div>
      `)
      .join('');
  }

  /**
   * Request, expected status and assertions for one collection item
   */
  static generateTestItemDetails(item) {
    const request = item.request;
    if (!request) return '';

    const url = typeof request.url === 'string' ? request.url : (request.url?.raw || '');
    const queryParams = (typeof request.url === 'object' && request.url?.query) || [];
    const headers = request.header || [];

    let bodyContent = '';
    if (request.body?.mode === 'raw') {
      bodyContent = request.body.raw || '';
      try {
        if (bodyContent.trim().startsWith('{')) bodyContent = JSON.stringify(JSON.parse(bodyContent), null, 2);
      } catch { /* show as-is */ }
    } else if (request.body?.mode === 'urlencoded' || request.body?.mode === 'formdata') {
      bodyContent = (request.body[request.body.mode] || []).map(f => `${f.key}=${f.value}`).join('\n');
    }

    const testScript = item.event?.find(e => e.listen === 'test')?.script?.exec || [];
    const assertions = this.extractAssertions(testScript);
    const expected = this.getExpectedStatus(testScript);

    return `
      <div class="folder-item">
        <div class="item-header">
          <span class="item-name">${esc(item.name)}</span>
          <span class="item-type">${esc(request.method || 'REQUEST')}</span>
        </div>
        <div class="test-details">
          ${url ? `
            <div class="test-section">
              <div class="test-label">Request URL</div>
              <div class="test-content"><div class="test-url">${esc(url)}</div></div>
            </div>
          ` : ''}
          ${headers.length > 0 ? `
            <div class="test-section">
              <div class="test-label">Headers</div>
              <div class="test-content">
                ${headers.map(h => `
                  <div class="header-item">
                    <span class="header-key">${esc(h.key)}:</span>
                    <span class="header-value">${esc(h.value || '')}${h.disabled ? ' (disabled)' : ''}</span>
                  </div>
                `).join('')}
              </div>
            </div>
          ` : ''}
          ${queryParams.length > 0 ? `
            <div class="test-section">
              <div class="test-label">Query Parameters</div>
              <div class="test-content">
                ${queryParams.map(q => `
                  <div class="header-item">
                    <span class="header-key">${esc(q.key)}:</span>
                    <span class="header-value">${esc(q.value || '(empty)')}${q.disabled ? ' (disabled)' : ''}</span>
                  </div>
                `).join('')}
              </div>
            </div>
          ` : ''}
          ${bodyContent ? `
            <div class="test-section">
              <div class="test-label">Request Body</div>
              <div class="test-content"><div class="test-body">${esc(bodyContent)}</div></div>
            </div>
          ` : ''}
          <div class="test-section">
            <div class="test-label">Expected Response</div>
            <div class="test-content">
              <div class="header-item">
                <span class="header-key">Status Code:</span>
                <span class="header-value">${esc(expected)}</span>
              </div>
            </div>
          </div>
          ${assertions.length > 0 ? `
            <div class="test-section">
              <div class="test-label">Test Assertions</div>
              <div class="test-content">
                <ul class="test-assertions">
                  ${assertions.map(a => `<li>${esc(a)}</li>`).join('')}
                </ul>
              </div>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }

  /** Expected status recorded by the script generator ("// expected-status: ..."). */
  static getExpectedStatus(testScript) {
    const marker = (Array.isArray(testScript) ? testScript : [String(testScript)])
      .find(line => line.startsWith('// expected-status:'));
    return marker ? marker.slice('// expected-status:'.length).trim() : 'not asserted';
  }

  /** Human-readable assertion titles (pm.test names are JSON string literals). */
  static extractAssertions(testScript) {
    const scriptText = Array.isArray(testScript) ? testScript.join('\n') : String(testScript || '');
    const assertions = [];
    for (const match of scriptText.matchAll(/pm\.test\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g)) {
      try {
        assertions.push(match[1].startsWith('"') ? JSON.parse(match[1]) : match[1].slice(1, -1));
      } catch {
        assertions.push(match[1]);
      }
    }
    if (/pm\.collectionVariables\.set|pm\.environment\.set/.test(scriptText)) assertions.push('Stores response data for later requests');
    return assertions;
  }
}
