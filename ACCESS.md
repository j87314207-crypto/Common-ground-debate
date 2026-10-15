# Common Ground — Access & Money Guide

Saved 2026-10-15. Ask Pip "show me the access instructions" anytime to see this again.

## 1. Open the website (run it on your own computer)

This app runs on whichever computer you start it on — my workspace can't
serve it to your phone directly.

```bash
cd common-ground-debate
npm install          # already done here; repeat on your machine
cp .env.example .env # then fill in your Stripe keys (see below)
npm run dev
```

Then open **http://localhost:3000** in your browser.

What you get: sign in with any email → browse debates → open one →
pick pro/con → post arguments → vote. Paid debates ($5 default on the
demo) require Stripe Checkout before posting.

### Put it on the public internet (so others can use it)
- Easiest: **Render** (render.com) → New Web Service → connect your repo →
  build command `npm install`, start command `npm start`, add the env vars
  from `.env`. You get a public `https://…onrender.com` URL.
- Alternatives: Railway, Fly.io, or a VPS. Set `PUBLIC_BASE_URL` to the
  public URL or Stripe Checkout redirects will point at localhost.

## 2. Connect Stripe (to take payments)

1. Create an account at https://dashboard.stripe.com
2. Copy your keys: Developers → API keys → **Secret key** (`sk_test_…`
   for testing, `sk_live_…` for real money).
3. Paste into `.env` as `STRIPE_SECRET_KEY`.
4. Add a webhook so paid users actually unlock debates:
   Developers → Webhooks → Add endpoint →
   URL `https://YOUR-DOMAIN/api/webhook/stripe`, event
   `checkout.session.completed` → copy the **Signing secret**
   (`whsec_…`) into `.env` as `STRIPE_WEBHOOK_SECRET`.
5. Restart the server.

Test mode uses card `4242 4242 4242 4242` (any future expiry, any CVC).

## 3. Payment overview (see what you earned)

- Go to https://dashboard.stripe.com
- **Payments** (left sidebar) → Overview: total volume, successful vs
  failed payments, top customers.
- **Payments** → All payments: every charge, with customer, amount,
  status. Click one for fees, receipt, refunds.
- Toggle **Test / Live** (top right) — test payments never touch real money.

## 4. Your funds / balance

- **Balances** (sidebar, under Money movement) → Overview, or open
  https://dashboard.stripe.com/balance/overview
- You see **Available** (ready to pay out), **Pending** (still clearing —
  first payout typically takes 7–14 days after your first live payment),
  and **Instant available** (eligible for instant payout).

## 5. Transfer money to your bank or debit card

**Add a destination first** (one time):
- Settings (gear, bottom left) → Payouts (under Business settings) →
  add your **bank account** (routing + account number). Bank currency must
  match your payout currency.

**Standard payout (free, 1–2 business days):**
- Balances → **Pay out** → choose Standard → confirm. Or set an automatic
  schedule (daily / weekly / monthly) in Settings → Payouts.

**Instant payout to a debit card (arrives in minutes, ~1% fee in
CA/UK/SG, 1.5% in US/AU):**
1. Balances → click **Pay out**.
2. If eligible with a positive balance, choose **Instant** instead of
   Standard. (New accounts aren't eligible immediately — check the
   Dashboard for your status and daily limits.)
3. Add an eligible debit card when prompted (one-time setup).
4. Enter amount → select the card → Review → confirm. Funds land within
   minutes.

Source: Stripe docs — https://docs.stripe.com/payouts/instant-payouts

## 6. Quick troubleshooting
- `POST /api/checkout` returns 501 → `STRIPE_SECRET_KEY` missing in `.env`.
- Paid user still locked out → webhook not configured or signing secret
  wrong; check Developers → Webhooks → recent deliveries.
- Port in use → change `PORT` in `.env`.
