@AGENTS.md

# QuantTrader

AI-powered quant trading platform. Next.js 16 + Supabase + shadcn/ui v4.

## Commands

```bash
pnpm dev         # Start dev server (http://localhost:3000)
pnpm build       # Production build (run to verify before committing)
pnpm lint        # ESLint (0 errors, 0 warnings required)
pnpm lint:fix    # Auto-fix lint issues
pnpm format      # Prettier format all source files
pnpm format:check # Check formatting without writing
pnpm start       # Start production server
```

Add shadcn components: `pnpm dlx shadcn@latest add <component-name>`

**Package manager: pnpm.** Do not use npm or yarn. Do not create package-lock.json or yarn.lock.

## Git Workflow

- **Repo:** https://github.com/huffed/trading-app-demo
- **Main branch:** `main` — production-ready code
- **Integration branch:** `dev` — merge feature branches here via PR
- Do not include `Co-Authored-By` lines in commit messages
- Always run `pnpm build` and `pnpm lint` before committing (0 errors, 0 warnings)

### Feature Branches

All work happens on feature branches off `dev`. Never commit directly to `dev` or `main`.

- **Branch naming:** `feat/<short-description>` (e.g., `feat/dashboard-widgets`, `feat/broker-integration`)
- **Scope:** One branch per iteration or logical feature. If an iteration is large, split it into multiple branches with focused PRs (e.g., `feat/dashboard-stat-cards`, `feat/dashboard-charts`).
- **PR size:** Keep PRs reviewable — aim for under ~500 lines changed. Split larger work into sequential PRs.
- **Flow:** Create branch → develop → test locally → push → open PR into `dev` → merge

```bash
# Start new feature
git checkout dev && git pull
git checkout -b feat/my-feature

# When done
pnpm build && pnpm lint
git push -u origin feat/my-feature
gh pr create --base dev
```

## Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Framework | Next.js (App Router, `src/` dir) | 16 |
| React | React | 19 |
| Language | TypeScript (strict) | 5 |
| Styling | Tailwind CSS (utility classes, CSS variables in `globals.css`) | 4 |
| UI Components | shadcn/ui **base-nova** style (uses `@base-ui/react`, NOT Radix) | 4 |
| Icons | lucide-react | - |
| Backend/Auth | Supabase (`@supabase/ssr`) | - |
| Server State | TanStack React Query | 5 |
| Client State | Zustand | 5 |
| Validation | Zod | 4 |
| Theme | next-themes (dark mode default) | - |

## Critical: shadcn/ui v4 Uses Base UI, Not Radix

This project uses **shadcn/ui base-nova style** which wraps `@base-ui/react`, NOT `@radix-ui`. The composition API is different:

```tsx
// CORRECT - Base UI render prop
<Button render={<Link href="/foo" />}>Click me</Button>
<SheetTrigger render={<Button variant="ghost" />}>Open</SheetTrigger>
<DropdownMenuTrigger render={<Button />}>Menu</DropdownMenuTrigger>
<TooltipTrigger render={<SomeElement />} />

// WRONG - Radix asChild pattern (does NOT work)
<Button asChild><Link href="/foo">Click me</Link></Button>
```

Always check the actual component source in `src/components/ui/` before assuming any API.

## Project Structure

```
src/
├── app/
│   ├── layout.tsx              # Root layout: ThemeProvider > QueryProvider > TooltipProvider
│   ├── page.tsx                # Landing page (public)
│   ├── globals.css             # Tailwind imports + CSS variable theme (oklch colors)
│   ├── (auth)/                 # Route group: login, signup, callback (no sidebar)
│   │   └── layout.tsx          # Centered container layout
│   └── (dashboard)/            # Route group: all authenticated pages
│       └── layout.tsx          # Sidebar + Topbar shell (server component, redirects if no user)
├── components/
│   ├── ui/                     # shadcn/ui primitives (generated via CLI, do not edit directly)
│   ├── layout/                 # Shell: sidebar, topbar, mobile-nav, theme-toggle, user-menu
│   ├── auth/                   # Login/signup forms
│   ├── dashboard/              # Dashboard-specific components
│   ├── trades/                 # Trade-related components
│   ├── journal/                # Journal-related components
│   ├── algorithms/             # Algorithm-related components
│   └── shared/                 # Cross-cutting reusable components
├── lib/
│   ├── supabase/
│   │   ├── client.ts           # createClient() - browser Supabase client
│   │   ├── server.ts           # createClient() - server Supabase client (uses cookies())
│   │   └── middleware.ts       # updateSession() - refreshes auth tokens per request
│   ├── utils.ts                # cn() - clsx + tailwind-merge
│   ├── ai/                     # Claude API integration (future)
│   ├── brokers/                # Broker abstraction layer (future)
│   ├── utils/                  # Shared utilities
│   └── validators/             # Zod schemas
├── hooks/                      # Custom React hooks
├── stores/                     # Zustand stores (ui-store.ts = sidebar state)
├── providers/                  # React context providers (theme, query)
└── types/                      # Shared TypeScript types
middleware.ts                   # Root middleware: auth redirects via lib/supabase/middleware.ts
supabase/migrations/            # SQL migrations (run manually against Supabase)
```

