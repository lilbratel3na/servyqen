# Servyqen

Servyqen is a **machine-to-service commerce layer**: an AI agent discovers a service,
reads its machine-readable service contract, requests an exact per-order price, pays
through **Moove's hosted payment flow**, waits for **server-side Moove payment
confirmation**, and then receives a **verified machine-readable result and receipt**.

Machine-facing protocol identifiers are unchanged for compatibility: the wire-protocol
string `AgentGate/1.0` (served by the discovery index and contract endpoints) and the
`agentgate-contract.ts` module name are part of the published machine contract.

The first service is an **AI Research service**: given a query, it returns exactly five
real arXiv sources, a deterministic extractive synthesis, one key finding per source,
a deterministic confidence score, and the measured execution time.

The machine API is served from the Convex deployment's `.convex.site` host
(the `.convex.cloud` host serves client RPC and is not the machine API base).

---

## Payment flow (honest version)

The human payer completes the hosted Moove payment; everything else is
machine-accessible. This is **not** autonomous agent wallet spending.

```
GET  /api/services                          # discovery
GET  /api/services/ai-research-v1/contract  # machine-readable contract
POST /api/orders                            # exact price requested; Moove payment link created
     -> 201 { orderId, paymentLinkId, paymentUrl, capabilityToken }
     (human opens paymentUrl and completes the hosted Moove payment)
POST /api/orders/:id/run                    # server polls Moove's status endpoint until
                                            # it reports "completed", then executes
GET  /api/orders/:id                        # authorized: full state, result, receipt
```

Nothing in the HTTP layer can mark a payment as completed. Confirmation comes only
from Moove's documented payment-link status endpoint
(`GET https://api.moove.xyz/v1/payment-link/{id}`, `status === "completed"`), polled
server-side. There are no webhooks and no escrow.

---

## Pricing

- **Minimum: 1 USDC.** Denominated in USDC, not USD.
- **Per-order exact amount:** each `POST /api/orders` names its exact price via the
  optional `amount` string.
- `amount` is **optional and defaults to `"1"`**.
- **Maximum 6 decimal places** (USDC precision); decimal strings only — JSON numbers
  are rejected to avoid float rounding.
- **The payer cannot edit the amount** on the hosted Moove checkout: the link is
  created with a fixed `toAmount` and Moove enforces it.
- Amounts above the minimum are legitimate; the exact requested string is preserved
  on the order and in the receipt (e.g. `"2.50"` stays `"2.50"`).

The contract advertises this as `pricingModel: "per_order_exact_amount …"` and the
discovery index presents it as `"from 1 USDC"`.

---

## API endpoints

Examples below use placeholders only (`<CAPABILITY_TOKEN>`, `<ORDER_ID>`).
All responses are `application/json`.

### `GET /api/services`

Discovery index.

```json
{
  "protocol": "AgentGate/1.0",
  "services": [
    {
      "id": "ai-research-v1",
      "name": "AI Research Service",
      "version": "1.0.0",
      "price": "from 1 USDC",
      "pricing": {
        "model": "per_order_exact_amount",
        "currency": "USDC",
        "minimumAmount": "1",
        "minimumAmountValue": 1,
        "defaultAmount": "1",
        "payerEditable": false
      },
      "contractUrl": "/api/services/ai-research-v1/contract"
    }
  ]
}
```

### `GET /api/services/ai-research-v1/contract`

Full machine-readable contract: service identity/version, payment provider and
method, `minimumAmount`, `pricingModel`, payer-editable wording, Moove confirmation
wording, `execution.slaTargetMs` + `slaNote`, input schema (`query`, 8–512 chars),
output schema (exactly 5 sources, synthesis, keyFindings, confidence), and the
`endpoints` documentation block. It is the single source of truth agents should read.

### `POST /api/orders`

Request body:

```json
{
  "query": "transformer scaling",
  "amount": "1.50"
}
```

- `query` (required, string, 8–512 characters after trimming)
- `amount` (optional, decimal string, `>= 1`, at most 6 decimal places; defaults to `"1"`)

Success — `201`:

```json
{
  "orderId": "<ORDER_ID>",
  "paymentLinkId": "<MOOVE_PAYMENT_LINK_ID>",
  "paymentUrl": "https://www.moove.xyz/@<HANDLE>/pay/<MOOVE_PAYMENT_LINK_ID>",
  "status": "awaiting_payment",
  "capabilityToken": "<CAPABILITY_TOKEN>",
  "note": "Store the capabilityToken now: it is returned once and is required for all subsequent access to this order. The human completes payment at paymentUrl; confirmation is performed server-side from Moove's status endpoint only."
}
```

Validation failures — `400` with `{"error": "<message>"}` (e.g. invalid JSON, query
too short/long, below-minimum or malformed amount). Moove unavailability — `502`
with `{"error": "payment_link_unavailable"}` or `{"error": "payment_link_missing"}`.

### `GET /api/orders/:id`

