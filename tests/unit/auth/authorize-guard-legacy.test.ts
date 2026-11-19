/**
 * #55b: captureRedirects() (authorize-guard-legacy.ts) catches a redirect
 * however the handler commits it: res.redirect, writeHead with headers as an
 * object or a raw array, with or without a status message, statusCode plus
 * setHeader plus end, a write before end, and flushHeaders. Each is replaced
 * by the page, with no Location, Refresh or Link header and none of the
 * redirect's body. The HTTP paths of server-legacy's /authorize itself are in
 * tests/unit/http-oauth-dcr-authorize.test.ts.
 */

import { describe, it, expect } from 'vitest';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { captureRedirects } from '../../../src/auth/authorize-guard-legacy.js';

const TARGET = 'https://evil.example/cb?error=invalid_request&state=s';

/** An app whose one route is `handler`, behind captureRedirects; the page names the captured location. */
function appWith(handler: (req: Request, res: Response) => void): express.Express {
  const app = express();
  app.use((_req, res, next) => {
    captureRedirects(res, (location) => ({
      status: 400,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Page': 'yes' },
      body: `page for ${location ?? '(none)'}`,
    }));
    next();
  });
  app.all('/', handler);
  return app;
}

function expectPage(res: request.Response, location: string | null = TARGET): void {
  expect(res.status).toBe(400);
  expect(res.headers['location']).toBeUndefined();
  expect(res.headers['refresh']).toBeUndefined();
  expect(res.headers['link']).toBeUndefined();
  expect(res.headers['x-page']).toBe('yes');
  expect(res.text).toBe(`page for ${location ?? '(none)'}`);
  expect(res.headers['content-length']).toBe(String(Buffer.byteLength(res.text)));
}

describe('captureRedirects replaces every way of committing a redirect', () => {
  it('res.redirect(302, url): the path server-legacy uses', async () => {
    expectPage(await request(appWith((_req, res) => res.redirect(302, TARGET))).get('/'));
  });

  it('res.redirect(url) with the default status', async () => {
    expectPage(await request(appWith((_req, res) => res.redirect(TARGET))).get('/'));
  });

  it('writeHead(302, { Location }) then end()', async () => {
    expectPage(
      await request(
        appWith((_req, res) => {
          res.writeHead(302, { Location: TARGET });
          res.end();
        })
      ).get('/')
    );
  });

  it('writeHead(303, statusMessage, { location, refresh }) then end(body)', async () => {
    expectPage(
      await request(
        appWith((_req, res) => {
          res.writeHead(303, 'See Other', { location: TARGET, refresh: `0;url=${TARGET}`, 'content-type': 'text/html' });
          res.end(`<a href="${TARGET}">go</a>`);
        })
      ).get('/')
    );
  });

  it('writeHead(307, raw header array) then write() and end()', async () => {
    expectPage(
      await request(
        appWith((_req, res) => {
          res.writeHead(307, ['Location', TARGET, 'Link', `<${TARGET}>; rel=next`]);
          res.write('redirect body');
          res.end();
        })
      ).post('/')
    );
  });

  it('statusCode and setHeader, then end()', async () => {
    expectPage(
      await request(
        appWith((_req, res) => {
          res.statusCode = 302;
          res.setHeader('Location', TARGET);
          res.setHeader('Refresh', `0;url=${TARGET}`);
          res.end('Found');
        })
      ).get('/')
    );
  });

  it('statusCode and setHeader, then write() before end()', async () => {
    expectPage(
      await request(
        appWith((_req, res) => {
          res.statusCode = 301;
          res.setHeader('Location', TARGET);
          res.write('part one ');
          res.end('part two');
        })
      ).get('/')
    );
  });

  it('flushHeaders() with a pending redirect', async () => {
    expectPage(
      await request(
        appWith((_req, res) => {
          res.status(302).setHeader('Location', TARGET);
          res.flushHeaders();
          res.end('Found');
        })
      ).get('/')
    );
  });

  it('a 3xx with no Location still never goes out', async () => {
    expectPage(
      await request(
        appWith((_req, res) => {
          res.status(302).end();
        })
      ).get('/'),
      null
    );
  });

  it('a HEAD request gets the page status and headers, no body', async () => {
    const res = await request(appWith((_req, res) => res.redirect(302, TARGET))).head('/');
    expect(res.status).toBe(400);
    expect(res.headers['location']).toBeUndefined();
    expect(res.headers['x-page']).toBe('yes');
  });

  it('runs the end() callback', async () => {
    let called = false;
    await request(
      appWith((_req, res) => {
        res.writeHead(302, { Location: TARGET });
        res.end(() => {
          called = true;
        });
      })
    ).get('/');
    expect(called).toBe(true);
  });
});

describe('captureRedirects with an allow predicate (a verified request)', () => {
  /** Only redirects to https://ok.example pass. */
  function appAllowing(handler: (req: Request, res: Response) => void): express.Express {
    const app = express();
    app.use((_req, res, next) => {
      captureRedirects(
        res,
        (location) => ({ status: 400, headers: { 'X-Page': 'yes' }, body: `page for ${location ?? '(none)'}` }),
        (location) => location?.startsWith('https://ok.example/') === true
      );
      next();
    });
    app.all('/', handler);
    return app;
  }

  it('lets an allowed redirect through unchanged, by redirect() or by writeHead()', async () => {
    const a = await request(appAllowing((_req, res) => res.redirect(302, 'https://ok.example/cb?error=x'))).get('/');
    expect(a.status).toBe(302);
    expect(a.headers['location']).toBe('https://ok.example/cb?error=x');
    const b = await request(
      appAllowing((_req, res) => {
        res.writeHead(302, { Location: 'https://ok.example/cb' });
        res.end();
      })
    ).get('/');
    expect(b.status).toBe(302);
    expect(b.headers['location']).toBe('https://ok.example/cb');
  });

  it('still replaces a redirect anywhere else', async () => {
    const res = await request(appAllowing((_req, res) => res.redirect(302, TARGET))).get('/');
    expect(res.status).toBe(400);
    expect(res.headers['location']).toBeUndefined();
    expect(res.text).toBe(`page for ${TARGET}`);
  });
});

describe('captureRedirects leaves other responses alone', () => {
  it('a 200 page and a 400 JSON error go out unchanged', async () => {
    const ok = await request(appWith((_req, res) => res.status(200).send('consent'))).get('/');
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('consent');
    expect(ok.headers['x-page']).toBeUndefined();
    const err = await request(appWith((_req, res) => res.status(400).json({ error: 'invalid_client' }))).get('/');
    expect(err.status).toBe(400);
    expect(err.body).toEqual({ error: 'invalid_client' });
  });

  it('a non-redirect writeHead with a Location header (201 Created) is not a redirect', async () => {
    const res = await request(
      appWith((_req, res) => {
        res.writeHead(201, { Location: '/x' });
        res.end('made');
      })
    ).post('/');
    expect(res.status).toBe(201);
    expect(res.text).toBe('made');
  });
});
