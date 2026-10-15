# Common Ground — Paid, Structured Debate Platform (starter)

A minimal starter for paid, structured pro/con debates.

## Stack
- Express + Helmet + express-rate-limit + express-session
- better-sqlite3 (file DB in `./data/debates.db`)
- Stripe Checkout for paid debate access + webhook that grants access

## Quick start
```bash
cd common-ground-debate
npm install
cp .env.example .env   # fill in Stripe keys
npm run dev            # or npm start
# open http://localhost:3000
```

## How it works
1. `POST /api/session` with `{ "email" }` to sign in (demo auth — swap for real auth later).
2. `POST /api/debates` to create a debate with `title`, `description`, `price_cents`.
3. If `price_cents > 0`, participants pay via `POST /api/debates/:id/checkout` → Stripe Checkout.
   The Stripe webhook (`POST /api/webhook/stripe`) records an `access_grants` row on
   `checkout.session.completed`.
4. `POST /api/debates/:id/arguments` with `{ side: "pro"|"con", content }` to argue.
5. `POST /api/arguments/:id/vote` with `{ value: 1 | -1 }` to vote.

Free debates (`price_cents: 0`) skip the payment gate. Debate creators always have access.

## API summary
- `GET /api/health`
- `POST /api/session`, `GET /api/me`
- `GET /api/debates`, `GET /api/debates/:id`, `POST /api/debates`
- `POST /api/debates/:id/arguments`
- `POST /api/arguments/:id/vote`
- `POST /api/debates/:id/checkout`
- `POST /api/webhook/stripe` (configure in Stripe dashboard → webhooks)

## Next steps
- Replace demo email-session auth with real auth (e.g. Auth.js / Clerk).
- Add moderation queue, character limits per side, and timed rounds.
- Add refunds / dispute handling via Stripe.
- Move SQLite to Postgres (e.g. Neon/Supabase) when you outgrow a single node.
