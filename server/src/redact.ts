/**
 * Keeps secrets out of anything this project prints.
 *
 * Operators paste logs and script output into chats and tickets. The RPC
 * address carries the API key in its query string, and an error raised by a
 * library can quote the address or a header. Everything the server logs and
 * every error an operator script prints goes through here first.
 */

/** Environment values that must never appear in output. */
const SECRET_NAMES = ['HELIUS_API_KEY', 'PINATA_JWT', 'JUPITER_API_KEY', 'DEPLOYER_KEY', 'PARTNER_KEY', 'DESK_SECRET_KEY', 'MODULES_SEED'] as const;

export function redact(text: string, source: Record<string, string | undefined> = process.env): string {
  let out = text.replace(/(api[-_]?key=)[^&\s"'<>)\]]+/gi, '$1[hidden]');
  for (const name of SECRET_NAMES) {
    const value = source[name]?.trim();
    // Short values are not secrets worth hiding and would blank out ordinary words.
    if (value && value.length >= 8) out = out.split(value).join(`[${name} hidden]`);
  }
  return out;
}
