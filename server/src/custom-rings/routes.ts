import express from 'express';
import { ghostRingStatus } from '../../../shared/src/custom-rings/config.js';

/** Public, read-only readiness. No registration, key ingestion, transaction or report upload routes. */
export function customRingsRouter() {
  const router = express.Router();
  router.get('/status', (_request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.json(ghostRingStatus());
  });
  router.all(/.*/, (_request, response) => {
    response.status(403).json({ error: { code: 'CUSTOM_RING_UNAVAILABLE', message: 'Custom Ring execution is not available in this release.' } });
  });
  return router;
}
