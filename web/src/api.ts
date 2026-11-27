import type {
  ApiErrorBody,
  ModuleCheckRequest,
  ModulePrepareRequest,
  ModulePrepareResponse,
  PlatformStats,
  StatusResponse,
  TokenDetail,
  TokenPageResponse,
  TokenSummary,
} from '../../shared/src/api.js';
import type { CustomRingsView, RingAddressView, RingAssetPage, RingAssetView, RingFeed, RingOverview } from '../../shared/src/rings-api.js';
import type {
  GhostPrepareRequest,
  GhostPrepareResponse,
  GhostQuote,
  GhostSubmitRequest,
  GhostSubmitResponse,
} from '../../shared/src/ghost.js';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { credentials: 'omit', ...init });
  } catch {
    throw new ApiError(0, 'OFFLINE', 'The server could not be reached. Check your connection.');
  }
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const error = (body as ApiErrorBody | null)?.error;
    throw new ApiError(response.status, error?.code ?? 'HTTP', error?.message ?? `The server answered ${response.status}.`);
  }
  return body as T;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

let statusPromise: Promise<StatusResponse> | undefined;

export const api = {
  status(): Promise<StatusResponse> {
    statusPromise ??= request<StatusResponse>('/status').catch((error) => {
      statusPromise = undefined;
      throw error;
    });
    return statusPromise;
  },
  stats: () => request<PlatformStats>('/stats'),
  /** One page of the market: twenty-four tokens, in the order and for the search asked. */
  tokenPage(input: { page: number; sort: string; query: string; pair?: string }): Promise<TokenPageResponse> {
    const params = new URLSearchParams({ page: String(input.page), sort: input.sort });
    if (input.query) params.set('q', input.query);
    if (input.pair) params.set('pair', input.pair);
    return request<TokenPageResponse>(`/tokens?${params.toString()}`);
  },
  /** The listed tokens among these mints. Mints that were not launched here are simply absent. */
  async tokensByMints(mints: readonly string[]): Promise<TokenSummary[]> {
    const unique = [...new Set(mints)];
    const found: TokenSummary[] = [];
    for (let start = 0; start < unique.length; start += 100) {
      const body = await request<{ tokens: TokenSummary[] }>(`/tokens?mints=${unique.slice(start, start + 100).map(encodeURIComponent).join(',')}`);
      found.push(...body.tokens);
    }
    return found;
  },
  tokensByCreator: (creator: string) => request<{ tokens: TokenSummary[] }>(`/tokens?creator=${encodeURIComponent(creator)}`).then((body) => body.tokens),
  token: (mint: string) => request<TokenDetail>(`/tokens/${encodeURIComponent(mint)}`),
  /**
   * Has the server read a token from chain now. `memo` is the fee module
   * settings the page has just put on chain, if any: the server takes them
   * only when the chain agrees.
   */
  refreshToken: (mint: string, memo?: string) =>
    request<TokenSummary | null>(`/tokens/${encodeURIComponent(mint)}/refresh`, memo === undefined ? { method: 'POST' } : json({ memo })),
  /** Has the server look over fee module settings before a launch: the shares, and what each wallet is on chain. */
  checkModules: (input: ModuleCheckRequest) => request<{ ok: true }>('/modules/check', json(input)),
  /** Asks the server where a token's creator role must go for these fee module settings to apply. Switches nothing on. */
  prepareModules: (input: ModulePrepareRequest) => request<ModulePrepareResponse>('/modules/prepare', json(input)),
  uploadImage: (file: File) =>
    request<{ url: string }>('/uploads/image', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    }).then((body) => body.url),
  uploadMetadata: (metadata: Record<string, string>) => request<{ uri: string }>('/uploads/metadata', json(metadata)).then((body) => body.uri),
  /**
   * Jupiter's answer for one conversion, relayed by this site's server. It is
   * somebody else's data: the caller reads and checks it (`readBuild`) before
   * anything is built from it.
   */
  convertBuild: (query: URLSearchParams) => request<unknown>(`/convert/build?${query.toString()}`),
  /* The Rings explorer: public chain data this site's server has read. Nothing about the visitor is sent with these. */
  ringOverview: () => request<RingOverview>('/rings/overview'),
  /** The public register of custom rings, as this site's server last read it from chain. */
  ringCustom: () => request<CustomRingsView>('/rings/custom'),
  ringTokens(input: { sort: string; page: number; query?: string }): Promise<RingAssetPage> {
    const params = new URLSearchParams({ sort: input.sort, page: String(input.page) });
    if (input.query) params.set('q', input.query);
    return request<RingAssetPage>(`/rings/tokens?${params.toString()}`);
  },
  ringFeed(input: { kind?: string; before?: string; mint?: string } = {}): Promise<RingFeed> {
    const params = new URLSearchParams();
    if (input.kind) params.set('kind', input.kind);
    if (input.before) params.set('before', input.before);
    if (input.mint) params.set('mint', input.mint);
    const text = params.toString();
    return request<RingFeed>(`/rings/feed${text ? `?${text}` : ''}`);
  },
  ringAddress: (address: string, before?: string) =>
    request<RingAddressView>(`/rings/address/${encodeURIComponent(address)}${before ? `?before=${encodeURIComponent(before)}` : ''}`),
  ringToken: (mint: string) => request<RingAssetView>(`/rings/token/${encodeURIComponent(mint)}`),
  deskQuote: (input: { side: 'buy' | 'sell'; mint: string; amount: string }) => request<GhostQuote>('/desk/quote', json(input)),
  deskPrepare: (input: GhostPrepareRequest) => request<GhostPrepareResponse>('/desk/prepare', json(input)),
  deskSubmit: (input: GhostSubmitRequest) => request<GhostSubmitResponse>('/desk/submit', json(input)),
};
