/**
 * "Kitchen sink" spec covering the request shapes that can modify existing data
 * (collection-level DELETE, sub-resource updates, action POSTs, parameters
 * embedded in a segment, trailing slashes, bounded ids), plus oneOf with a
 * discriminator, cyclic schemas and data-driven bodies that share names with
 * credentials. The recording mock lets tests assert exactly which requests a
 * generated suite sent.
 */
import http from 'node:http';

const json = schema => ({ content: { 'application/json': { schema } } });
const ok = (schema, code = 200) => ({ [code]: { description: 'ok', ...(schema ? json(schema) : {}) } });
const idParam = (name, schema) => ({ name, in: 'path', required: true, schema });

export const kitchenSpec = {
  openapi: '3.0.3',
  info: { title: 'Kitchen', version: '1.0.0' },
  servers: [{ url: 'http://localhost' }],
  security: [{ bearer: [] }],
  components: {
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    schemas: {
      Cat: { type: 'object', required: ['petType', 'name'], properties: { petType: { type: 'string' }, name: { type: 'string' }, huntingSkill: { type: 'string' } } },
      Dog: { type: 'object', required: ['petType', 'name'], properties: { petType: { type: 'string' }, name: { type: 'string' }, packSize: { type: 'integer' } } },
      Node: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#/components/schemas/Node' } } } },
      Todo: { type: 'object', required: ['title'], properties: { id: { type: 'integer', readOnly: true }, title: { type: 'string' } } },
    },
  },
  paths: {
    '/login': { post: {
      security: [],
      requestBody: json({ type: 'object', required: ['username', 'password'], properties: {
        username: { type: 'string', example: 'admin' }, password: { type: 'string', example: 's3cret' },
      } }),
      responses: { ...ok({ type: 'object', properties: { token: { type: 'string' } } }), 401: { description: 'bad credentials' } },
    } },
    '/orders': { get: { responses: ok({ type: 'array', items: { type: 'object', properties: { id: { type: 'integer' } } } }) } },
    '/orders/{id}': {
      parameters: [idParam('id', { type: 'integer', minimum: 1, maximum: 100 })],
      get: { responses: { ...ok({ type: 'object' }), 404: { description: 'missing' } } },
      delete: { responses: { 204: { description: 'deleted' }, 401: { description: 'auth' }, 404: { description: 'missing' } } },
    },
    '/orders/{id}/status': {
      parameters: [idParam('id', { type: 'integer', minimum: 1, maximum: 100 })],
      put: { requestBody: json({ type: 'object', required: ['status'], properties: { status: { type: 'string' } } }), responses: { ...ok(null), 400: { description: 'bad' }, 401: { description: 'auth' } } },
    },
    '/orders/{id}/cancel': {
      parameters: [idParam('id', { type: 'integer', minimum: 1, maximum: 100 })],
      post: { responses: { ...ok(null), 401: { description: 'auth' } } },
    },
    '/todos': {
      get: { responses: ok({ type: 'array', items: { $ref: '#/components/schemas/Todo' } }) },
      post: { requestBody: json({ $ref: '#/components/schemas/Todo' }), responses: { ...ok({ $ref: '#/components/schemas/Todo' }, 201), 400: { description: 'bad' }, 401: { description: 'auth' } } },
      delete: { summary: 'Delete all todos', responses: { 204: { description: 'all deleted' }, 401: { description: 'auth' } } },
    },
    '/todos/{todoId}': {
      parameters: [idParam('todoId', { type: 'integer' })],
      get: { responses: { ...ok({ $ref: '#/components/schemas/Todo' }), 404: { description: 'missing' } } },
      put: { requestBody: json({ $ref: '#/components/schemas/Todo' }), responses: { ...ok({ $ref: '#/components/schemas/Todo' }), 400: { description: 'bad' }, 404: { description: 'missing' } } },
      delete: { responses: { 204: { description: 'deleted' }, 404: { description: 'missing' } } },
    },
    '/files/{name}.json': {
      parameters: [idParam('name', { type: 'string', example: 'report' })],
      delete: { responses: { 204: { description: 'deleted' } } },
    },
    '/tickets/': { get: { responses: ok({ type: 'array', items: { type: 'object', properties: { ticket_id: { type: 'string' } } } }) } },
    '/tickets/{ticket_id}/': {
      parameters: [idParam('ticket_id', { type: 'string' })],
      get: { responses: { ...ok({ type: 'object' }), 404: { description: 'missing' } } },
      delete: { responses: { 204: { description: 'deleted' }, 404: { description: 'missing' } } },
    },
    '/animals': { get: { responses: ok({ oneOf: [{ $ref: '#/components/schemas/Cat' }, { $ref: '#/components/schemas/Dog' }], discriminator: { propertyName: 'petType' } }) } },
    '/tree': { get: { responses: ok({ $ref: '#/components/schemas/Node' }) } },
    '/users': { post: {
      requestBody: json({ type: 'object', required: ['username', 'password'], properties: {
        username: { type: 'string' }, password: { type: 'string' },
        zip: { type: 'string', example: '90210' }, code: { type: 'string', pattern: '^\\d{4}$', example: '0000' },
      } }),
      responses: { ...ok({ type: 'object', properties: { id: { type: 'integer' } } }, 201), 400: { description: 'bad' }, 401: { description: 'auth' } },
    } },
    '/users/{id}': {
      parameters: [idParam('id', { type: 'integer' })],
      delete: { responses: { 204: { description: 'deleted' }, 404: { description: 'missing' } } },
    },
  },
};

