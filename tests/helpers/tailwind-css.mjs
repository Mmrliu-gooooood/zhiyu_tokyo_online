import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import tailwind from '@tailwindcss/postcss';

// Match the plugin with its own PostCSS runtime. The workspace also installs
// a different PostCSS patch version whose duplicate declarations conflict.
const require = createRequire(import.meta.url);
const postcss = createRequire(require.resolve('@tailwindcss/postcss'))('postcss');

/**
 * Compile a browser fixture without exposing the plugin's PostCSS types.
 * @param {string} source CSS including the fixture's Tailwind source directives.
 * @param {string} from Repository-relative fixture path for resolving imports.
 * @returns {Promise<string>}
 */
export async function compileTailwindCss(source, from) {
  const result = await postcss([tailwind()]).process(source, { from: resolve(from) });
  return result.css;
}
