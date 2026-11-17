import { categorizeEndpoints, formatName, resourceName } from '../core/endpoints.js';
import { buildRequest } from '../core/request.js';
import { leafSchemas, leafTypes, stripDynamicVariables } from '../core/schema.js';
import { SuiteBuilder, depth } from './suite-builder.js';
import { TestScriptGenerator } from './test-script-generator.js';

/**
 * Positive Test Generator
 *
 * Folder order: Setup → Read collections → Create → Read items → Update → Delete.
 * Create captures the new resource's id; read/update/delete use that id, so the
 * suite only ever updates or deletes data it created itself.
 */
export class PositiveTestGenerator extends SuiteBuilder {
  constructor(apiSpec, options = {}) {
    super(apiSpec, options);
    this.dataDriven = !!options.dataDriven;
    /** Leaf body fields (dotted path → schema) driven by iteration data. */
    this.dataFields = new Map();
  }

  generate() {
    const crud = categorizeEndpoints(this.apiSpec.endpoints, this.auth.authEndpoint);
    const byDepth = (a, b) => depth(a) - depth(b);
    const label = (endpoint, fallback) => `${endpoint.method} ${endpoint.path}${endpoint.summary ? ` - ${endpoint.summary}` : ` - ${fallback}`}`;

    const folders = [
      { name: '0. Setup', description: 'Authentication', item: this.auth.authEndpoint ? [this.authItem()] : [] },
      {
        name: '1. Read Collections',
        description: 'GET endpoints without an item id. List responses seed ids for read-only requests.',
        item: [...crud.list].sort(byDepth).map(e => this.positiveItem(e, {
          name: label(e, `List ${formatName(resourceName(e))}`),
          capture: this.listCapture(e),
        })),
      },
      {
        name: '2. Create',
        description: 'POST endpoints. Created ids are captured for the following folders.',
        item: [...crud.create].sort(byDepth).map(e => this.bodyItem(e, label(e, `Create ${formatName(resourceName(e))}`), {
          capture: this.createCapture(e),
        })),
      },
      {
        name: '3. Read Items',
        description: 'GET by id.',
        item: [...crud.read].sort(byDepth).map(e => this.positiveItem(e, { name: label(e, `Get ${formatName(resourceName(e))}`) })),
      },
      {
        name: '4. Update',
        description: 'PUT/PATCH. Only runs against resources created by this run.',
        item: [...crud.update].sort(byDepth).map(e => this.bodyItem(e, label(e, `Update ${formatName(resourceName(e))}`))),
      },
      {
        name: '5. Delete',
        description: 'DELETE, children before parents. Only runs against resources created by this run.',
        item: [...crud.delete].sort((a, b) => depth(b) - depth(a)).map(e => {
          const binding = this.plan.itemBinding(e);
          return this.positiveItem(e, {
            name: label(e, `Delete ${formatName(resourceName(e))}`),
            release: binding?.runtime ? { varName: binding.varName } : null,
          });
        }),
      },
    ];

    return this.collection(
      `${this.apiSpec.info.title} - Positive Test Suite`,
      `Positive scenarios for ${this.apiSpec.info.title}: documented success codes, response-schema contract checks and CRUD chaining.`,
      folders,
    );
  }

  /** Request with a body; in data-driven mode the body is built from iteration data. */
  bodyItem(endpoint, name, extra = {}) {
    const body = endpoint.requestBody;
    const example = body?.example;
    const dataDriven = this.dataDriven && body && /json/i.test(body.contentType)
      && example && typeof example === 'object' && !Array.isArray(example);
    if (!dataDriven) return this.positiveItem(endpoint, { name, ...extra });

    for (const [path, schema] of Object.entries(leafSchemas(body.schema))) {
      if (!this.dataFields.has(path)) this.dataFields.set(path, schema);
    }
    return this.positiveItem(endpoint, {
      name,
      ...extra,
      request: buildRequest(endpoint, this.ctx, { rawBody: '{{requestBody}}' }),
      prerequest: TestScriptGenerator.dataDrivenBodyScript(stripDynamicVariables(example), leafTypes(body.schema)),
    });
  }
}
