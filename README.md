# Mark Voice Action Agent

Authenticated voice-first web app using:
- Supabase (Google OAuth + persistent audit storage)
- Composio (connectable app catalog + tool execution)
- Anthropic (reasoning + tool orchestration + draft revision)
- Speechmatics (one-shot STT)
- Speechmatics-first TTS (`wav_16000`) with ElevenLabs fallback

Flow:
- Browser records utterances, auto-detects end-of-speech, encodes to MP3, and sends one-shot audio for STT.
- Agent can auto-execute read tools.
- Mutating tools create pending drafts and require explicit approval/rejection.
- Approval loop supports iterative voice revisions.

## Requirements

- Node.js 20+
- pnpm 10+

## Setup

```bash
pnpm install
cp apps/server/.env.example apps/server/.env.local
cp apps/web/.env.example apps/web/.env.local
# fill keys in both .env.local files
```

Required server env keys:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY`
- `COMPOSIO_API_KEY`
- `COMPOSIO_CONNECT_CALLBACK_URL`
- `ANTHROPIC_API_KEY`
- `SPEECHMATICS_API_KEY`
- `SPEECHMATICS_TTS_BASE_URL` (default provided)
- `SPEECHMATICS_TTS_VOICE` (default `sarah`)
- `SPEECHMATICS_TTS_OUTPUT_FORMAT` (default `wav_16000`)
- `ELEVENLABS_API_KEY`

Required web env keys:
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_API_BASE_URL` (optional, defaults to `http://localhost:4000`)

Supabase schema:
- The schema is now a Supabase CLI migration in [`supabase/migrations/20260301042017_init_agent_action_schema.sql`](/Users/guillaume_deramchi/Documents/mark/supabase/migrations/20260301042017_init_agent_action_schema.sql).
- Apply it with:
  - `supabase link --project-ref <your-project-ref>`
  - `supabase db push`

Supabase CLI bootstrap done in this repo:
- [`supabase/config.toml`](/Users/guillaume_deramchi/Documents/mark/supabase/config.toml) initialized
- [`supabase/seed.sql`](/Users/guillaume_deramchi/Documents/mark/supabase/seed.sql) created
- auth redirect defaults updated to `http://localhost:5173`

## Run

```bash
pnpm dev
```

- Web UI: `http://localhost:5173`
- API: `http://localhost:4000`
- Voice health: `http://localhost:4000/health/voice`

## Scripts

```bash
pnpm dev
pnpm build
pnpm typecheck
pnpm test
```

## Notes

- Authentication is mandatory for action-capable sessions.
- Conversation memory is in-memory and resets on server restart.
- Action/audit persistence is available when Supabase schema is applied.
- TTS priority is Speechmatics first, then ElevenLabs fallback.
- Real credentials should stay in `.env.local` only.
