import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * Two builds from one source.
 *
 * `SINGLE_FILE=1` inlines everything into one HTML file — that is the artifact
 * the MCP server serves as its `ui://` resource, and a single file is what the
 * spec's "hosts may review the HTML before rendering it" story depends on.
 *
 * The default build is an ordinary static site for GitHub Pages, where code
 * splitting and cacheable assets are the better trade.
 */
export default defineConfig(() => {
  const single = process.env.SINGLE_FILE === '1';

  return {
    plugins: [react(), ...(single ? [viteSingleFile()] : [])],
    // Relative URLs so the site works from a project subpath on Pages.
    base: './',
    build: {
      outDir: single ? 'dist/app' : 'dist/site',
      emptyOutDir: true,
      target: 'es2022',
      cssCodeSplit: !single,
      assetsInlineLimit: single ? 100_000_000 : 4096,
      chunkSizeWarningLimit: 2_000,
    },
  };
});
