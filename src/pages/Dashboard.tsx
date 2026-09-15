import { useQuery, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useState } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import {
  ArrowUpRight,
  BadgeCheck,
  Check,
  ChevronDown,
  CircleDot,
  Copy,
  ExternalLink,
  FileJson,
  FlaskConical,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LogoDropdown } from "@/components/LogoDropdown";
import { useAuth } from "@/hooks/use-auth";
import { API_BASE } from "@/lib/api-base";
import { RESEARCH_SERVICE } from "@/lib/agentgate-contract";

/**
 * This console orders at the service minimum (the action defaults the amount).
 * Copy states that explicitly instead of presenting the minimum as the
 * universal service price — the machine API supports exact per-order amounts
 * >= minimum. Derived from the contract so UI and API cannot drift.
 */
const MIN_AMOUNT = RESEARCH_SERVICE.payment.minimumAmount;
const CURRENCY = RESEARCH_SERVICE.payment.currency;
const SLA_TARGET = RESEARCH_SERVICE.execution.slaTargetMs;

type OrderStatus =
  | "awaiting_payment"
  | "payment_confirmed"
  | "executing"
  | "completed"
  | "failed"
  | "failed_retriable"
  | "expired";

const STATUS_STYLES: Record<OrderStatus, string> = {
  awaiting_payment: "border-amber-400/30 bg-amber-400/10 text-amber-300",
  payment_confirmed: "border-cyan-400/30 bg-cyan-400/10 text-cyan-300",
  executing: "border-sky-400/30 bg-sky-400/10 text-sky-300",
  completed: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  failed: "border-red-400/30 bg-red-400/10 text-red-300",
  failed_retriable: "border-orange-400/30 bg-orange-400/10 text-orange-300",
  expired: "border-slate-400/30 bg-slate-400/10 text-slate-400",
};

const FLOW: OrderStatus[] = [
  "awaiting_payment",
  "payment_confirmed",
  "executing",
  "completed",
];

type OrderDoc = {
  _id: Id<"orders">;
  status: string;
  serviceId: string;
  query: string;
  amount: string;
  currency: string;
  executedMs?: number;
  executionAttempts?: number;
  paymentConfirmedAt?: number;
  mooveLinkStatus?: string;
  moovePaymentUrl?: string;
  mooveTransactionUrl?: string;
  error?: string;
  failureKind?: "transient" | "permanent";
  createdAt: number;
};

