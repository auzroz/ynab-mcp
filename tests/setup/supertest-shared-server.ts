/**
 * Test-only: make supertest reuse one listening server per test file.
 *
 * `request(app)` with an app function makes supertest start a new ephemeral
 * server for every request, each on its own connection. The HTTP suites make
 * thousands of requests per run, and every closed connection sits in
 * TIME_WAIT (30 s on macOS), which exhausts the local ports on back-to-back
 * runs (EADDRNOTAVAIL, issue #126).
 *
 * This wraps `request` so that every app function in a test file is served by
 * one shared server on 127.0.0.1:0, and every request uses a keep-alive agent,
 * so connections are reused across requests and across apps. Each request
 * carries a header naming its app; the dispatcher strips it before the app
 * sees the request. The server is closed after each test file. Assertions and
 * call sites are unchanged.
 *
 * The server starts here, at setup, and is awaited: supertest reads the
 * server's address when `request()` is called, and treats a server that is not
 * yet listening as its own to start and close again after every request.
 */
import http from 'node:http';
import { afterAll, vi } from 'vitest';

const APP_HEADER = 'x-supertest-app';

const apps = new Map<string, http.RequestListener>();
const appIds = new WeakMap<object, string>();
const keepAliveAgent = new http.Agent({ keepAlive: true });

const shared = http.createServer((req, res) => {
  const id = String(req.headers[APP_HEADER] ?? '');
  delete req.headers[APP_HEADER];
  const raw = req.rawHeaders;
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i]!.toLowerCase() === APP_HEADER) {
      raw.splice(i, 2);
      break;
    }
  }
  const app = apps.get(id);
  if (!app) {
    res.statusCode = 500;
    res.end('test harness: unknown app');
    return;
  }
  app(req, res);
});
shared.keepAliveTimeout = 60_000;
// Bind to the address the client connects to (see supertest's note on
// wildcard binds on macOS).
await new Promise<void>((resolve, reject) => {
  shared.once('error', reject);
  shared.listen(0, '127.0.0.1', () => resolve());
});
shared.unref();

afterAll(async () => {
  apps.clear();
  keepAliveAgent.destroy();
  await new Promise<void>((resolve) => {
    shared.close(() => resolve());
    shared.closeAllConnections();
  });
});

vi.mock('supertest', async (importOriginal) => {
  const mod = await importOriginal<{ default: any }>();
  const original = mod.default;

  const request: any = (app: unknown, options?: unknown) => {
    if (typeof app !== 'function' || (options && Object.keys(options as object).length > 0)) {
      return original(app, options);
    }
    let id = appIds.get(app);
    if (!id) {
      id = String(apps.size + 1);
      appIds.set(app, id);
      apps.set(id, app as http.RequestListener);
    }
    const appId = id;
    return new Proxy(original(shared), {
      get(target, prop) {
        const value = target[prop];
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          const test = value.apply(target, args);
          if (!test || typeof test.set !== 'function') return test;
          return test.set(APP_HEADER, appId).agent(keepAliveAgent);
        };
      },
    });
  };
  Object.assign(request, original);
  return { default: request, __esModule: true };
});
