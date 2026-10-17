import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { DUPLICATE, errorPage, installFormParser, oauthError } from './http';

async function formApp() {
  const app = Fastify();
  installFormParser(app);
  app.post('/form', async (request) => ({
    body: request.body,
    duplicates: Object.entries(request.body as object)
      .filter(([, v]) => v === DUPLICATE)
      .map(([k]) => k),
  }));
  app.get('/page', async (_request, reply) =>
    errorPage(reply, 400, '<script>alert(1)</script>', '"><img src=x onerror=alert(1)> & \''),
  );
  app.get('/err', async (_request, reply) => oauthError(reply, 400, 'invalid_request', 'nope'));
  await app.ready();
  return app;
}

const form = (app: Awaited<ReturnType<typeof formApp>>, payload: string) =>
  app.inject({
    method: 'POST',
    url: '/form',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload,
  });

describe('OAuth form parser', () => {
  it('parses parameters and flags a repeated one', async () => {
    const app = await formApp();
    const res = await form(app, 'a=1&b=2&a=3');
    expect(res.json()).toEqual({ body: { b: '2' }, duplicates: ['a'] });
    await app.close();
  });

  it('does not treat inherited property names as duplicates', async () => {
    const app = await formApp();
    const res = await form(app, 'constructor=x&toString=y&__proto__=z');
    expect(res.json().duplicates).toEqual([]);
    expect(res.json().body.constructor).toBe('x');
    await app.close();
  });
});

describe('oauthError', () => {
  it('sends RFC 6749 JSON that is never cached', async () => {
    const app = await formApp();
    const res = await app.inject({ method: 'GET', url: '/err' });
    expect(res.statusCode).toBe(400);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({ error: 'invalid_request', error_description: 'nope' });
    await app.close();
  });
});

describe('errorPage', () => {
  it('escapes the title and the message', async () => {
    const app = await formApp();
    const res = await app.inject({ method: 'GET', url: '/page' });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).not.toContain('<script>');
    expect(res.body).not.toContain('<img');
    expect(res.body).toContain('&#60;script&#62;alert(1)&#60;/script&#62;');
    expect(res.body).not.toContain('style=');
    await app.close();
  });
});
