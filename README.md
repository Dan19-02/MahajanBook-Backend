# Ledgix Backend

An **Express + TypeScript** API for the Ledgix (CreditFlow) app. It provides:

- **JWT authentication** (register / login) with bcrypt-hashed passwords.
- A **shared PostgreSQL database** (via `pg`) holding all business data
  (products, customers, invoices, transactions, reminders) — shared across every
  logged-in user of the shop. The schema is created automatically on first boot.
- **Server-side business logic**: invoice pricing, stock, ledger balances, the
  reminder schedule, payments, and reconciliation.
- **AI reminder drafting** with **MiniMax-M3** (via NVIDIA), key held server-side.

## Setup

```bash
cd "Ledgix Backend"
npm install
cp .env.example .env   # set DATABASE_URL, NVIDIA_API_KEY, and a JWT_SECRET
npm run dev            # http://localhost:3001  (auto-reloads)
```

Requires a reachable **PostgreSQL** instance — point `DATABASE_URL` at it (local,
or a hosted provider like Render/Supabase/Neon). The schema is created on boot.

Production build: `npm run build && npm start`.

## Environment

| Variable             | Default                               | Description                               |
| -------------------- | ------------------------------------- | ----------------------------------------- |
| `NVIDIA_API_KEY`     | _(required for AI)_                    | NVIDIA Integrate key for MiniMax-M3.      |
| `JWT_SECRET`         | _(insecure default — set this!)_      | Secret used to sign JWTs.                 |
| `JWT_EXPIRES_IN_SECONDS` | `604800` (7 days)                 | Token lifetime.                           |
| `DATABASE_URL`       | _(required)_                          | PostgreSQL connection string (`postgresql://user:pass@host:port/db`). |
| `DATABASE_SSL`       | _(auto)_                              | `true`/`false` to force DB SSL; auto-detects from host otherwise. |
| `PORT`               | `3001`                                | Port the server listens on.               |
| `CORS_ORIGIN`        | `http://localhost:3000`               | Comma-separated allowed frontend origins. |
| `MINIMAX_MODEL`      | `minimaxai/minimax-m3`                | Model id.                                 |
| `NVIDIA_BASE_URL`    | `https://integrate.api.nvidia.com/v1` | OpenAI-compatible base URL.               |
| `NVIDIA_TIMEOUT_MS`  | `30000`                               | Timeout for the MiniMax request.          |

If `NVIDIA_API_KEY` is missing the server still starts and `/api/health` works;
`/api/ai/draft` returns `503` until a key is configured.

## Reminder cadence

When a **credit** invoice is created, reminders are scheduled starting the day
**before** the PTP date, then **every other day** (a blank day between each):

```
PTP-1 · PTP+1 · PTP+3 · PTP+5 · PTP+7 · PTP+9 · PTP+11
```

Paying the invoice (cash or Razorpay reconcile) cancels the remaining queued
reminders automatically.

## Production hardening

- `helmet` security headers; `X-Powered-By` disabled.
- Rate limiting on `/api/ai` (20 req/min per IP) to cap cost on the paid endpoint.
- Request timeout on the MiniMax call (`504` instead of hanging).
- CORS restricted to `CORS_ORIGIN`; JSON body capped; passwords bcrypt-hashed.

## API

Public:

| Method | Path                  | Description                          |
| ------ | --------------------- | ------------------------------------ |
| GET    | `/api/health`         | Liveness + AI status.                |
| POST   | `/api/auth/register`  | Create account (first user = OWNER). |
| POST   | `/api/auth/login`     | Returns `{ token, user }`.           |

Authenticated (send `Authorization: Bearer <token>`):

| Method | Path                            | Description                                      |
| ------ | ------------------------------- | ------------------------------------------------ |
| GET    | `/api/auth/me`                  | Current user.                                    |
| GET    | `/api/bootstrap`                | Full data snapshot.                              |
| POST   | `/api/products`                 | Create a product.                                |
| PATCH  | `/api/products/:id/stock`       | Update stock level.                              |
| POST   | `/api/customers`                | Create a customer.                               |
| POST   | `/api/invoices`                 | Create an invoice (pricing/stock/ledger/reminders). |
| POST   | `/api/payments`                 | Record a cash payment.                           |
| POST   | `/api/invoices/:id/reconcile`   | Razorpay auto-reconcile.                         |
| POST   | `/api/reminders/:id/send`       | Send a WhatsApp reminder.                        |
| DELETE | `/api/data`                     | Clear all business data (keeps users).           |
| POST   | `/api/ai/draft`                 | Draft a reminder with MiniMax-M3 (rate-limited). |

Most mutations return the updated `snapshot` so the client can refresh state in
one round-trip. Errors are `{ "error": "..." }` with an appropriate status code.