## Conventions

### File Naming
- Components: `kebab-case.tsx` (e.g., `login-form.tsx`, `trade-table.tsx`)
- Exports: PascalCase (e.g., `LoginForm`, `TradeTable`)
- Hooks: `use-[name].ts` exporting `use[Name]`
- Stores: `[name]-store.ts` exporting `use[Name]Store`
- Validators: `[entity].ts` in `lib/validators/`

### Component Organization
- **`components/ui/`** - shadcn primitives only. Add via CLI, avoid manual edits.
- **`components/layout/`** - App shell components (sidebar, topbar, etc.)
- **`components/[feature]/`** - Feature-specific components (trades, journal, etc.)
- **`components/shared/`** - Reusable components used across features

### Client vs Server Components
- Default to server components. Add `"use client"` only when needed (hooks, state, event handlers).
- `(dashboard)/layout.tsx` is a server component - it calls `supabase.auth.getUser()` and redirects.
- Auth forms, sidebar, topbar, theme toggle are client components.

### State Management
- **TanStack Query** for all server/async state (API data, Supabase queries)
- **Zustand** only for ephemeral client UI state (sidebar open/closed, modals, filter state)
- Never put server data in Zustand. Never use TanStack Query for pure UI state.

### Styling
- Tailwind utility classes only. No CSS modules.
- Colors defined as CSS variables in `globals.css` using oklch color space.
- Use `cn()` from `@/lib/utils` to merge classes conditionally.
- Trading-specific colors: `--profit` (green) and `--loss` (red) CSS variables.
- Theme is dark-mode-first. Always test both modes.

### Supabase Auth
- Use `getUser()`, **never** `getSession()` for server-side auth checks. `getUser()` validates the token server-side and cannot be spoofed.
- Browser: `import { createClient } from "@/lib/supabase/client"`
- Server/API routes: `import { createClient } from "@/lib/supabase/server"`
- Protected routes redirect in both middleware (`middleware.ts`) and the dashboard layout.

### Import Alias
All imports use `@/*` which maps to `./src/*`:
```tsx
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";
import { useUIStore } from "@/stores/ui-store";
```

## Environment Variables

Required in `.env.local` (see `.env.example`):
```
NEXT_PUBLIC_SUPABASE_URL=     # Supabase project URL
NEXT_PUBLIC_SUPABASE_ANON_KEY= # Supabase anonymous/public key
```

`NEXT_PUBLIC_` prefix = exposed to browser. Server-only secrets (e.g., `ANTHROPIC_API_KEY`) must NOT have this prefix.

## Database

Migrations live in `supabase/migrations/` and must be run manually against your Supabase project.

Current tables:
- `profiles` - extends `auth.users` with app data (auto-created via trigger on signup)

All tables use Row Level Security (RLS). Users can only access their own data.

## Adding New Features

1. Create the page in `src/app/(dashboard)/[feature]/page.tsx`
2. Add components in `src/components/[feature]/`
3. Add Zod validators in `src/lib/validators/[entity].ts`
4. Add TanStack Query hooks in `src/hooks/use-[entity].ts`
5. Add API routes in `src/app/api/[feature]/route.ts` if needed
6. Add Supabase migrations in `supabase/migrations/`
7. Update sidebar nav items in `src/components/layout/sidebar.tsx` and `src/components/layout/mobile-nav.tsx`

## Nav Items

Sidebar and mobile nav share the same items (defined separately in each file):
Dashboard, Trades, Journal, Algorithms, Analytics, Settings

If adding/renaming nav items, update both `sidebar.tsx` and `mobile-nav.tsx`.
