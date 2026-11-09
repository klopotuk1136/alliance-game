import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { test } from 'node:test';
import { Auth, SESSION_IDLE_MS } from '../auth.ts';
import { Store } from '../db.ts';
import { clientIp } from '../http.ts';

test('sessions expire after being unused for too long, and using one keeps it alive', async () => {
  const clock = { t: Date.UTC(2026, 0, 1) };
  const store = new Store(':memory:');
  const auth = new Auth(store, () => clock.t);
  const { token } = await auth.register('alice', 'secret123');

  clock.t += SESSION_IDLE_MS - 1000;
  assert.equal(auth.userByToken(token)?.username, 'alice');
  // The lookup above refreshed the session, so it survives another almost-full period.
  clock.t += SESSION_IDLE_MS - 1000;
  assert.equal(auth.userByToken(token)?.username, 'alice');
  assert.ok(!('session_at' in auth.userByToken(token)!));

  clock.t += SESSION_IDLE_MS + 1;
  assert.equal(auth.userByToken(token), undefined);
});

test('client IP comes from proxy headers only when the proxy is trusted', () => {
  const req = {
    headers: { 'x-forwarded-for': '6.6.6.6, 10.0.0.7' },
    socket: { remoteAddress: '10.0.0.1' },
  } as unknown as IncomingMessage;
  assert.equal(clientIp(req, false), '10.0.0.1');
  assert.equal(clientIp(req, true), '10.0.0.7');
  req.headers['x-real-ip'] = '5.5.5.5';
  assert.equal(clientIp(req, true), '5.5.5.5');
  assert.equal(clientIp(req, false), '10.0.0.1');
});
