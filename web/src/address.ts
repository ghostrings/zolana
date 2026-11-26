/**
 * Which address this site is being used at.
 *
 * The server answers pages opened at the addresses it was told about and at no
 * others. A page opened anywhere else still loads, but nothing it sends is
 * accepted, so it says so and points to the main address instead of failing
 * later with an error nobody can act on.
 */

/**
 * The address to send a visitor to when this page was opened at one the server
 * does not answer, or null when the page is where it should be. `origins` is
 * the server's list, main address first; an empty list (local development)
 * means any address works.
 */
export function mainAddressFor(origins: readonly string[] | undefined, here: string): string | null {
  if (!origins || origins.length === 0 || origins.includes(here)) return null;
  return origins[0] ?? null;
}

/**
 * The site's other addresses, when it runs at more than one. A browser keeps
 * each address's storage apart, so a ghost wallet made at one of them is not
 * visible at the others until its secret key is imported there.
 */
export function otherAddresses(origins: readonly string[] | undefined, here: string): string[] {
  if (!origins || !origins.includes(here)) return [];
  return origins.filter((origin) => origin !== here);
}
