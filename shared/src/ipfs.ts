/**
 * IPFS content identifiers, as far as this project needs them: telling one
 * apart from other text, and finding one inside a gateway address.
 *
 * A file pinned to IPFS has one identifier (its CID) and can be fetched from
 * any gateway as `https://<gateway>/ipfs/<cid>`. Token artwork is written into
 * metadata as such an address. Which gateway a visitor's network can reach is
 * outside this site's control, so the site serves its own copy by identifier.
 */

/** Version 0: `Qm` and 44 base58 characters. */
const CID_V0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
/** Version 1 in base32: `b` and lower-case base32, 59 characters for the usual hash. */
const CID_V1 = /^b[a-z2-7]{58,100}$/;

export function isCid(value: string): boolean {
  return CID_V0.test(value) || CID_V1.test(value);
}

/**
 * The identifier a gateway address points at, or null when the address is not
 * one. Recognised: `https://host/ipfs/<cid>`, `https://<cid>.ipfs.host/` and
 * `ipfs://<cid>`. An address with a path below the identifier names a file
 * inside a folder, which is a different thing: null.
 */
export function cidOfUrl(value: string): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 400) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol === 'ipfs:') {
    // `ipfs://<cid>` and the older `ipfs://ipfs/<cid>`. The identifier is case-sensitive, so it
    // is read from the text as written and not from the parsed host, which is lower-cased.
    const match = /^ipfs:\/\/(?:ipfs\/)?([A-Za-z0-9]+)\/?(?:[?#].*)?$/.exec(value);
    return match?.[1] !== undefined && isCid(match[1]) ? match[1] : null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const path = /^\/ipfs\/([A-Za-z0-9]+)\/?$/.exec(url.pathname);
  if (path?.[1] !== undefined) return isCid(path[1]) ? path[1] : null;
  if (url.pathname === '/' || url.pathname === '') {
    const sub = /^([a-z0-9]+)\.ipfs\./.exec(url.hostname);
    if (sub?.[1] !== undefined && CID_V1.test(sub[1])) return sub[1];
  }
  return null;
}
