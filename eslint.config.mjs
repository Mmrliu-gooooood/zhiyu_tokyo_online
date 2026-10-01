import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

// Text models are reached only through the model gateway (@/lib/model-gateway,
// ADR 0019 / plan 3.2; originally #1003 for the AI SDK). Static and namespace
// imports are handled by @typescript-eslint/no-restricted-imports further down; a
// DYNAMIC import is an ImportExpression, which no-restricted-imports cannot see,
// so it needs no-restricted-syntax. That key is configured per-block and flat
// config replaces rule options rather than merging them, so the ban lives here
// and is spread into every block that sets the key, instead of one repo-wide
// block that would silently drop those blocks' own module boundaries.
const GATEWAY_BYPASS_MESSAGE =
  'Call text models through the model gateway (@/lib/model-gateway: gateway.stream / complete / runToolLoop). The gateway is where credentials, quota, usage accounting, thinking and error classification are applied; a direct model SDK or pi-ai runtime import skips all of them.';
const MODEL_RUNTIME_DYNAMIC_IMPORT_BAN = [
  {
    selector: "ImportExpression > Literal[value='ai']",
    message: `${GATEWAY_BYPASS_MESSAGE} (dynamic import('ai'))`,
  },
  {
    selector: "ImportExpression > TemplateLiteral > TemplateElement[value.cooked='ai']",
    message: `${GATEWAY_BYPASS_MESSAGE} (template-literal import of 'ai')`,
  },
  {
    selector: 'ImportExpression > Literal[value=/^@ai-sdk\\//]',
    message: `${GATEWAY_BYPASS_MESSAGE} (dynamic import of an @ai-sdk provider)`,
  },
  {
    selector: 'ImportExpression > Literal[value=/^@earendil-works\\/pi-ai(?:\\/|$)/]',
    message: `${GATEWAY_BYPASS_MESSAGE} (dynamic import of the pi-ai runtime)`,
  },
  {
    selector:
      'ImportExpression > TemplateLiteral > TemplateElement[value.cooked=/^@earendil-works\\/pi-ai(?:\\/|$)/]',
    message: `${GATEWAY_BYPASS_MESSAGE} (template-literal import of the pi-ai runtime)`,
  },
];

// The only production modules allowed to touch model runtimes directly (plan 3.2).
const MODEL_RUNTIME_ALLOWED = [
  // The gateway's single pi-ai runtime module, its pi-agent-core / LangChain
  // adapters and its test doubles.
  'lib/model-gateway/runtime/pi-registry.ts',
  'lib/model-gateway/adapters/**',
  'lib/model-gateway/testing/**',
  // Exceptions that stay on the AI SDK (D13): Claude web search (provider
  // built-in tool) and speech recognition (transcription API).
  'lib/web-search/claude.ts',
  'lib/audio/asr-providers.ts',
  // Packaging smoke test: imports the runtime to prove it resolves in the bundle.
  'scripts/smoke-pi-runtime.mjs',
  // Legacy text stack, deleted in P3-6 (plan 3.15).
  'lib/ai/llm.ts',
  'lib/ai/providers.ts',
  'lib/ai/reasoning-sse.ts',
  'lib/ai/azure.ts',
  'lib/agent/runtime/stream-fn.ts',
  'lib/orchestration/ai-sdk-adapter.ts',
  'lib/server/generation-jobs/model-quota.ts',
];

// Browser-reachable code may use the gateway's isomorphic surface only: types
// (type-only) and the catalog. Everything else under lib/model-gateway pulls
// in the server runtime (pi-ai, credentials, transport).
const CLIENT_MODEL_GATEWAY_PATTERN = {
  // Anything under @/lib/model-gateway except `types` and `catalog/*`.
  regex: '^@/lib/model-gateway(?:/(?!types$|catalog(?:/|$)).*)?$',
  message:
    'Client code may import only @/lib/model-gateway/types (types) and @/lib/model-gateway/catalog/*; the rest of the gateway is server-only (pi-ai runtime, credentials).',
};

const POLLED_TASK_SERVER_CARRIER_PATTERN = {
  group: [
    '@/lib/server/generation-jobs/polled-task-persistence',
    '**/server/generation-jobs/polled-task-persistence',
  ],
  message:
    'Client-reachable code must read task persistence through @/lib/media/polled-task-context; the AsyncLocalStorage carrier is server-only.',
};

