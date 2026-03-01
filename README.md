# Mark Voice Action Agent

Voice-first Gmail triage assistant with approval-gated actions.

## Stack

- Web: React + Vite
- API: Express + Socket.IO
- Auth and audit storage: Supabase
- Integrations: Composio
- LLM: Anthropic
- Speech: Speechmatics (primary) + ElevenLabs fallback for TTS

## Product Scope (V1)

- Sign in with Google
- Connect Gmail through Composio
- Ask for inbox triage by voice
- Generate reply drafts
- Approve or reject mutating actions before execution

## Prerequisites

- Node.js 20+
- pnpm 10+

## Local Setup

```bash
pnpm install
cp apps/server/.env.example apps/server/.env.local
cp apps/web/.env.example apps/web/.env.local
```

Fill required keys in both `.env.local` files.

## Key Endpoints

- `GET /health`
- `GET /health/voice`
- `GET /health/readiness`
- `GET /v1/auth/me`
- `GET /v1/billing/status`
- `POST /v1/billing/checkout-link`
- `POST /v1/telemetry/events`

## Supabase Migration

Schema migration file:

- [`supabase/migrations/20260301042017_init_agent_action_schema.sql`](/Users/benoit/Documents/HAck V Samir/mark/supabase/migrations/20260301042017_init_agent_action_schema.sql)

Apply it:

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

## Run

```bash
pnpm dev
```

- Web: `http://localhost:5173`
- API: `http://localhost:4000`

## Verification Commands

```bash
pnpm typecheck
pnpm test
pnpm build
cd apps/web && pnpm test:e2e
```

## Notes

- Runtime Gmail workflow cache is stored in `apps/server/.runtime/email-workflows.json` and is gitignored.
- Mutating tool actions remain approval-gated.
- Keep real secrets only in `.env.local`.
