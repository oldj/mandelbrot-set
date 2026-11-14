import { defineConfig } from 'vite';

/** The analytics block in index.html, from its opening marker comment to the closing one. */
const ANALYTICS = /[ \t]*<!-- analytics:[\s\S]*?<!-- \/analytics -->\n?/;

/**
 * Cross-origin isolation, so render workers can share reference tables in a
 * SharedArrayBuffer. The published site sends the same headers (vercel.json).
 */
const ISOLATION = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

export default defineConfig({
  server: { headers: ISOLATION },
  preview: { headers: ISOLATION },
  plugins: [{
    // Local development should not count as site traffic: the dev server leaves
    // the analytics block out, while `npm run build` keeps it as written.
    name: 'analytics-in-production-only',
    apply: 'serve',
    transformIndexHtml(html) {
      if (!ANALYTICS.test(html)) throw new Error('index.html: the analytics block markers are missing');
      return html.replace(ANALYTICS, '');
    },
  }],
});