Requires `Authorization: Bearer <CAPABILITY_TOKEN>`. Returns the full
machine-readable order state:

```json
{
  "orderId": "<ORDER_ID>",
  "serviceId": "ai-research-v1",
  "status": "awaiting_payment | payment_confirmed | executing | completed | failed | failed_retriable | expired",
  "query": "transformer scaling",
  "amount": "1.50",
  "currency": "USDC",
  "paymentLinkId": "<MOOVE_PAYMENT_LINK_ID>",
  "paymentUrl": "https://www.moove.xyz/@<HANDLE>/pay/<MOOVE_PAYMENT_LINK_ID>",
  "mooveLinkStatus": "active | completed | inactive | null",
  "transactionUrl": "<ON_CHAIN_TRANSACTION_URL | null>",
  "error": null,
  "failureKind": "transient | permanent | null",
  "executionAttempts": 0,
  "executedMs": null,
  "createdAt": 1789332276573,
  "updatedAt": 1789424866055,
  "paymentConfirmedAt": null,
  "completedAt": null,
  "result": null,
  "receipt": null
}
```

Once the order is `completed`, `result` is populated:

```json
{
  "query": "transformer scaling",
  "sources": [
    {
      "title": "<PAPER_TITLE>",
      "authors": ["<AUTHOR_1>", "<AUTHOR_2>"],
      "published": "YYYY-MM-DD",
      "absUrl": "http://arxiv.org/abs/<ARXIV_ID>",
      "pdfUrl": "https://arxiv.org/pdf/<ARXIV_ID>",
      "summary": "<VERBATIM_ABSTRACT>"
    }
  ],
  "sourcesCount": 5,
  "synthesis": "<DETERMINISTIC_EXTRACTIVE_SYNTHESIS>",
  "keyFindings": ["[<PAPER_TITLE>] <VERBATIM_EXCERPT>"],
  "confidence": 0.0,
  "generatedAt": "<ISO_TIMESTAMP>",
  "measuredMs": 0,
  "provider": "arxiv-api + extractive-synthesis (no LLM)"
}
```

… and `receipt` (built from persisted order + result rows only):

```json
{
  "orderId": "<ORDER_ID>",
  "serviceId": "ai-research-v1",
  "paymentId": "<MOOVE_PAYMENT_LINK_ID>",
  "amount": "1.50",
  "currency": "USDC",
  "paymentStatus": "completed",
  "transactionUrl": "<ON_CHAIN_TRANSACTION_URL | null>",
  "executionStatus": "completed",
  "executedMs": 0,
  "slaTargetMs": 5000,
  "slaNote": "<TARGET_NOT_GUARANTEE_NOTE>",
  "result": { "sources": [], "synthesis": "", "keyFindings": [], "confidence": 0.0 },
  "resultHash": "sha256:<HEX>",
  "createdAt": "<ISO_TIMESTAMP>"
}
```

`paymentStatus` falls back to `"unknown"` — never `"completed"` — if the observed
Moove link status was not captured; the receipt cannot overstate payment evidence.

### `POST /api/orders/:id/run`

Requires `Authorization: Bearer <CAPABILITY_TOKEN>`. Polls the real Moove status
endpoint until genuinely confirmed (or times out), then executes the service under a
one-shot claim.

```json
{
  "orderId": "<ORDER_ID>",
  "ok": true,
  "status": "completed",
  "finalStatus": "completed"
}
```

- `status` is the coarse action outcome (`completed | failed | awaiting_payment | expired`);
  `finalStatus` is the persisted order state and is authoritative.
- This response never carries the result/receipt — follow with the authorized
  `GET /api/orders/:id`.

---

## Capability token & security behavior

- The capability token is a **256-bit cryptographically random hex string returned
  exactly once** by `POST /api/orders` (the 201 body).
- **Only its SHA-256 hash is stored** on the order row; the raw token is never
  persisted.
- Every subsequent operation on the order (`GET /api/orders/:id`,
  `POST /api/orders/:id/run`) requires `Authorization: Bearer <CAPABILITY_TOKEN>`.
- **Missing, malformed, or wrong tokens return the same `404 {"error": "not_found"}`**
  as a nonexistent order — authorization failure and nonexistence are
  indistinguishable.
- A token grants access only to the single order it was issued for.
- Loss of the token means loss of access to that order; there is no recovery path
  by design.

---

## AI Research output guarantees

- **Exactly five real arXiv sources** — every source is a real preprint with title,
  authors, publication date, abstract URL, PDF URL, and a verbatim per-source
  summary. If fewer than five verifiable sources are returned, the order **fails
  honestly**; results are never padded with fabricated entries.
- **Extractive synthesis** — deterministic, no language model; every statement is
  quoted verbatim from a retrieved abstract.
- **One key finding per source** — a verbatim excerpt from that source's abstract,
  attributed to the real paper title.
- **Deterministic confidence** — computed (not model-reported) as the fraction of
  the five sources whose title or abstract contains at least one meaningful query
  term, in `[0,1]`.
