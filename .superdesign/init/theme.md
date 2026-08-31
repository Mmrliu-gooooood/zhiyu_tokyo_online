# Theme

Framework: Next.js App Router + React. CSS: Tailwind v4 (`@import 'tailwindcss'`), `tw-animate-css`, `shadcn/tailwind.css`. No `tailwind.config.ts` — tokens live in `app/globals.css` via `@theme inline` and `:root` / `.dark`.

There is no `QingjinAppShell`. Product chrome is per-route (home inline header, classroom `Header`, workspace `.ws-root`).

---

## Part 1 — Compact token summary

| Name | Hex / value | Role |
| --- | --- | --- |
| Paper | `#F4F6F3` | Page background (`--background`) |
| Porcelain | `#FBFCFB` | Card / popover / primary-foreground |
| Ink | `#1B2420` | Foreground / card-foreground |
| Muted | `#5C6B64` | Muted foreground |
| Celadon | `#3D6B5A` | Primary / ring |
| Bronze | `#8A6A3D` | Brand mark (衿 seal) |
| Hairline | `rgba(27,36,32,.09)` | Borders / hairlines |
| Canvas | `#EEF1EE` | Soft canvas / secondary wash |

**Fonts:** Noto Serif SC display, Inter Variable UI

**Radius:** `--radius` `0.625rem`; composer `18px`

**Shadow:** `0 1px 2px rgba(20,30,25,.04)`, `0 8px 24px rgba(20,30,25,.05)`

Dark (from `.dark`): background `#121816`, foreground `#e8eeea`, card `#1a221f`, primary `#7fa392`, muted-foreground `#9aa89f`.

Type: UI is Inter Variable (`--font-sans`). Display / wordmark is Noto Serif SC (`--font-display`). Geist Sans/Mono CSS variables are still attached on `<body>` from `app/layout.tsx` but `--font-sans` is overridden in `:root`.

---

## Part 2 — Raw source dumps

From `app/globals.css`.

### `@theme inline` (lines 19–61)

```css
@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --font-sans: var(--font-sans);
  --font-display: var(--font-display-family);
  --font-mono: var(--font-geist-mono);
  --color-sidebar-ring: var(--sidebar-ring);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar: var(--sidebar);
  --color-chart-5: var(--chart-5);
  --color-chart-4: var(--chart-4);
  --color-chart-3: var(--chart-3);
  --color-chart-2: var(--chart-2);
  --color-chart-1: var(--chart-1);
  --color-ring: var(--ring);
  --color-input: var(--input);
  --color-border: var(--border);
  --color-destructive: var(--destructive);
  --color-accent-foreground: var(--accent-foreground);
  --color-accent: var(--accent);
  --color-muted-foreground: var(--muted-foreground);
  --color-muted: var(--muted);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-secondary: var(--secondary);
  --color-primary-foreground: var(--primary-foreground);
  --color-primary: var(--primary);
  --color-popover-foreground: var(--popover-foreground);
  --color-popover: var(--popover);
  --color-card-foreground: var(--card-foreground);
  --color-card: var(--card);
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
  --radius-2xl: calc(var(--radius) + 8px);
  --radius-3xl: calc(var(--radius) + 12px);
  --radius-4xl: calc(var(--radius) + 16px);
}
```

### `:root` and `.dark` (lines 63–137)

```css
:root {
  /* Inter is loaded from @fontsource in app/layout.tsx, which declares one
     @font-face per unicode subset. Previously this came from next/font wrapping
     a single latin-only file, which left Cyrillic and Vietnamese text to OS
     fallback fonts. */
  --font-sans: 'Inter Variable', ui-sans-serif, system-ui, sans-serif;
  --font-display-family: 'Noto Serif SC', ui-serif, 'Source Han Serif SC', serif;
  --font-display: var(--font-display-family);
  --background: #f4f6f3;
  --foreground: #1b2420;
  --card: #fbfcfb;
  --card-foreground: #1b2420;
  --popover: #fbfcfb;
  --popover-foreground: #1b2420;
  --primary: #3d6b5a;
  --primary-foreground: #fbfcfb;
  --secondary: #e8eeea;
  --secondary-foreground: #1b2420;
  --muted: #e8eeea;
  --muted-foreground: #5c6b64;
  --accent: #e8eeea;
  --accent-foreground: #1b2420;
  --destructive: oklch(0.58 0.22 27);
  --border: #1b242014;
  --input: #1b242014;
  --ring: #3d6b5a;
  --chart-1: oklch(0.809 0.105 251.813);
  --chart-2: oklch(0.623 0.214 259.815);
  --chart-3: oklch(0.546 0.245 262.881);
  --chart-4: oklch(0.488 0.243 264.376);
  --chart-5: oklch(0.424 0.199 265.638);
  --radius: 0.625rem;
  --sidebar: oklch(0.985 0 0);
  --sidebar-foreground: oklch(0.145 0 0);
  --sidebar-primary: oklch(0.205 0 0);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.97 0 0);
  --sidebar-accent-foreground: oklch(0.205 0 0);
  --sidebar-border: oklch(0.922 0 0);
  --sidebar-ring: oklch(0.708 0 0);
}

.dark {
  --background: #121816;
  --foreground: #e8eeea;
  --card: #1a221f;
  --card-foreground: #e8eeea;
  --popover: #1a221f;
  --popover-foreground: #e8eeea;
  --primary: #7fa392;
  --primary-foreground: #121816;
  --secondary: #1a221f;
  --secondary-foreground: #e8eeea;
  --muted: #1a221f;
  --muted-foreground: #9aa89f;
  --accent: #1a221f;
  --accent-foreground: #e8eeea;
  --destructive: oklch(0.704 0.191 22.216);
  --border: #e8eeea14;
  --input: #e8eeea14;
  --ring: #7fa392;
  --chart-1: oklch(0.809 0.105 251.813);
  --chart-2: oklch(0.623 0.214 259.815);
  --chart-3: oklch(0.546 0.245 262.881);
  --chart-4: oklch(0.488 0.243 264.376);
  --chart-5: oklch(0.424 0.199 265.638);
  --sidebar: oklch(0.205 0 0);
  --sidebar-foreground: oklch(0.985 0 0);
  --sidebar-primary: oklch(0.488 0.243 264.376);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.269 0 0);
  --sidebar-accent-foreground: oklch(0.985 0 0);
  --sidebar-border: oklch(1 0 0 / 10%);
  --sidebar-ring: oklch(0.556 0 0);
}
```
