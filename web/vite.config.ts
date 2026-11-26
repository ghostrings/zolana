import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Plugin, defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

const root = import.meta.dirname;

/** Replaces `<!--#name-->` with `partials/name.html`, so every page shares one shell. */
function partials(): Plugin {
  return {
    name: 'pcf-partials',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return html.replace(/<!--#([a-z]+)-->/g, (_match, name: string) => readFileSync(resolve(root, 'partials', `${name}.html`), 'utf8'));
      },
    },
  };
}

/** In development, every address under /docs is the docs page, as it is on the server. */
function docsPaths(): Plugin {
  return {
    name: 'pcf-docs-paths',
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        if (request.url && /^\/docs\/[a-z0-9-]+\/?(\?.*)?$/.test(request.url)) request.url = '/docs.html';
        next();
      });
    },
  };
}

/**
 * Has every page ask for the interface's font as soon as the page itself
 * arrives, instead of after the stylesheet has been read and found to need
 * it. The file's built name is only known once the build has named it, so the
 * line is added then. In development there is nothing to add.
 */
function preloadFont(): Plugin {
  return {
    name: 'pcf-preload-font',
    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        const file = Object.keys(context.bundle ?? {}).find((name) => /(^|\/)archivo-latin-wdth-normal-[\w-]+\.woff2$/.test(name));
        if (!file) return html;
        return {
          html,
          tags: [{ tag: 'link', attrs: { rel: 'preload', as: 'font', type: 'font/woff2', href: `/${file}`, crossorigin: true }, injectTo: 'head' }],
        };
      },
    },
  };
}

export default defineConfig({
  root,
  publicDir: resolve(root, 'public'),
  plugins: [
    partials(),
    docsPaths(),
    preloadFont(),
    // The Meteora SDKs and web3.js expect Node's Buffer and process in the browser.
    nodePolyfills({ include: ['buffer', 'process', 'util', 'stream', 'events', 'crypto'], globals: { Buffer: true, process: true, global: true } }),
  ],
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    // Nothing is inlined as a data: address. The site's content policy lets fonts load from this origin only,
    // so a small font file written into the stylesheet would be refused by the browser.
    assetsInlineLimit: 0,
    // The Rings hasher ships its WASM inlined; the trading pages load one large chunk, the market, protocol and docs pages do not.
    chunkSizeWarningLimit: 8000,
    rollupOptions: {
      input: {
        index: resolve(root, 'index.html'),
        create: resolve(root, 'create.html'),
        token: resolve(root, 'token.html'),
        swap: resolve(root, 'swap.html'),
        rings: resolve(root, 'rings.html'),
        ghost: resolve(root, 'ghost.html'),
        'ghost-intelligence': resolve(root, 'ghost-intelligence.html'),
        wallet: resolve(root, 'wallet.html'),
        view: resolve(root, 'view.html'),
        prvmax: resolve(root, 'prvmax.html'),
        protocol: resolve(root, 'protocol.html'),
        docs: resolve(root, 'docs.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      '/u': 'http://127.0.0.1:8080',
    },
  },
});
