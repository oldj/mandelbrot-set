import { defineConfig } from 'vite';

/** The analytics block in index.html, from its opening marker comment to the closing one. */
const ANALYTICS = /[ \t]*<!-- analytics:[\s\S]*?<!-- \/analytics -->\n?/;

export default defineConfig({
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