const POLLED_TASK_SERVER_CARRIER_DYNAMIC_IMPORT_BAN = [
  {
    selector:
      'ImportExpression > Literal[value=/server\\/generation-jobs\\/polled-task-persistence$/]',
    message:
      'Client-reachable code must not dynamically import the server-only AsyncLocalStorage carrier. Read through @/lib/media/polled-task-context instead.',
  },
  {
    selector:
      'ImportExpression > TemplateLiteral > TemplateElement[value.cooked=/server\\/generation-jobs\\/polled-task-persistence$/]',
    message:
      'Client-reachable code must not dynamically import the server-only AsyncLocalStorage carrier.',
  },
  {
    selector:
      "CallExpression[callee.name='require'] > Literal.arguments[value=/server\\/generation-jobs\\/polled-task-persistence$/]",
    message: 'Client-reachable code must not require the server-only AsyncLocalStorage carrier.',
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    // Third-party / vendored packages (not our code):
    'packages/docs/**',
    'packages/mathml2omml/**',
    'packages/pptxgenjs/**',
    // Our own @openmaic/* packages: lint the source, but skip build output,
    // installed deps, and the vendored JS sources under importer/src1.
    'packages/@openmaic/*/dist/**',
    'packages/@openmaic/*/node_modules/**',
    'packages/@openmaic/importer/src1/**',
    // Generated importer bundle copied into public/ by the sync script (postinstall):
    'public/vendor/**',
    // Claude Code local files:
    '.claude/**',
    '.superpowers/**',
    '.worktrees/**',
    '.scratch/**',
    // Playwright e2e tests (not React code):
    'e2e/**',
    // Isolated MP4 render service: its own package, tsconfig, and Node-only
    // deps (@hyperframes/producer). Linted/typechecked under render-service/.
    'render-service/**',
  ]),
  {
    rules: {
      // Dynamic AI-generated image URLs from various providers are incompatible
      // with next/image (requires known dimensions and whitelisted domains).
      '@next/next/no-img-element': 'off',
      // Allow unused vars/args prefixed with _ (common convention for intentionally
      // unused destructured values, callback params, etc.)
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },
  // Client boundary: the durable media task carrier owns a Node
  // AsyncLocalStorage instance and must stay behind lib/server. Shared polling
  // code reads it through lib/media/polled-task-context instead. Keeping this
  // as a lint error prevents a future client entry from pulling node:async_hooks
  // back into a production browser chunk.
  {
    files: [
      'app/**/*.{ts,tsx,js,jsx,mjs,cjs}',
      'components/**/*.{ts,tsx,js,jsx,mjs,cjs}',
      'lib/**/*.{ts,tsx,js,jsx,mjs,cjs}',
    ],
    ignores: ['app/api/**', 'lib/server/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [POLLED_TASK_SERVER_CARRIER_PATTERN],
        },
      ],
    },
  },
  // Model gateway client boundary (plan 3.2). Same rule key as the block above,
  // so its pattern is repeated here for the files both blocks match.
  {
    files: [
      'components/**/*.{ts,tsx,js,jsx,mjs,cjs}',
      'lib/store/**/*.{ts,tsx,js,jsx,mjs,cjs}',
      'lib/utils/**/*.{ts,tsx,js,jsx,mjs,cjs}',
      'app/**/page.{ts,tsx,js,jsx}',
      'app/**/layout.{ts,tsx,js,jsx}',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [POLLED_TASK_SERVER_CARRIER_PATTERN, CLIENT_MODEL_GATEWAY_PATTERN] },
      ],
    },
  },
  // Package boundary (machine-enforced): @openmaic/renderer is a standalone,
  // app-agnostic package. It must never reach back into the host app through
  // the `@/…` path alias, so a deadline can't punch a "temporary"
  // store/undo/media dependency through the package API. Host concerns
  // (document + undo ownership, media resolution, i18n, hotkeys) are injected
  // via props/callbacks instead.
  //
  // Policy: the package must contain NO `@/…` path-alias string at all. `@/` is
  // exclusively the host-app import alias, and the package authors zero such
  // strings, so we match the string prefix wherever it appears rather than
  // chasing individual call shapes. This is complete against every single-literal
  // module-reference form — static / `import type` / `export … from`, dynamic
  // `import()`, `require()`, `require.resolve()`, `import.meta.resolve()`, their
  // computed-property (`require['resolve']`) and template-literal variants, and
  // string-concatenation operands (`'@/lib/' + x`) — because all of them contain
  // a `@/` literal. One rule, one report per violation.
  //
  // Out of scope (undecidable by lint, evasion-only): a specifier assembled
  // entirely from non-`@/` pieces (`'@' + '/x'`, a variable) and relative parent
  // escapes (`../../app`). Those are caught by building/publishing the package in
  // isolation (only `@openmaic/dsl` + declared peers external), not by this rule.
  {
    files: ['packages/@openmaic/renderer/**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...MODEL_RUNTIME_DYNAMIC_IMPORT_BAN,
        {
          selector: 'Literal[value=/^@\\//]',
          message:
            '@openmaic/renderer must not reference a host-app path (@/…). This package authors no `@/…` strings — depend only on @openmaic/dsl and declared peers, and inject host concerns (stores, undo, media resolution, i18n, hotkeys) via props/callbacks.',
        },
        {
          selector: 'TemplateElement[value.cooked=/^@\\//]',
          message:
            '@openmaic/renderer must not reference a host-app path (@/…) in a template literal. Depend only on @openmaic/dsl and declared peers; inject host concerns via props/callbacks.',
        },
      ],
    },
  },
  // Package boundary (machine-enforced): @openmaic/storage is a standalone,
  // app-agnostic persistence package. Same policy as the @openmaic/renderer
  // boundary above — it must contain NO `@/…` host-app path-alias string, so a
  // deadline can't punch a "temporary" host dependency through the package API.
  // It depends only on @openmaic/dsl; host wiring (which store persists where)
  // lives in the app, which imports the package, never the reverse.
  {
    files: ['packages/@openmaic/storage/**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...MODEL_RUNTIME_DYNAMIC_IMPORT_BAN,
        {
          selector: 'Literal[value=/^@\\//]',
          message:
            '@openmaic/storage must not reference a host-app path (@/…). This package authors no `@/…` strings — depend only on @openmaic/dsl. The app wires its stores through the package, not the reverse.',
        },
        {
          selector: 'TemplateElement[value.cooked=/^@\\//]',
          message:
            '@openmaic/storage must not reference a host-app path (@/…) in a template literal. Depend only on @openmaic/dsl.',
        },
      ],
    },
  },
  // Package boundary (machine-enforced): @openmaic/generation is a standalone,
  // app-agnostic package. Every package code directory is covered so future
  // scripts and tooling cannot bypass the boundary. The leaf dependency list
  // mirrors the package's declared dependencies and is widened only together
  // with package.json.
  {
    files: ['packages/@openmaic/generation/**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...MODEL_RUNTIME_DYNAMIC_IMPORT_BAN,
        {
          selector: 'Literal[value=/^@\\//]',
          message:
            '@openmaic/generation must not reference a host-app path (@/…). Depend only on @openmaic/dsl, Node built-ins, and relative modules.',
        },
        {
          selector: 'TemplateElement[value.cooked=/^@\\//]',
          message:
            '@openmaic/generation must not reference a host-app path (@/…) in a template literal.',
        },
        {
          selector:
            'ImportDeclaration > Literal.source[value=/^(?!@openmaic\\/dsl(\\/|$)|(jsonrepair|katex|nanoid|partial-json)(\\/|$)|node:|\\.\\.?\\/).+/]',
          message:
            '@openmaic/generation may import only from @openmaic/dsl, approved leaf runtime dependencies, Node built-ins, or relative modules (./… or ../…).',
        },
        {
          selector:
            'ExportNamedDeclaration > Literal.source[value=/^(?!@openmaic\\/dsl(\\/|$)|(jsonrepair|katex|nanoid|partial-json)(\\/|$)|node:|\\.\\.?\\/).+/]',
          message:
            '@openmaic/generation may re-export only from @openmaic/dsl, approved leaf runtime dependencies, Node built-ins, or relative modules (./… or ../…).',
        },
        {
          selector:
            'ExportAllDeclaration > Literal.source[value=/^(?!@openmaic\\/dsl(\\/|$)|(jsonrepair|katex|nanoid|partial-json)(\\/|$)|node:|\\.\\.?\\/).+/]',
          message:
            '@openmaic/generation may re-export only from @openmaic/dsl, approved leaf runtime dependencies, Node built-ins, or relative modules (./… or ../…).',
        },
        {
          selector: 'ImportExpression',
          message:
            '@openmaic/generation must use static imports from @openmaic/dsl, Node built-ins, or relative modules.',
        },
        {
          selector: "CallExpression[callee.name='require']",
          message: '@openmaic/generation must not use require().',
        },
      ],
    },
  },
  // Flat config replaces a rule's complete options in later matching blocks.
  // Repeat every restriction for tests (and their Vitest config), changing only
  // the static import allowlist to add the package public entry and Vitest.
  {
    files: [
      'packages/@openmaic/generation/test/**/*.{ts,tsx,js,jsx,mjs,cjs}',
      'packages/@openmaic/generation/vitest.config.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...MODEL_RUNTIME_DYNAMIC_IMPORT_BAN,
        {
          selector: 'Literal[value=/^@\\//]',
          message:
            '@openmaic/generation tests and test config must not reference a host-app path (@/…). Read app prompt assets as files for parity checks.',
        },
        {
          selector: 'TemplateElement[value.cooked=/^@\\//]',
          message:
            '@openmaic/generation tests and test config must not reference a host-app path (@/…) in a template literal.',
        },
        {
          selector:
            'ImportDeclaration > Literal.source[value=/^(?!@openmaic\\/dsl(\\/|$)|@openmaic\\/generation(\\/|$)|node:|vitest(\\/|$)|\\.\\.?\\/).+/]',
          message:
            '@openmaic/generation tests and test config may import only @openmaic/dsl, the package public entry, Node built-ins, Vitest, or relative modules (./… or ../…).',
        },
        {
          selector:
            'ExportNamedDeclaration > Literal.source[value=/^(?!@openmaic\\/dsl(\\/|$)|@openmaic\\/generation(\\/|$)|node:|vitest(\\/|$)|\\.\\.?\\/).+/]',
          message:
            '@openmaic/generation tests and test config may re-export only @openmaic/dsl, the package public entry, Node built-ins, Vitest, or relative modules (./… or ../…).',
        },
        {
          selector:
            'ExportAllDeclaration > Literal.source[value=/^(?!@openmaic\\/dsl(\\/|$)|@openmaic\\/generation(\\/|$)|node:|vitest(\\/|$)|\\.\\.?\\/).+/]',
          message:
            '@openmaic/generation tests and test config may re-export only @openmaic/dsl, the package public entry, Node built-ins, Vitest, or relative modules (./… or ../…).',
        },
        {
          selector: 'ImportExpression',
          message: '@openmaic/generation tests and test config must use static imports.',
        },
        {
          selector: "CallExpression[callee.name='require']",
          message: '@openmaic/generation tests and test config must not use require().',
        },
      ],
    },
  },
  // Module boundary (machine-enforced): lib/choreography is the shared
  // orchestration spec (timing + action timeline). It lives in the app (not a
  // package) because its semantics co-evolve with the playback engine, but it
  // must stay pure so the classroom-video exporter can interpret it in a pure
  // Node environment. Two guards, mirroring the package boundaries above:
  //   1. NO `@/…` host-app path-alias string — it authors none; it depends only
  //      on @openmaic/dsl (types + the fire-and-forget partition) and relative
  //      siblings. The app and exporter import it, never the reverse.
  //   2. NO React / DOM / render-backend runtime import (react, react-dom, gsap,
  //      framer-motion, motion) — these are bare specifiers the `@/` rule can't
  //      see. A descriptor describes animation; it never renders it.
  {
    files: ['lib/choreography/**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/^@\\//]',
          message:
            'lib/choreography must not reference a host-app path (@/…). It authors no `@/…` strings — depend only on @openmaic/dsl and relative siblings, so the exporter can interpret it in pure Node. The app and exporter import it, not the reverse.',
        },
        {
          selector: 'TemplateElement[value.cooked=/^@\\//]',
          message:
            'lib/choreography must not reference a host-app path (@/…) in a template literal. Depend only on @openmaic/dsl and relative siblings.',
        },
        // Import allowlist (static imports/re-exports): the ONLY permitted
        // sources are `@openmaic/dsl`(/subpaths), `zod`, and in-folder relatives
        // (`./…`). Anything else — a parent-escape `../…` reaching back into the
        // app, or any other bare package — fails. Enforced on Import/Export
        // source string nodes via a negative-lookahead so the guard is a true
        // allowlist, not a blocklist of known-bad names.
        {
          selector:
            'ImportDeclaration > Literal.source[value=/^(?!@openmaic\\/dsl(\\/|$)|zod(\\/|$)|\\.\\/).+/]',
          message:
            'lib/choreography may import only from @openmaic/dsl, zod, or in-folder relatives (./…). No parent-escape (../…) into the app and no other packages — keep it pure so the exporter runs in plain Node.',
        },
        {
          selector:
            'ExportNamedDeclaration > Literal.source[value=/^(?!@openmaic\\/dsl(\\/|$)|zod(\\/|$)|\\.\\/).+/]',
          message:
            'lib/choreography may re-export only from @openmaic/dsl, zod, or in-folder relatives (./…).',
        },
        {
          selector:
            'ExportAllDeclaration > Literal.source[value=/^(?!@openmaic\\/dsl(\\/|$)|zod(\\/|$)|\\.\\/).+/]',
          message:
            'lib/choreography may re-export only from @openmaic/dsl, zod, or in-folder relatives (./…).',
        },
        // No dynamic import() or require() — they bypass the static allowlist and
        // can pull in a render backend at runtime.
        {
          selector: 'ImportExpression',
          message:
            'lib/choreography must not use dynamic import() — it bypasses the static import allowlist. Use a top-level import from @openmaic/dsl, zod, or a relative sibling.',
        },
        {
          selector: "CallExpression[callee.name='require']",
          message:
            'lib/choreography must not use require() — it bypasses the static import allowlist.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'react',
                'react-dom',
                'react/*',
                'react-dom/*',
                'gsap',
                'gsap/*',
                'framer-motion',
                'motion',
                'motion/*',
              ],
              message:
                'lib/choreography must stay render-backend-agnostic (pure Node): no React / DOM / GSAP / framer-motion. It describes timing and animation as data; the app effect components and the exporter render it.',
            },
          ],
        },
      ],
    },
  },
  // Module boundary (machine-enforced): lib/video-export is the classroom-video
  // compiler (issue #864). It produces the VideoTimeline IR with pure passes and
  // must stay interpretable in pure Node (no FFmpeg / Chrome / DOM), so runtime
  // app state enters only through the injected TimingProbe / AssetSource. Guards,
  // mirroring lib/choreography: no `@/…` host path, no React/DOM/render backend,
  // no dynamic import()/require(), and an import-source allowlist.
  //
  // The relative-path allowance is DEPTH-SPECIFIC, because a single `../…` means
  // different things at different depths: from a module-root file it escapes the
  // module (`lib/video-export/../action` = `lib/action`), but from `passes/` it
  // stays inside (`lib/video-export/passes/../ir` = `lib/video-export/ir`). So
  // the boundary is split into two disjoint file scopes (root `*` does not match
  // `passes/`), each with its own source allowlist; everything else is shared and
  // duplicated verbatim.
  //
  // Root files — lib/video-export/*.ts: relative imports may only be `./…`
  // (children) or the declared cross-module dep `../choreography`. Any other
  // `../…` (e.g. `../action/engine`) escapes the module and is rejected.
  {
    files: ['lib/video-export/*.{ts,tsx,js,jsx,mjs,cjs}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/^@\\//]',
          message:
            'lib/video-export must not reference a host-app path (@/…). Live app state enters only through the injected TimingProbe / AssetSource — depend only on @openmaic/dsl, zod, ../choreography, and relative siblings, so the compiler runs in pure Node.',
        },
        {
          selector: 'TemplateElement[value.cooked=/^@\\//]',
          message:
            'lib/video-export must not reference a host-app path (@/…) in a template literal. Depend only on @openmaic/dsl, zod, ../choreography, and relative siblings.',
        },
        {
          selector:
            'ImportDeclaration > Literal.source[value=/^(?!@openmaic\\/dsl(\\/|$)|zod(\\/|$)|\\.\\/|\\.\\.\\/choreography(\\/|$)).+/]',
          message:
            'lib/video-export root files may import only from @openmaic/dsl, zod, ../choreography, or in-module children (./…). A ../… into anything but ../choreography escapes the module and is rejected.',
        },
        {
          selector:
            'ExportNamedDeclaration > Literal.source[value=/^(?!@openmaic\\/dsl(\\/|$)|zod(\\/|$)|\\.\\/|\\.\\.\\/choreography(\\/|$)).+/]',
          message:
            'lib/video-export root files may re-export only from @openmaic/dsl, zod, ../choreography, or in-module children (./…).',
        },
        {
          selector:
            'ExportAllDeclaration > Literal.source[value=/^(?!@openmaic\\/dsl(\\/|$)|zod(\\/|$)|\\.\\/|\\.\\.\\/choreography(\\/|$)).+/]',
          message:
            'lib/video-export root files may re-export only from @openmaic/dsl, zod, ../choreography, or in-module children (./…).',
        },
        {
          selector: 'ImportExpression',
          message:
            'lib/video-export must not use dynamic import() — it bypasses the static import allowlist. Use a top-level import from @openmaic/dsl, zod, ../choreography, or a relative sibling.',
        },
        {
          selector: "CallExpression[callee.name='require']",
          message:
            'lib/video-export must not use require() — it bypasses the static import allowlist.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'react',
                'react-dom',
                'react/*',
                'react-dom/*',
                'gsap',
                'gsap/*',
                'framer-motion',
                'motion',
                'motion/*',
              ],
              message:
                'lib/video-export must stay render-backend-agnostic (pure Node): no React / DOM / GSAP / framer-motion. The compiler emits the IR as data; the downstream Hyperframes emitter renders it.',
            },
          ],
        },
      ],
    },
  },
  // Nested files — lib/video-export/{passes,legacy}/**: one level deeper, so a single `../…`
  // reaches a module-root file and STAYS inside the module; only a two-level
  // `../../…` escapes, and that is allowed solely for `../../choreography`.
  {
    files: [
      'lib/video-export/passes/**/*.{ts,tsx,js,jsx,mjs,cjs}',
      'lib/video-export/legacy/**/*.{ts,tsx,js,jsx,mjs,cjs}',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/^@\\//]',
          message:
            'lib/video-export must not reference a host-app path (@/…). Live app state enters only through the injected TimingProbe / AssetSource — depend only on @openmaic/dsl, zod, ../../choreography, and relative siblings, so the compiler runs in pure Node.',
        },
        {
          selector: 'TemplateElement[value.cooked=/^@\\//]',
          message:
            'lib/video-export must not reference a host-app path (@/…) in a template literal. Depend only on @openmaic/dsl, zod, ../../choreography, and relative siblings.',
        },
        // `./…` (children) and a single `../…` (a pass reaching a module-root
        // file, which stays inside lib/video-export) are allowed; a two-level
        // `../../…` escape is rejected UNLESS it is exactly `../../choreography`.
        {
          selector:
            'ImportDeclaration > Literal.source[value=/^(?!@openmaic\\/dsl(\\/|$)|zod(\\/|$)|\\.\\/|\\.\\.\\/\\.\\.\\/choreography(\\/|$)|\\.\\.\\/(?!\\.\\.\\/)).+/]',
          message:
            'lib/video-export passes may import only from @openmaic/dsl, zod, ../../choreography, or in-module relatives (./… or a single ../… that stays inside the module). A ../../ escape into the rest of the app is rejected.',
        },
        {
          selector:
            'ExportNamedDeclaration > Literal.source[value=/^(?!@openmaic\\/dsl(\\/|$)|zod(\\/|$)|\\.\\/|\\.\\.\\/\\.\\.\\/choreography(\\/|$)|\\.\\.\\/(?!\\.\\.\\/)).+/]',
          message:
            'lib/video-export passes may re-export only from @openmaic/dsl, zod, ../../choreography, or in-module relatives.',
        },
        {
          selector:
            'ExportAllDeclaration > Literal.source[value=/^(?!@openmaic\\/dsl(\\/|$)|zod(\\/|$)|\\.\\/|\\.\\.\\/\\.\\.\\/choreography(\\/|$)|\\.\\.\\/(?!\\.\\.\\/)).+/]',
          message:
            'lib/video-export passes may re-export only from @openmaic/dsl, zod, ../../choreography, or in-module relatives.',
        },
        {
          selector: 'ImportExpression',
          message:
            'lib/video-export must not use dynamic import() — it bypasses the static import allowlist. Use a top-level import from @openmaic/dsl, zod, ../../choreography, or a relative sibling.',
        },
        {
          selector: "CallExpression[callee.name='require']",
          message:
            'lib/video-export must not use require() — it bypasses the static import allowlist.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'react',
                'react-dom',
                'react/*',
                'react-dom/*',
                'gsap',
                'gsap/*',
                'framer-motion',
                'motion',
                'motion/*',
              ],
              message:
                'lib/video-export must stay render-backend-agnostic (pure Node): no React / DOM / GSAP / framer-motion. The compiler emits the IR as data; the downstream Hyperframes emitter renders it.',
            },
          ],
        },
      ],
    },
  },
  // Hyperframes emitter boundary. This subtree stays pure and backend-text-only:
  // it may reach other video-export modules through one-level relatives, and it
  // has one intentional app-module dependency on the existing pure Quiz math
  // renderer so classroom and exported formulas cannot drift. Every other
  // two-level escape is rejected.
  {
    files: ['lib/video-export/emit-hyperframes/**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'ImportDeclaration > Literal.source[value=/^(?!\\.\\/|\\.\\.\\/(?!\\.\\.\\/)|\\.\\.\\/\\.\\.\\/quiz\\/math-text$).+/]',
          message:
            'The Hyperframes emitter may import only in-module relatives (./… or one ../…) and the shared pure Quiz renderer ../../quiz/math-text.',
        },
        {
          selector:
            'ExportNamedDeclaration > Literal.source[value=/^(?!\\.\\/|\\.\\.\\/(?!\\.\\.\\/)|\\.\\.\\/\\.\\.\\/quiz\\/math-text$).+/]',
          message:
            'The Hyperframes emitter may re-export only in-module relatives (./… or one ../…) and ../../quiz/math-text.',
        },
        {
          selector:
            'ExportAllDeclaration > Literal.source[value=/^(?!\\.\\/|\\.\\.\\/(?!\\.\\.\\/)|\\.\\.\\/\\.\\.\\/quiz\\/math-text$).+/]',
          message:
            'The Hyperframes emitter may re-export only in-module relatives (./… or one ../…) and ../../quiz/math-text.',
        },
        {
          selector: 'ImportExpression',
          message:
            'The Hyperframes emitter must not use dynamic import() — it bypasses the static import allowlist.',
        },
        {
          selector: "CallExpression[callee.name='require']",
          message:
            'The Hyperframes emitter must not use require() — it bypasses the static import allowlist.',
        },
      ],
    },
  },
  // PBL v2 operations boundary: leaf/shared kernel operations may be used by
  // composite runtime operations, but the kernel must never reach back into
  // operations/runtime. Match the module string in every literal form so
  // static imports, re-exports, dynamic imports, and require-like calls cannot
  // quietly invert the boundary.
  {
    files: ['lib/pbl/v2/operations/kernel/**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '../runtime',
                '../runtime/*',
                '@/lib/pbl/v2/operations/runtime',
                '@/lib/pbl/v2/operations/runtime/*',
              ],
              message:
                'PBL v2 kernel operations must not import operations/runtime. Runtime operations may depend on the project-definition kernel, never the reverse.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        ...MODEL_RUNTIME_DYNAMIC_IMPORT_BAN,
        {
          selector: 'Literal[value=/\\/runtime(?:\\/|$)/]',
          message:
            'PBL v2 kernel operations must not import operations/runtime. Runtime operations may depend on the project-definition kernel, never the reverse.',
        },
        {
          selector: 'TemplateElement[value.cooked=/\\/runtime(?:\\/|$)/]',
          message:
            'PBL v2 kernel operations must not import operations/runtime. Runtime operations may depend on the project-definition kernel, never the reverse.',
        },
      ],
    },
  },
  // Single model boundary (machine-enforced, plan 3.2): server-side text-model
  // calls go through the model gateway. That is where credentials, quota, usage
  // accounting (`recordUsage`), the `LLM_THINKING_DISABLED` kill switch, thinking
  // mapping and error classification live — a direct `generateText` /
  // `streamText`, an `@ai-sdk/*` provider or a pi-ai runtime import silently opts
  // out of all of them, and the opt-out is invisible at the call site. The PBL v2
  // runtime drifted exactly this way once (#1003).
  //
  // The rule uses the @typescript-eslint variant deliberately: the base
  // `no-restricted-imports` is already configured for client code,
  // lib/choreography and lib/video-export, and flat config REPLACES a rule's
  // options per key rather than merging them. Different key, no interference.
  //
  // Every reachable import form is covered, verified by feeding each one to
  // eslint rather than assumed:
  //   - `import { streamText } from 'ai'`  → this rule
  //   - `import * as ai from 'ai'`         → this rule too (the namespace would
  //     carry the restricted names)
  //   - `import { x } from '@ai-sdk/…'` / pi-ai values → this rule; pi-ai TYPE
  //     imports stay allowed (they are erased; lib/model-gateway/types.ts
  //     re-exports them)
  //   - `require(…)`                       → the repo-wide
  //     `@typescript-eslint/no-require-imports` already forbids require()
  //   - `await import(…)`                  → the no-restricted-syntax block below
  // An `eslint-disable` comment defeats any of them, which is the point: the
  // bypass has to be written down where a reviewer sees it.
  //
  // Scope is every linted source extension. tests/lint-llm-entry-guard.test.ts
  // pins the whole matrix so the scope cannot quietly narrow again.
  {
    files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    ignores: [
      ...MODEL_RUNTIME_ALLOWED,
      // Offline harnesses and tests: not server request paths.
      'eval/**',
      'tests/**',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'ai',
              importNames: ['generateText', 'streamText', 'generateObject', 'streamObject'],
              message: GATEWAY_BYPASS_MESSAGE,
            },
          ],
          patterns: [
            { group: ['@ai-sdk/*'], message: GATEWAY_BYPASS_MESSAGE },
            {
              group: ['@earendil-works/pi-ai', '@earendil-works/pi-ai/*'],
              allowTypeImports: true,
              message: GATEWAY_BYPASS_MESSAGE,
            },
          ],
        },
      ],
    },
  },
  // Same boundary, dynamic form. This block cannot match files covered by the
  // package and module boundary blocks above that also set no-restricted-syntax
  // (flat config replaces rule options per key, so it would drop their module
  // boundaries), hence the ignores.
  // Every ignored directory is nonetheless covered, and covered by a rule rather
  // than by an argument:
  //   - packages/@openmaic/renderer, packages/@openmaic/storage, and
  //     packages/@openmaic/generation — the same
  //     MODEL_RUNTIME_DYNAMIC_IMPORT_BAN is spread into their own blocks above. An earlier
  //     revision left them out on the reasoning that they are built in isolation
  //     against @openmaic/dsl; review showed `void import('ai')` under the renderer
  //     source path passing lint, which is exactly why that reasoning was not good
  //     enough.
  //   - lib/choreography, lib/video-export — their blocks ban EVERY
  //     ImportExpression outright, which subsumes this one.
  {
    files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    ignores: [
      ...MODEL_RUNTIME_ALLOWED,
      'eval/**',
      'tests/**',
      // Blocks above that configure no-restricted-syntax for their own boundary.
      'lib/choreography/**',
      'lib/video-export/**',
      'lib/pbl/v2/operations/kernel/**',
      'packages/@openmaic/renderer/**',
      'packages/@openmaic/storage/**',
      'packages/@openmaic/generation/**',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...MODEL_RUNTIME_DYNAMIC_IMPORT_BAN],
    },
  },
  // The static carrier ban near the top uses no-restricted-imports. Dynamic
  // imports and require() need AST selectors, applied after the repo-wide AI SDK
  // guard while preserving that guard for every matching client-owned module.
  {
    files: [
      'app/**/*.{ts,tsx,js,jsx,mjs,cjs}',
      'components/**/*.{ts,tsx,js,jsx,mjs,cjs}',
      'lib/**/*.{ts,tsx,js,jsx,mjs,cjs}',
    ],
    ignores: [
      // Modules allowed to load model runtimes (dynamic pi-ai provider imports).
      ...MODEL_RUNTIME_ALLOWED,
      'app/api/**',
      'lib/server/**',
      'lib/choreography/**',
      'lib/video-export/**',
      'lib/pbl/v2/operations/kernel/**',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...MODEL_RUNTIME_DYNAMIC_IMPORT_BAN,
        ...POLLED_TASK_SERVER_CARRIER_DYNAMIC_IMPORT_BAN,
      ],
    },
  },
]);

export default eslintConfig;
