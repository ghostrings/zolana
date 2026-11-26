import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { RELEASE } from '../shared/src/constants.js';

/**
 * The release is how the operator (and anyone helping them) tells which code a
 * live server runs: it is in `/api/status` and in every page's footer. A
 * footer that says one release over code that is another would defeat that.
 */
describe('the release stamp', () => {
  it('is a plain version, the same in the footer as in the code', () => {
    expect(RELEASE).toMatch(/^v\d+$/);
    const footer = readFileSync(new URL('../web/partials/footer.html', import.meta.url), 'utf8');
    expect(footer).toContain(`Release ${RELEASE}<`);
    expect(footer.match(/Release v\d+/g)).toHaveLength(1);
  });

  it('is what the server puts in its status answer and its first log line', () => {
    const server = readFileSync(new URL('../server/src/index.ts', import.meta.url), 'utf8');
    expect(server).toContain('release: RELEASE,');
    expect(server).toContain('privacycash.fun ${RELEASE} listening');
  });
});