/** Recording mock: every request is logged with its parsed body. */
export function startKitchenMock() {
  const requests = [];
  let next = 500;
  const todos = new Map();
  const users = new Map();

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      let body;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { body = Symbol.for('malformed'); }
      requests.push({ method: req.method, path: url.pathname, body, auth: req.headers.authorization || null });
      const send = (code, payload) => {
        if (payload === undefined) { res.writeHead(code); res.end(); return; }
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (body === Symbol.for('malformed')) return send(400, { error: 'malformed' });
      const route = `${req.method} ${url.pathname}`;

      if (route === 'POST /login') {
        return body?.username === 'admin' && body?.password === 's3cret' ? send(200, { token: 'tok' }) : send(401, { error: 'bad credentials' });
      }
      if (req.headers.authorization !== 'Bearer tok') return send(401, { error: 'auth' });

      if (route === 'GET /orders') return send(200, [{ id: 1 }]);
      if (route === 'GET /tickets/') return send(200, [{ ticket_id: 't1' }]);
      if (route === 'GET /animals') return send(200, { petType: 'cat', name: 'Tom', huntingSkill: 'lazy' });
      if (route === 'GET /tree') return send(200, { name: 'root', children: [{ name: 'leaf', children: [] }] });
      if (route === 'GET /todos') return send(200, [...todos.entries()].map(([id, t]) => ({ id, ...t })));
      if (route === 'POST /todos') {
        if (typeof body?.title !== 'string' || body.title === '' || Object.keys(body).some(k => k !== 'title')) return send(400, { error: 'invalid' });
        const id = next++; todos.set(id, { title: body.title });
        return send(201, { id, title: body.title });
      }
      if (route === 'POST /users') {
        const valid = body && typeof body.username === 'string' && typeof body.password === 'string'
          && (body.zip === undefined || typeof body.zip === 'string')
          && (body.code === undefined || (typeof body.code === 'string' && /^\d{4}$/.test(body.code)));
        if (!valid) return send(400, { error: 'invalid' });
        const id = next++; users.set(id, body);
        return send(201, { id });
      }
      let m = url.pathname.match(/^\/todos\/(\d+)$/);
      if (m) {
        const id = Number(m[1]);
        if (!todos.has(id)) return send(404, { error: 'missing' });
        if (req.method === 'GET') return send(200, { id, ...todos.get(id) });
        if (req.method === 'PUT') {
          if (typeof body?.title !== 'string' || Object.keys(body).some(k => k !== 'title')) return send(400, { error: 'invalid' });
          todos.set(id, { title: body.title });
          return send(200, { id, title: body.title });
        }
        if (req.method === 'DELETE') { todos.delete(id); return send(204); }
      }
      m = url.pathname.match(/^\/users\/(\d+)$/);
      if (m && req.method === 'DELETE') return users.delete(Number(m[1])) ? send(204) : send(404, { error: 'missing' });
      if (/^\/orders\/\d+$/.test(url.pathname) && req.method === 'GET') return url.pathname === '/orders/1' ? send(200, { id: 1 }) : send(404, { error: 'missing' });
      if (/^\/tickets\/[^/]+\/$/.test(url.pathname) && req.method === 'GET') return url.pathname === '/tickets/t1/' ? send(200, {}) : send(404, { error: 'missing' });
      // Anything else that mutates is recorded and "succeeds", so a missing guard is visible.
      return send(req.method === 'DELETE' ? 204 : 200, req.method === 'DELETE' ? undefined : {});
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise(done => server.close(done)),
  })));
}
