import express from 'express';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { nativeMarketsRouter } from '../server/src/native-markets.js';
import { RateLimiter } from '../server/src/http.js';
import { DEPLOYMENT } from '../shared/src/ghost-markets/observe.js';

// No chain access: the missing RPC path and the explicit refusal are real HTTP responses.
async function withServer(run: (url: string) => Promise<void>) {
  const app = express();
  app.use('/api/ghost-markets', nativeMarketsRouter(undefined, new RateLimiter()));
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ghost-markets`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

describe('native program HTTP boundary', () => {
  it('returns unavailable, not a fictitious deployment or trade permission, without configured RPC', async () => {
    await withServer(async url => {
      const response = await fetch(`${url}/status`);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({programId: DEPLOYMENT.programId, marketExecution: false, privateSettlement: false, verification: 'unavailable', observation: null, reason: 'rpc-not-configured'});
    });
  });
  it('staged V33 status remains read-only and unavailable without RPC', async () => {
    await withServer(async url => {
      const response = await fetch(`${url}/v33/status`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({verification:'unavailable', observation:null, markets:null, signing:false, privateSettlement:false});
      const write = await fetch(`${url}/v33/status`, {method:'POST'});
      expect(write.status).toBe(405);
    });
  });
  it('refuses native launch, swap, transaction and activation HTTP requests', async () => {
    await withServer(async url => {
      for (const path of ['launch','swap','submit','activate','status']) {
        const response = await fetch(`${url}/${path}`, {method: 'POST', headers: {'content-type':'application/json'}, body: '{}'});
        expect(response.status).toBe(405);
        expect((await response.json()).error.code).toBe('NATIVE_MARKETS_READ_ONLY');
      }
    });
  });
  it('bounds repeated status reads with the existing rate limiter', async () => {
    await withServer(async url => {
      for (let i=0; i<20; i++) {
        const response = await fetch(`${url}/status`); expect(response.status).toBe(200); await response.json();
      }
      const limited = await fetch(`${url}/status`); expect(limited.status).toBe(429);
      expect((await limited.json()).error.code).toBe('RATE_LIMIT');
    });
  });
});