- **Measured execution time** — `executedMs` is real wall-clock time
  (`Date.now()` around the retrieval+synthesis window), never a hardcoded value.
- The receipt's `resultHash` is a SHA-256 over the canonical persisted result.

### SLA

**5000ms is an execution target, not a guarantee.** The contract states
`slaTargetMs: 5000` with an explicit note that it is a target only, and every
response reports the measured `executedMs`. Do not interpret any response as
promising completion within 5 seconds.

---

## Failure & retry behavior

- Order state machine:
  `awaiting_payment → payment_confirmed → executing → completed`, with
  `failed`, `failed_retriable`, and `expired` side states. All transitions are
  enforced server-side.
- **Transient execution failures** (timeout, network errors, provider 429/5xx) of a
  **paid** order land in `failed_retriable`. The order can then be re-run via
  `POST /api/orders/:id/run` **without creating another payment link or charging
  again** — a retry re-verifies payment with Moove and reuses the existing payment
  evidence.
- **Permanent contract failures** (fewer than 5 verifiable sources, integrity
  violations) stay terminal in `failed` and are distinguished via `failureKind`:
  `"transient"` vs `"permanent"`.
- A failed retry leaves the order safely retriable; only a genuinely successful
  execution persists a result and receipt — a failed attempt is never faked or reused.
- An unpaid order can never reach execution: the one-shot claim requires persisted
  payment-confirmation evidence (`paymentConfirmedAt`), not a status string.

---

## Verified live transaction

One order has been paid and executed end-to-end through this exact pipeline as
evidence that the flow works as documented:

- Order state reached `completed` after a genuine Moove-hosted payment (USDC) and a
  server-side confirmation.
- Result contained exactly 5 real arXiv sources, extractive synthesis, 5 key
  findings, deterministic confidence `1.0`, and a measured `executedMs`.
- Receipt reported `paymentStatus: "completed"` with a Moove transaction URL and a
  `sha256` result hash.

Placeholders only (real values are not published here): order id `<ORDER_ID>`,
payment link `<MOOVE_PAYMENT_LINK_ID>`, payment URL
`https://www.moove.xyz/@<HANDLE>/pay/<MOOVE_PAYMENT_LINK_ID>`, transaction URL
`<ON_CHAIN_TRANSACTION_URL>`. The capability token is never published.

This transaction also validated the retry path: an earlier attempt failed with an
arXiv timeout, landed in `failed_retriable`, and a later rerun completed using the
same payment evidence — no second payment link, no second charge.

---

## Explicit non-claims

- ❌ **No autonomous payment / no agent wallet spending.** A human completes the
  hosted Moove payment; the agent cannot move funds.
- ❌ **No escrow, no conditional release, no outbound transfers.** Only Moove's
  documented payment-link create/status endpoints are used.
- ❌ **No guaranteed 5-second execution.** 5000ms is a target; `executedMs` is
  measured and reported honestly.
- No invented benchmarks, user counts, revenue, or adoption figures, and no Moove
  capabilities beyond the documented payment-link API.

---

## Testing the machine API

```bash
# discovery + contract
curl https://<CONVEX_SITE_HOST>/api/services
curl https://<CONVEX_SITE_HOST>/api/services/ai-research-v1/contract

# create an order (returns the one-time capability token)
curl -X POST https://<CONVEX_SITE_HOST>/api/orders \
  -H "Content-Type: application/json" \
  -d '{"query":"transformer scaling"}'

# authorized reads/runs
curl https://<CONVEX_SITE_HOST>/api/orders/<ORDER_ID> \
  -H "Authorization: Bearer <CAPABILITY_TOKEN>"
curl -X POST https://<CONVEX_SITE_HOST>/api/orders/<ORDER_ID>/run \
  -H "Authorization: Bearer <CAPABILITY_TOKEN>"
```

Replace `<CONVEX_SITE_HOST>` with the deployment's `*.convex.site` host.
Creating an order creates a real Moove payment link — do not pay it unless you
intend to spend 1+ USDC.

## Development

- Stack: Vite, TypeScript, React 19 + React Router, Tailwind v4, shadcn/ui,
  Convex + Convex Auth, Framer Motion. Package manager: **bun**.
- Convex backend lives in `src/convex/`; the machine API HTTP router is
  `src/convex/http.ts`; Moove integration is `src/convex/moove.ts` (reads
  `MOOVE_API_KEY` from the server-side environment only — never committed, never
  returned to clients); research execution is `src/convex/research.ts`.
- Shared, unit-tested pure logic lives in `src/lib/`
  (`agentgate-contract.ts` is the service contract single source of truth).
- Commands:

```bash
bun install          # dependencies
bun run test         # unit tests (vitest)
bun tsc -b --noEmit  # typecheck
bunx convex dev --once  # Convex codegen + deploy validation
bun run build        # production build
```

Auth, routing, and UI conventions follow the Vly/Freebuff template
(`src/pages/`, `src/components/ui/`, protected routes via `RequireAuth`).
