/**
 * Runs around every test file.
 *
 * Windows does not delete a file that is still open. A test that leaves its
 * database open and then removes its temp folder therefore fails there with
 * EPERM, and passes everywhere else without a word. On Linux a process can
 * list its own open files, so the same mistake is made to fail here too: when
 * a test file is done, nothing under a temp folder a test made may be open.
 */
import { readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isMainThread } from 'node:worker_threads';
import { afterAll } from 'vitest';

/** Every temp folder the tests make starts with this, under the system's temp folder. */
const TEMP_PREFIX = 'pcf-';

afterAll(() => {
  // Open files can be listed on Linux only, and they are one test file's own only when it has a process to itself.
  if (process.platform !== 'linux' || !isMainThread) return;
  let root: string;
  try {
    root = realpathSync(tmpdir());
  } catch {
    return;
  }
  const open = new Set<string>();
  for (const descriptor of readdirSync('/proc/self/fd')) {
    try {
      const target = readlinkSync(`/proc/self/fd/${descriptor}`);
      if (target.startsWith(`${root}/${TEMP_PREFIX}`)) open.add(target.replace(/ \(deleted\)$/, ''));
    } catch {
      // The descriptor was closed while the list was being read.
    }
  }
  if (open.size > 0) {
    throw new Error(
      `This test file left ${open.size} file${open.size === 1 ? '' : 's'} open in a temp folder:\n  ${[...open].join('\n  ')}\nClose the database (store.close()) before its folder is removed. Windows refuses to delete an open file, so this fails there.`,
    );
  }
});
