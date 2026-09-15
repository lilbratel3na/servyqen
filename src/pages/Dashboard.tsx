import { useQuery, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import {
  ArrowUpRight,
  Check,
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

/** Console orders at the contract's minimum; the machine API supports exact
 * per-order amounts. Derived from the contract so UI and API cannot drift. */
const MIN_AMOUNT = RESEARCH_SERVICE.payment.minimumAmount;
const CURRENCY = RESEARCH_SERVICE.payment.currency;

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

function formatMs(ms: number): string {
  return ms >= 1000
    ? `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)} s`
    : `${ms} ms`;
}

function formatDateTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function serviceName(serviceId: string): string {
  return serviceId === RESEARCH_SERVICE.id ? "AI Research" : serviceId;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs uppercase tracking-widest text-slate-500">
      {children}
    </p>
  );
}

type OrderDoc = {
  _id: Id<"orders">;
  status: string;
  serviceId: string;
  query: string;
  amount: string;
  currency: string;
  executionAttempts?: number;
  executedMs?: number;
  mooveLinkStatus?: string;
  moovePaymentUrl?: string;
  mooveTransactionUrl?: string;
  paymentConfirmedAt?: number;
  error?: string;
  createdAt: number;
};

export default function Dashboard() {
  const { user } = useAuth();
  const ordersQuery = useQuery(api.orders.listMine);
  const orders = (ordersQuery ?? []) as OrderDoc[];
  const initiate = useAction(api.agentgate.initiateOrder);
  const runOrder = useAction(api.agentgate.runOrder);

  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  // Latches the first successful subscription delivery so a transient
  // undefined (auth-token revalidation) can never unmount the transaction
  // tree mid-interaction.
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  useEffect(() => {
    if (ordersQuery !== undefined) setHasLoadedOnce(true);
  }, [ordersQuery]);
  // Selection: null = follow the newest transaction; otherwise the tapped id.
  // Falls back to the newest order when the id is unknown (e.g. after data
  // changes), so the page never renders a dangling selection.
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected =
    orders.find((o) => o._id === selectedId) ?? (orders[0] as OrderDoc | undefined);

  const result = useQuery(
    api.orders.getResult,
    selected ? { orderId: selected._id } : "skip",
  );
  const receipt = useQuery(
    api.orders.getReceipt,
    selected ? { orderId: selected._id } : "skip",
  );

  const handleInitiate = async () => {
    if (busy) return;
    if (query.trim().length < 8) {
      toast.error("Research query must be at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      const { paymentUrl } = await initiate({ query: query.trim() });
      setSelectedId(null); // follow the newly created (newest) transaction
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

  const handleRun = async () => {
    if (!selected || busy) return;
    setBusy(true);
    try {
      const res = await runOrder({ orderId: selected._id });
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
  const receiptData = receipt?.receipt as Record<string, unknown> | undefined;

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
          <h1 className="mt-1 text-xl font-bold tracking-tight sm:text-2xl">
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
                Pay {MIN_AMOUNT} {CURRENCY} with Moove
              </Button>
              <p className="text-xs leading-relaxed text-slate-500">
                This console starts transactions at the {MIN_AMOUNT} {CURRENCY}{" "}
                minimum. The machine API accepts an exact per-order amount of at
                least {MIN_AMOUNT} {CURRENCY} (up to 6 decimal places); the
                amount is fixed once the payment link is created.
              </p>
            </CardContent>
          </Card>
        </motion.section>

        {/* Transactions */}
        <section className="mt-12">
          <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">
            Transactions
          </h2>

          {/* Render from cached state; only a genuine first load shows the
              loading row. A transient undefined (e.g. auth-token revalidation)
              must NOT unmount the list/detail tree — that remount cycle was
              observed as rendering instability on mobile. */}
          {ordersQuery === undefined && !hasLoadedOnce ? (
            <div className="mt-5 flex items-center gap-3 text-sm text-slate-400">
              <Loader2 className="size-4 animate-spin" />
              Loading transactions…
            </div>
          ) : orders.length === 0 && hasLoadedOnce ? (
            <Card className="mt-5 max-w-2xl border-white/10 bg-white/[0.03] shadow-none">
              <CardContent className="pt-6 text-sm text-slate-400">
                No transactions yet. Enter a research query above to start one
                — a Moove payment link is created for {MIN_AMOUNT} {CURRENCY}.
              </CardContent>
            </Card>
          ) : !selected ? null : (
            <>
              {/* Transaction list — tappable rows, mobile-first. */}
              <div
                role="listbox"
                aria-label="Transactions"
                className="mt-5 space-y-2"
              >
                {orders.map((o) => {
                  const oStatus = o.status as OrderStatus;
                  const isSelected = selected?._id === o._id;
                  return (
                    <button
                      key={o._id}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => setSelectedId(o._id)}
                      className={`min-h-[44px] w-full cursor-pointer rounded-xl border p-4 text-left transition-colors ${
                        isSelected
                          ? "border-cyan-400/40 bg-cyan-400/[0.06]"
                          : "border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.05]"
                      }`}
                    >
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <Badge
                          variant="outline"
                          className={STATUS_STYLES[oStatus] ?? "border-white/10"}
                        >
                          {oStatus === "completed" && (
                            <Check className="mr-1 size-3" />
                          )}
                          {oStatus}
                        </Badge>
                        <span className="text-sm font-medium tracking-tight">
                          {serviceName(o.serviceId)}
                        </span>
                      </div>
                      <p className="mt-1.5 truncate text-sm text-slate-300">
                        “{o.query}”
                      </p>
                      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-xs text-slate-500">
                        <span>
                          {o.amount} {o.currency}
                        </span>
                        <span>
                          exec:{" "}
                          {o.executedMs != null
                            ? formatMs(o.executedMs)
                            : "—"}
                        </span>
                        <span>{formatDateTime(o.createdAt)}</span>
                      </p>
                    </button>
                  );
                })}
              </div>

              {/* State machine progress */}
              <p className="mt-6 text-xs uppercase tracking-widest text-slate-500">
                Transaction progress
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
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
                  <Badge variant="outline" className={STATUS_STYLES[status]}>
                    {status}
                  </Badge>
                )}
              </div>
              {selected?.error && (
                <p className="mt-3 break-words font-mono text-xs text-red-300">
                  {selected.error}
                </p>
              )}
              {status === "failed_retriable" && (
                <p className="mt-3 text-xs text-orange-300/80">
                  A transient execution failure — this transaction is paid and
                  can be re-run without paying again.
                </p>
              )}

              {/* Transaction detail sections — compact fact cards first,
                  then full-width content sections. */}
              <div className="mt-8 grid gap-6 lg:grid-cols-2">
                {/* Payment */}
                <Card className="border-white/10 bg-white/[0.03] shadow-none">
                  <CardHeader>
                    <CardTitle className="text-base tracking-tight">
                      Payment
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-500">Amount</span>
                      <span className="font-medium">
                        {selected.amount} {selected.currency}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-500">Moove status</span>
                      <span className="font-mono text-xs">
                        {selected.mooveLinkStatus ?? "—"}
                      </span>
                    </div>
                    {selected.paymentConfirmedAt != null && (
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-slate-500">Confirmed</span>
                        <span className="font-mono text-xs">
                          {new Date(selected.paymentConfirmedAt).toLocaleString()}
                        </span>
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-500">Checkout</span>
                      {selected.moovePaymentUrl ? (
                        <a
                          href={selected.moovePaymentUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="flex min-h-[44px] items-center gap-1 text-cyan-300 hover:underline"
                        >
                          Open Moove <ArrowUpRight className="size-3.5" />
                        </a>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </div>
                    {selected.mooveTransactionUrl && (
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-slate-500">Reference</span>
                        <a
                          href={selected.mooveTransactionUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="flex min-h-[44px] items-center gap-1 text-cyan-300 hover:underline"
                        >
                          On-chain <ExternalLink className="size-3.5" />
                        </a>
                      </div>
                    )}
                    {status === "awaiting_payment" && (
                      <p className="pt-1 text-xs leading-relaxed text-slate-500">
                        Complete the payment in the Moove checkout, then check
                        payment below. The link accepts exactly{" "}
                        {selected.amount} {selected.currency}.
                      </p>
                    )}
                    {selected.paymentConfirmedAt != null && (
                      <p className="pt-1 text-xs text-slate-500">
                        Payment is confirmed server-side through Moove.
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
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-500">Status</span>
                      <span className="font-mono text-xs">{status ?? "—"}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-500">Attempts</span>
                      <span className="font-mono text-xs">
                        {selected.executionAttempts ?? 0}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-500">Measured</span>
                      <span className="font-mono text-xs">
                        {selected.executedMs != null
                          ? formatMs(selected.executedMs)
                          : "—"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-500">Target</span>
                      <span className="font-mono text-xs">
                        {RESEARCH_SERVICE.execution.slaTargetMs.toLocaleString()}{" "}
                        ms (not a guarantee)
                      </span>
                    </div>
                    {status === "awaiting_payment" && (
                      <Button
                        className="h-11 w-full cursor-pointer"
                        variant="outline"
                        onClick={handleRun}
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
                        onClick={handleRun}
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

                {/* Service result — full width so the research output gets
                    the space its content needs. */}
                <Card className="border-white/10 bg-white/[0.03] shadow-none lg:col-span-2">
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
                        <div className="flex flex-wrap gap-2 text-xs text-slate-400">
                          <span className="rounded border border-white/10 px-2 py-1 font-mono">
                            query: {result.query}
                          </span>
                          <span className="rounded border border-white/10 px-2 py-1 font-mono">
                            sources: {result.sourcesCount}
                          </span>
                          <span className="rounded border border-white/10 px-2 py-1 font-mono">
                            measured: {formatMs(result.measuredMs)}
                          </span>
                          <span className="rounded border border-white/10 px-2 py-1 font-mono">
                            confidence: {(result.confidence * 100).toFixed(0)}%
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
                        The service result appears here after payment is
                        confirmed and the service runs.
                      </p>
                    )}
                  </CardContent>
                </Card>

                {/* Receipt — full width, mirrors the result section. */}
                <Card className="border-white/10 bg-white/[0.03] shadow-none lg:col-span-2">
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
                            {String(receiptData.resultHash ?? "").slice(0, 19)}
                            …
                          </span>
                          <span className="rounded border border-white/10 px-2 py-1 font-mono text-slate-300">
                            payment: {String(receiptData.paymentStatus ?? "—")}
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
                        The receipt is generated from the persisted transaction
                        data after a successful run.
                      </p>
                    )}
                  </CardContent>
                </Card>
              </div>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
