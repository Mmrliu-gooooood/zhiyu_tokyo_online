import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('tsx/package.json'))('esbuild');
await mkdir('dist-worker', { recursive: true });
await build({
  entryPoints: {
    generation: 'workers/generation/main.ts',
    migrate: 'workers/generation/migrate.ts',
  },
  outdir: 'dist-worker',
  outExtension: { '.js': '.mjs' },
  platform: 'node',
  target: 'node22',
  format: 'esm',
  bundle: true,
  packages: 'external',
  sourcemap: false,
  plugins: [
    {
      name: 'bundle-workspace-packages',
      setup(builder) {
        builder.onResolve({ filter: /^@openmaic\// }, (args) => ({
          path: fileURLToPath(import.meta.resolve(args.path)),
        }));
        builder.onResolve({ filter: /^lodash(?:\/|$)/ }, (args) => ({
          path: require.resolve(args.path),
        }));
        // The package's reference server has a CLI self-execution guard. A bundled
        // import.meta.url would equal this worker entry and accidentally start it.
        builder.onLoad(
          { filter: /[/\\]storage[/\\]dist[/\\]server[/\\]reference\.js$/ },
          async (args) => ({
            contents: (await readFile(args.path, 'utf8')).replace(
              'import.meta.url === pathToFileURL(process.argv[1]).href',
              'false',
            ),
            loader: 'js',
          }),
        );
        builder.onLoad(
          { filter: /[/\\]generation[/\\]dist[/\\](?:pbl[/\\])?prompts[/\\]loader\.js$/ },
          async (args) => ({
            contents: (await readFile(args.path, 'utf8'))
              .replace(
                "resolve(dirname(fileURLToPath(import.meta.url)), '../..')",
                "resolve(process.cwd(), 'packages/@openmaic/generation')",
              )
              .replace(
                "resolve(dirname(fileURLToPath(import.meta.url)), '../../../prompts-pbl')",
                "resolve(process.cwd(), 'packages/@openmaic/generation/prompts-pbl')",
              ),
            loader: 'js',
          }),
        );
      },
    },
  ],
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: 'info',
});
