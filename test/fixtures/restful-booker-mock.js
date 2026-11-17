/**
 * Spec-compliant local mock of swagger/restful_booker.json.
 *
 * It implements exactly what the spec documents (types, required fields,
 * documented status codes), so a generated test that fails against it is a
 * generator defect, not an API defect. Seed bookings 1 and 2 must survive a
 * full run: suites may only modify data they created themselves.
 *
 * Usage: import { startMock } ... or `node test/fixtures/restful-booker-mock.js [port]`
 *
 * `faults` switches on deliberate defects so tests can prove the generated
 * suites detect them:
 *   acceptWrongTypes   - body type validation is skipped
 *   wrongContract      - GET /booking/{id} returns totalprice as a string
 *   noAuthCheck        - PUT/PATCH/DELETE do not require the token
 *   missingReturns200  - unknown ids return 200 instead of 404
 *   noIdOnCreate       - POST /booking omits bookingid from the response
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';

export const TOKEN = 'abc123token';
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function seed() {
  return new Map([
    [1, { firstname: 'Jim', lastname: 'Brown', totalprice: 111, depositpaid: true, bookingdates: { checkin: '2026-01-01', checkout: '2026-01-02' }, additionalneeds: 'Breakfast' }],
    [2, { firstname: 'Sally', lastname: 'Jones', totalprice: 222, depositpaid: false, bookingdates: { checkin: '2026-02-01', checkout: '2026-02-02' } }],
  ]);
}

function validateBooking(body, partial, faults) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body must be an object';
  if (!partial) {
    for (const key of ['firstname', 'lastname', 'totalprice', 'depositpaid', 'bookingdates']) {
      if (body[key] === undefined) return `${key} is required`;
    }
  }
  if (faults.has('acceptWrongTypes')) return null;
  const checks = {
    firstname: v => typeof v === 'string',
    lastname: v => typeof v === 'string',
    totalprice: v => Number.isInteger(v),
    depositpaid: v => typeof v === 'boolean',
    additionalneeds: v => typeof v === 'string',
    bookingdates: v => v && typeof v === 'object' && !Array.isArray(v)
      && typeof v.checkin === 'string' && DATE.test(v.checkin)
      && typeof v.checkout === 'string' && DATE.test(v.checkout),
  };
  for (const [key, ok] of Object.entries(checks)) {
    if (body[key] !== undefined && !ok(body[key])) return `${key} is invalid`;
  }
  return null;
}

export function startMock({ port = 0, faults = [] } = {}) {
  const faultSet = new Set(faults);
  const bookings = seed();
  let nextId = 3;
  const requests = [];

  const send = (res, code, body) => {
    if (body === undefined) { res.writeHead(code); res.end(); return; }
    if (typeof body === 'string') { res.writeHead(code, { 'Content-Type': 'text/plain' }); res.end(body); return; }
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const authed = req => (req.headers.cookie || '').split(/;\s*/).includes(`token=${TOKEN}`);

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      requests.push({ method: req.method, path: url.pathname, authed: authed(req) });
      let body;
      if (raw) {
        try { body = JSON.parse(raw); } catch { send(res, 400, { reason: 'Malformed JSON' }); return; }
      }

      if (req.method === 'POST' && url.pathname === '/auth') {
        if (body?.username === 'admin' && body?.password === 'password123') send(res, 200, { token: TOKEN });
        else send(res, 400, { reason: 'Bad credentials' });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/ping') { send(res, 201, 'Created'); return; }
      if (req.method === 'GET' && url.pathname === '/booking') {
        let ids = [...bookings.entries()];
        for (const key of ['firstname', 'lastname']) {
          const filter = url.searchParams.get(key);
          if (filter) ids = ids.filter(([, b]) => b[key] === filter);
        }
        send(res, 200, ids.map(([id]) => ({ bookingid: id })));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/booking') {
        const error = validateBooking(body, false, faultSet);
        if (error) { send(res, 400, { reason: error }); return; }
        const id = nextId++;
        bookings.set(id, body);
        send(res, 200, faultSet.has('noIdOnCreate') ? { booking: body } : { bookingid: id, booking: body });
        return;
      }

      const match = url.pathname.match(/^\/booking\/([^/]+)$/);
      if (match) {
        const id = /^\d+$/.test(match[1]) ? Number(match[1]) : NaN;
        const method = req.method;
        // Invalid id: answer with a status the spec documents for the method
        if (!Number.isInteger(id) || id < 1) { send(res, ['PUT', 'PATCH'].includes(method) ? 400 : 404, { reason: 'Invalid id' }); return; }
        if (method === 'GET') {
          if (bookings.has(id)) {
            const booking = bookings.get(id);
            send(res, 200, faultSet.has('wrongContract') ? { ...booking, totalprice: String(booking.totalprice) } : booking);
          } else if (faultSet.has('missingReturns200')) {
            send(res, 200, {});
          } else {
            send(res, 404, { reason: 'Not found' });
          }
          return;
        }
        if (!authed(req) && !faultSet.has('noAuthCheck')) { send(res, 403, { reason: 'Forbidden' }); return; }
        if (!bookings.has(id)) { send(res, 404, { reason: 'Not found' }); return; }
        if (method === 'DELETE') { bookings.delete(id); send(res, 201); return; }
        if (method === 'PUT' || method === 'PATCH') {
          const error = validateBooking(body, method === 'PATCH', faultSet);
          if (error) { send(res, 400, { reason: error }); return; }
          const updated = method === 'PATCH' ? { ...bookings.get(id), ...body } : body;
          bookings.set(id, updated);
          send(res, 200, updated);
          return;
        }
      }
      send(res, 404, { reason: 'No route' });
    });
  });

  return new Promise(resolve => {
    server.listen(port, '127.0.0.1', () => {
      const { port: actual } = server.address();
      resolve({
        url: `http://127.0.0.1:${actual}`,
        bookings,
        requests,
        close: () => new Promise(done => server.close(done)),
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  startMock({ port: Number(process.argv[2]) || 3999 }).then(m => console.log(`restful-booker mock on ${m.url}`));
}
