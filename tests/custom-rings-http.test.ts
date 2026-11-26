import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { customRingsRouter } from '../server/src/custom-rings/routes.js';
import { GHOST_RING_TARGET } from '../shared/src/custom-rings/config.js';

// Isolated loopback only; no mainnet server startup, keys, RPC or external requests.
describe('custom ring readiness HTTP contract', () => {
  let server: Server | undefined;
  let base: string;
  beforeAll(async () => {
    const app = express();
    app.use('/api/custom-rings', customRingsRouter());
    const instance = app.listen(0, '127.0.0.1');
    server = instance;
    await new Promise<void>((resolve, reject) => {
      instance.once('listening', resolve);
      instance.once('error', reject);
    });
    base = `http://127.0.0.1:${(instance.address() as AddressInfo).port}/api/custom-rings`;
  });
  afterAll(async () => {
    if (server) {
      const instance = server;
      await new Promise<void>((resolve, reject) => instance.close((error) => error ? reject(error) : resolve()));
    }
  });
  it('exposes a non-cacheable, non-executing status with the exact research target', async () => {
    const response = await fetch(`${base}/status`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ target: GHOST_RING_TARGET, execution: 'local-simulation-only', canTransact: false, auditedAnalytics: false, network: null, ringProgram: null });
  });
  it.each([
    ['POST', '/status'], ['PUT', '/status'], ['PATCH', '/status'], ['DELETE', '/status'],
    ['GET', '/unknown'], ['POST', '/enroll'], ['POST', '/transfer'], ['POST', '/report'],
  ])('rejects %s %s', async (method, path) => {
    const response = await fetch(`${base}${path}`, { method });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'CUSTOM_RING_UNAVAILABLE' } });
  });
});