type ResultDoc = {
  query: string;
  sources: {
    title: string;
    authors: string[];
    published: string;
    absUrl: string;
    pdfUrl: string;
    summary: string;
  }[];
  sourcesCount: number;
  synthesis: string;
  keyFindings: string[];
  confidence: number;
  measuredMs: number;
};

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)} s` : `${ms} ms`;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs uppercase tracking-widest text-slate-500">
      {children}
    </p>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="shrink-0 text-slate-500">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const orders = (useQuery(api.orders.listMine) ?? []) as OrderDoc[];
  const initiate = useAction(api.agentgate.initiateOrder);
  const runOrder = useAction(api.agentgate.runOrder);

  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<Id<"orders"> | null>(null);

  // Default selection: the most recent transaction.
  const selected = orders.find((o) => o._id === selectedId) ?? orders[0];
  const orderId = selected?._id;
  const result = useQuery(
    api.orders.getResult,
    orderId ? { orderId } : "skip",
  ) as ResultDoc | null | undefined;
  const receipt = useQuery(
    api.orders.getReceipt,
    orderId ? { orderId } : "skip",
  );
  const receiptData = receipt?.receipt as Record<string, unknown> | undefined;

  const handleInitiate = async () => {
    if (busy) return;
    if (query.trim().length < 8) {
      toast.error("Research query must be at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      const { paymentUrl } = await initiate({ query: query.trim() });
      window.open(paymentUrl, "_blank", "noopener,noreferrer");
      toast.success(
        `Payment link created — complete the ${MIN_AMOUNT} ${CURRENCY} payment in the opened tab.`,
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to initiate order.",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleRun = async (id: Id<"orders">) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await runOrder({ orderId: id });
      if (res.ok) {
        toast.success("Service executed — result and receipt are ready.");
      } else if (res.status === "expired") {
        toast.error("Order expired before payment was confirmed.");
      } else {
        toast.error(res.error ?? "Payment was not confirmed in time.");
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to run the order.",
      );
    } finally {
      setBusy(false);
    }
  };

  const copy = (value: unknown, label: string) => {
    navigator.clipboard
      .writeText(JSON.stringify(value, null, 2))
      .then(() => toast.success(`Copied ${label} to clipboard.`))
      .catch(() => toast.error("Clipboard unavailable."));
  };

  const status = selected?.status as OrderStatus | undefined;
  const isPaid =
    status !== undefined &&
    status !== "awaiting_payment" &&
    status !== "expired";
  const canRetry = status === "failed_retriable" || status === "expired";

  return (
    <div className="min-h-screen bg-[#05070d] text-slate-100">
      <header className="border-b border-white/5">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-6">
          <div className="flex items-center gap-2">
            <LogoDropdown />
            <span className="font-bold tracking-tight">ProofFlow</span>
          </div>
          <a
            href={`${API_BASE}/api/services/ai-research-v1/contract`}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-sm text-slate-400 transition-colors hover:text-slate-200"
          >
            Contract <ExternalLink className="size-3.5" />
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5 py-8 sm:px-6 sm:py-10">
        {/* New transaction */}
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
          <p className="text-sm text-slate-500">
            Signed in as {user?.email ?? "guest"}
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">
            New transaction
          </h1>

          <Card className="mt-5 max-w-2xl border-white/10 bg-white/[0.03] shadow-none">
            <CardContent className="space-y-3 pt-6">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Research query — e.g. scaling laws for sparse mixture-of-experts"
                disabled={busy}
                className="border-white/10 bg-white/5"
              />
              <Button
                className="h-11 w-full cursor-pointer bg-cyan-500 text-[#05070d] hover:bg-cyan-400"
                onClick={handleInitiate}
                disabled={busy}
              >
                {busy ? (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                ) : (
                  <FlaskConical className="mr-2 size-4" />
                )}
                Pay with Moove
              </Button>
              <p className="text-xs leading-relaxed text-slate-500">
                {RESEARCH_SERVICE.name} · payment in {CURRENCY} · this console
                orders at the {MIN_AMOUNT} {CURRENCY} minimum — the machine API
                accepts exact per-order amounts of {MIN_AMOUNT} {CURRENCY} or
                more. The amount is fixed when the payment link is created and
                cannot be changed at checkout. Payment is confirmed
                server-side through Moove.
              </p>
            </CardContent>
          </Card>
        </motion.section>

        {/* Transactions */}
        <section className="mt-12">
          <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">
            Transactions
          </h2>
          <p className="mt-2 text-sm text-slate-400">
            Select a transaction to inspect its payment, execution, service
            result, and receipt.
          </p>

          {orders.length === 0 ? (
            <Card className="mt-5 max-w-2xl border-white/10 bg-white/[0.03] shadow-none">
              <CardContent className="pt-6 text-sm text-slate-400">
                No transactions yet. Enter a research query above to start
                one — a Moove payment link is created for the{" "}
                {MIN_AMOUNT} {CURRENCY} minimum.
              </CardContent>
            </Card>
          ) : (
            <>
              {/* Transaction list — tappable cards, mobile-first */}
              <ul className="mt-5 space-y-2">
                {orders.map((o) => {
                  const oStatus = o.status as OrderStatus;
                  const isSelected = o._id === orderId;
                  return (
                    <li key={o._id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(o._id)}
                        aria-pressed={isSelected}
                        className={`w-full cursor-pointer rounded-xl border p-4 text-left transition-colors ${
                          isSelected
                            ? "border-cyan-400/40 bg-cyan-400/[0.06]"
                            : "border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.05]"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex min-w-0 items-center gap-2">
                            <Badge
                              variant="outline"
                              className={
                                STATUS_STYLES[oStatus] ?? "border-white/10"
                              }
                            >
                              {o.status === "completed" ? (
                                <Check className="mr-1 size-3" />
                              ) : null}
                              {o.status}
                            </Badge>
                            <span className="shrink-0 text-sm font-medium text-slate-200">
                              {o.serviceId === RESEARCH_SERVICE.id
                                ? "AI Research"
                                : o.serviceId}
                            </span>
                          </div>
                          <ChevronDown
                            className={`size-4 shrink-0 text-slate-600 transition-transform ${
                              isSelected ? "rotate-180" : ""
                            }`}
                          />
                        </div>
                        <p className="mt-1.5 truncate text-sm text-slate-400">
                          “{o.query}”
                        </p>
                        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                          <span className="font-medium text-slate-300">
                            {o.amount} {o.currency}
                          </span>
                          <span>
                            {o.executedMs != null
                              ? `${formatMs(o.executedMs)}`
                              : "not executed"}
                          </span>
                          <span>{formatDate(o.createdAt)}</span>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>

              {/* Selected transaction detail */}
              {selected && (
                <motion.section
                  key={selected._id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3 }}
                  className="mt-10"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="text-xl font-bold tracking-tight">
                      Transaction
                    </h3>
                    <p className="text-xs text-slate-500">
                      {formatDate(selected.createdAt)}
                    </p>
                  </div>
                  <p className="mt-1 truncate text-sm text-slate-400">
                    “{selected.query}”
                  </p>

                  {/* State machine progress */}
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    {FLOW.map((s, i) => {
                      const reached =
                        status != null &&
                        FLOW.indexOf(status) >= i &&
                        status !== "failed" &&
                        status !== "expired";
                      return (
                        <div key={s} className="flex items-center gap-2">
                          <Badge
                            variant="outline"
                            className={
                              reached
                                ? STATUS_STYLES[s]
                                : "border-white/10 text-slate-600"
                            }
                          >
                            {s}
                          </Badge>
                          {i < FLOW.length - 1 && (
                            <span className="text-slate-700">→</span>
                          )}
                        </div>
                      );
                    })}
                    {(status === "failed" || status === "expired") && (
                      <Badge
                        variant="outline"
                        className={STATUS_STYLES[status]}
                      >
                        {status}
                      </Badge>
                    )}
                  </div>
                  {selected.error && (
                    <p className="mt-3 break-words font-mono text-xs text-red-300">
                      {selected.error}
                    </p>
                  )}
                  {status === "failed_retriable" && (
                    <p className="mt-3 text-xs text-orange-300/80">
                      A transient execution failure — this transaction is paid
                      and can be re-run without paying again.
                    </p>
                  )}

                  <div className="mt-6 grid gap-6 lg:grid-cols-2">
                    {/* Payment */}
                    <Card className="border-white/10 bg-white/[0.03] shadow-none">
                      <CardHeader>
                        <CardTitle className="text-base tracking-tight">
                          Payment
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3 text-sm">
                        <Row label="Amount">
                          <span className="font-medium">
                            {selected.amount} {selected.currency}
                          </span>
                        </Row>
                        <Row label="Moove status">
                          <span className="font-mono text-xs">
                            {selected.mooveLinkStatus ?? "—"}
                          </span>
                        </Row>
                        {selected.paymentConfirmedAt != null && (
                          <Row label="Confirmed">
                            <span className="font-mono text-xs">
                              {new Date(
                                selected.paymentConfirmedAt,
                              ).toLocaleString()}
                            </span>
                          </Row>
                        )}
                        <Row label="Checkout">
                          {selected.moovePaymentUrl ? (
                            <a
                              href={selected.moovePaymentUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex min-h-[44px] items-center gap-1 text-cyan-300 hover:underline"
                            >
                              Open Moove <ArrowUpRight className="size-3.5" />
                            </a>
                          ) : (
                            <span className="text-slate-500">—</span>
                          )}
                        </Row>
                        {selected.mooveTransactionUrl && (
                          <Row label="On-chain reference">
                            <a
                              href={selected.mooveTransactionUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex min-h-[44px] items-center gap-1 text-cyan-300 hover:underline"
                            >
                              View <ExternalLink className="size-3.5" />
                            </a>
                          </Row>
                        )}
                        {status === "awaiting_payment" && (
                          <p className="pt-1 text-xs leading-relaxed text-slate-500">
                            Complete the payment in the Moove checkout, then
                            check payment below. The link accepts exactly{" "}
                            {selected.amount} {selected.currency}.
                          </p>
                        )}
                      </CardContent>
                    </Card>

                    {/* Execution */}
                    <Card className="border-white/10 bg-white/[0.03] shadow-none">
                      <CardHeader>
                        <CardTitle className="text-base tracking-tight">
                          Execution
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3 text-sm">
                        <Row label="Status">
                          <span className="font-mono text-xs">
                            {status ?? "—"}
                          </span>
                        </Row>
                        <Row label="Attempts">
                          <span className="font-mono text-xs">
                            {selected.executionAttempts ?? 0}
                          </span>
                        </Row>
                        <Row label="Measured">
                          <span className="font-mono text-xs">
                            {selected.executedMs != null
                              ? formatMs(selected.executedMs)
                              : "—"}
                          </span>
                        </Row>
                        <Row label="SLA target">
                          <span className="font-mono text-xs">
                            {SLA_TARGET.toLocaleString()} ms (not a guarantee)
                          </span>
                        </Row>
                        {status === "awaiting_payment" && (
                          <Button
                            className="h-11 w-full cursor-pointer"
                            variant="outline"
                            onClick={() => handleRun(selected._id)}
                            disabled={busy}
                          >
                            {busy ? (
                              <Loader2 className="mr-2 size-4 animate-spin" />
                            ) : (
                              <CircleDot className="mr-2 size-4" />
                            )}
                            Check payment &amp; execute
                          </Button>
                        )}
                        {canRetry && (
                          <Button
                            className="h-11 w-full cursor-pointer"
                            variant="outline"
                            onClick={() => handleRun(selected._id)}
                            disabled={busy}
                          >
                            {busy ? (
                              <Loader2 className="mr-2 size-4 animate-spin" />
                            ) : (
                              <CircleDot className="mr-2 size-4" />
                            )}
                            {status === "expired"
                              ? "Payment arrived late — claim service"
                              : "Retry execution (already paid)"}
                          </Button>
                        )}
                      </CardContent>
                    </Card>

                    {/* Service result */}
                    <Card className="border-white/10 bg-white/[0.03] shadow-none">
                      <CardHeader className="flex-row items-center justify-between">
                        <CardTitle className="text-base tracking-tight">
                          Service result
                        </CardTitle>
                        {result && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="cursor-pointer border-white/10"
                            onClick={() => copy(result, "result")}
                          >
                            <Copy className="mr-1 size-3.5" /> JSON
                          </Button>
                        )}
                      </CardHeader>
                      <CardContent className="space-y-4">
                        {result ? (
                          <>
                            <p className="truncate text-xs text-slate-500">
                              “{result.query}”
                            </p>
                            <div className="flex flex-wrap gap-2 text-xs text-slate-400">
                              <span className="rounded border border-white/10 px-2 py-1 font-mono">
                                sources: {result.sourcesCount}
                              </span>
                              <span className="rounded border border-white/10 px-2 py-1 font-mono">
                                measured: {formatMs(result.measuredMs)}
                              </span>
                              <span className="rounded border border-white/10 px-2 py-1 font-mono">
                                confidence: {(result.confidence * 100).toFixed(0)}
                                %
                              </span>
                            </div>
                            <div>
                              <SectionLabel>Synthesis</SectionLabel>
                              <p className="mt-1 text-sm leading-relaxed text-slate-300">
                                {result.synthesis}
                              </p>
                            </div>
                            <div>
                              <SectionLabel>Key findings</SectionLabel>
                              <ul className="mt-1 space-y-1">
                                {result.keyFindings.map((f, i) => (
                                  <li
                                    key={i}
                                    className="text-sm leading-relaxed text-slate-300"
                                  >
                                    • {f}
                                  </li>
                                ))}
                              </ul>
                            </div>
                            <div>
                              <SectionLabel>
                                Sources ({result.sources.length})
                              </SectionLabel>
                              <ol className="mt-2 space-y-3">
                                {result.sources.map((s, i) => (
                                  <li key={i} className="text-sm">
                                    <a
                                      href={s.absUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="font-medium text-cyan-300 hover:underline"
                                    >
                                      [{i + 1}] {s.title}
                                    </a>
                                    <p className="text-xs text-slate-500">
                                      {s.authors.join(", ")} · {s.published} ·{" "}
                                      <a
                                        href={s.pdfUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="hover:underline"
                                      >
                                        PDF
                                      </a>
                                    </p>
                                    <p className="mt-1 line-clamp-2 text-xs text-slate-400">
                                      {s.summary}
                                    </p>
                                  </li>
                                ))}
                              </ol>
                            </div>
                          </>
                        ) : isPaid ? (
                          <div className="flex items-center gap-3 text-sm text-slate-400">
                            <Loader2 className="size-4 animate-spin" />
                            Waiting for the service to produce its result…
                          </div>
                        ) : (
                          <p className="text-sm text-slate-500">
                            The result appears here after payment is confirmed
                            and the service runs.
                          </p>
                        )}
                      </CardContent>
                    </Card>

                    {/* Receipt */}
                    <Card className="border-white/10 bg-white/[0.03] shadow-none">
                      <CardHeader className="flex-row items-center justify-between">
                        <CardTitle className="flex items-center gap-2 text-base tracking-tight">
                          <FileJson className="size-4 text-emerald-300" />
                          Receipt
                        </CardTitle>
                        {receiptData && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="cursor-pointer border-white/10"
                            onClick={() => copy(receiptData, "receipt")}
                          >
                            <Copy className="mr-1 size-3.5" /> JSON
                          </Button>
                        )}
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {receiptData ? (
                          <>
                            <div className="flex flex-wrap gap-2 text-xs">
                              <span className="rounded border border-emerald-400/20 bg-emerald-400/5 px-2 py-1 font-mono text-slate-300">
                                hash:{" "}
                                {String(receiptData.resultHash ?? "").slice(
                                  0,
                                  19,
                                )}
                                …
                              </span>
                              <span className="rounded border border-white/10 px-2 py-1 font-mono text-slate-300">
                                payment:{" "}
                                {String(receiptData.paymentStatus ?? "—")}
                              </span>
                            </div>
                            <details>
                              <summary className="cursor-pointer text-sm text-cyan-300 transition-colors hover:text-cyan-200">
                                Machine-readable receipt
                              </summary>
                              <pre className="mt-2 max-h-72 overflow-auto rounded-lg border border-white/10 bg-black/40 p-4 font-mono text-xs leading-relaxed text-slate-300">
                                {JSON.stringify(receiptData, null, 2)}
                              </pre>
                            </details>
                          </>
                        ) : (
                          <p className="text-sm text-slate-500">
                            The receipt is generated from the persisted
                            transaction data after a successful run.
                          </p>
                        )}
                      </CardContent>
                    </Card>
                  </div>
                </motion.section>
              )}
            </>
          )}
        </section>
      </main>
    </div>
  );
}
