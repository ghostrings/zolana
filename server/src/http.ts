import { isIP } from 'node:net';
import type { NextFunction, Request, Response } from 'express';

export function sendError(response: Response, status: number, code: string, message: string): void {
  if (response.headersSent) return;
  response.status(status).json({ error: { code, message } });
}

/** The Express setting that says the site's public origin is https. */
export const HTTPS_ORIGIN_SETTING = 'https origin';

/** The Express setting that names the header a hosting platform puts the visitor's address in. */
export const CLIENT_IP_HEADER_SETTING = 'client ip header';

/**
 * The visitor's address, for rate limits.
 *
 * Behind a platform whose edge writes the visitor's address into a header of
 * its own and overwrites whatever the visitor sent (Cloudflare's
 * `cf-connecting-ip`, which is what Render's edge is), that header is the
 * dependable source: it does not rely on counting proxies. It is used only
 * when the operator names it (CLIENT_IP_HEADER) and only when it holds an IP
 * address. Otherwise this is Express's own answer, which follows TRUST_PROXY.
 */
export function clientIp(request: Request): string {
  const header = request.app?.get(CLIENT_IP_HEADER_SETTING) as string | undefined;
  if (header) {
    const raw = request.headers[header];
    const value = (Array.isArray(raw) ? raw[0] : raw)?.split(',')[0]?.trim();
    if (value && isIP(value) !== 0) return value;
  }
  return request.ip ?? request.socket.remoteAddress ?? 'unknown';
}

/** Fixed-window counters in memory. Enough to keep one visitor from spending the API key's quota. */
export class RateLimiter {
  readonly #windows = new Map<string, { resetAt: number; count: number }>();

  take(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const current = this.#windows.get(key);
    if (!current || current.resetAt <= now) {
      this.#windows.set(key, { resetAt: now + windowMs, count: 1 });
      if (this.#windows.size > 50_000) this.#sweep(now);
      return true;
    }
    current.count += 1;
    return current.count <= limit;
  }

  #sweep(now: number): void {
    for (const [key, value] of this.#windows) if (value.resetAt <= now) this.#windows.delete(key);
  }
}

/**
 * State-changing requests must come from this site's own pages.
 *
 * `allowedOrigins` is every address the site answers at, the main one first.
 * A browser states the address of the page a request comes from; one that is
 * not on the list is refused. That covers another website calling this API,
 * and it also covers this site opened at an address the operator has not
 * listed, which is reported through `onUnlisted` so it can be logged. With an
 * empty list (no PUBLIC_ORIGIN, local development) the request must come from
 * the address it was sent to.
 */
export function sameOrigin(allowedOrigins: readonly string[], onUnlisted?: (origin: string) => void) {
  const allowed = new Set(allowedOrigins);
  const main = allowedOrigins[0];
  return (request: Request, response: Response, next: NextFunction): void => {
    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return next();
    const origin = request.headers.origin;
    const site = request.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') {
      return sendError(response, 403, 'CROSS_ORIGIN', 'Cross-site requests are not accepted.');
    }
    if (origin !== undefined) {
      if (main === undefined) {
        if (origin !== `${request.protocol}://${request.get('host') ?? ''}`) {
          return sendError(response, 403, 'CROSS_ORIGIN', 'Cross-site requests are not accepted.');
        }
      } else if (!allowed.has(origin)) {
        onUnlisted?.(origin);
        return sendError(response, 403, 'CROSS_ORIGIN', `This site is not set up to be used at this address. Open it at ${main}.`);
      }
    }
    next();
  };
}

export function securityHeaders(request: Request, response: Response, next: NextFunction): void {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader(
    'content-security-policy',
    [
      "default-src 'self'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "connect-src 'self'",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join('; '),
  );
  // Behind a hosting platform's edge the connection to this process is plain HTTP, so `secure`
  // is false even though visitors use https. The public origin says what they really use.
  if (request.secure || request.app?.get(HTTPS_ORIGIN_SETTING)) {
    response.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

/**
 * True for a file the web build named after its own contents, such as
 * `assets/trade-DuNGBhnK.js`. Whatever is at that address never changes (a new
 * build gives it a new name), so a browser may keep it for good and never ask
 * again. A file with a plain name, such as `assets/logo.png`, is not one: it
 * can change between releases and keeps the short cache every page has.
 */
export function isHashedAsset(path: string): boolean {
  return /[\\/]assets[\\/][^\\/]+-[A-Za-z0-9_-]{8}\.(?:js|css|woff2)$/.test(path);
}

export function asyncRoute(handler: (request: Request, response: Response) => Promise<unknown>) {
  return (request: Request, response: Response, next: NextFunction): void => {
    handler(request, response).catch(next);
  };
}
