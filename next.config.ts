import { builtinModules } from 'node:module';
import type { NextConfig } from 'next';

const nodeBuiltinNames = [
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
];
const nodeBuiltinSet = new Set(nodeBuiltinNames);

const nextConfig: NextConfig = {
  output: process.env.VERCEL ? undefined : 'standalone',
  outputFileTracingIncludes: {
    '/*': [
      'lib/server/agent-runtime/import-pptx-worker.mjs',
      // Prompt loaders read Markdown at request time, so webpack cannot infer these assets.
      'lib/prompts/**',
      'packages/@openmaic/generation/templates/**',
      'packages/@openmaic/generation/snippets/**',
      'packages/@openmaic/generation/prompts-pbl/**',
      'skills/openmaic/**',
      'skills/agent-runtime/**',
    ],
  },
  typescript: {
    tsconfigPath: process.env.NODE_ENV === 'production' ? 'tsconfig.build.json' : 'tsconfig.json',
  },
  transpilePackages: ['mathml2omml', 'pptxgenjs', '@openmaic/importer'],
  // These agent packages do a runtime `import(specifier)` with a computed
  // specifier (to lazily load node:fs/os/path without breaking browser/Vite
  // builds). webpack can't statically analyze that and bundling it throws
  // "Cannot find module as expression is too dynamic" at runtime on the server
  // (the "Edit with AI" Pro-mode path), which broke the #619 keep-alive e2e.
  // Mark them server-external so Next loads them natively and the dynamic
  // import resolves as a real Node call.
  serverExternalPackages: [
    '@earendil-works/pi-ai',
    '@earendil-works/pi-agent-core',
    '@openmaic/generation',
    // Optional peers of @openmaic/storage, reached through deliberately
    // untraced dynamic imports. Externalizing keeps them out of the bundle,
    // and the static anchor in lib/persistence/asset-byte-store.ts gets them
    // traced into the standalone image -- without it, S3 mode and redirect
    // egress cannot resolve their SDK in the shipped deployment.
    '@aws-sdk/client-s3',
    '@aws-sdk/s3-request-presigner',
  ],
  experimental: {
    proxyClientMaxBodySize: '200mb',
  },
  // Windows + Tailwind v4: Turbopack's PostCSS worker hits a hard deadline on
  // first compile of app/globals.css. Official `next dev` is Turbopack; local
  // `pnpm dev` uses webpack instead. webpack must not bundle Node builtins
  // pulled in by instrumentation → agent-runtime → comfyui-image-adapter.
  webpack: (config, { isServer, webpack }) => {
    // instrumentation is also compiled into the client-development-fallback
    // graph. Mark Node builtins as missing there; the file already no-ops when
    // NEXT_RUNTIME !== 'nodejs'.
    if (!isServer) {
      // webpack rejects the node: scheme before resolve.fallback runs. Strip
      // the scheme in client graphs so the existing false fallbacks apply.
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(
          /^node:/,
          (resource: { request: string }) => {
            resource.request = resource.request.slice('node:'.length);
          },
        ),
      );
      config.resolve.fallback = {
        ...config.resolve.fallback,
        ...Object.fromEntries(
          builtinModules.map((name) => [name, false as const]),
        ),
        'pg-native': false,
      };
      return config;
    }
    const prev = config.externals;
    config.externals = [
      ...(Array.isArray(prev) ? prev : prev ? [prev] : []),
      ({ request }: { request?: string }, callback: (error?: Error | null, result?: string) => void) => {
        // The route/instrumentation graph imports undici's public entry point
        // directly. Keep it native: bundling that entry point traverses the
        // optional SQLite cache store and webpack cannot load node:sqlite.
        if (request === 'undici' || (request && nodeBuiltinSet.has(request))) {
          callback(null, `commonjs ${request}`);
          return;
        }
        callback();
      },
    ];
    return config;
  },
  async headers() {
    const extraAncestors = process.env.ALLOWED_FRAME_ANCESTORS?.trim();
    const frameAncestors = extraAncestors ? `'self' ${extraAncestors}` : "'self'";

    return [
      {
        source: '/(.*)',
        headers: [
          // X-Frame-Options only supports SAMEORIGIN (no allow-list),
          // so we omit it when custom ancestors are configured.
          ...(!extraAncestors ? [{ key: 'X-Frame-Options', value: 'SAMEORIGIN' }] : []),
          {
            key: 'Content-Security-Policy',
            value: `frame-ancestors ${frameAncestors}`,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
