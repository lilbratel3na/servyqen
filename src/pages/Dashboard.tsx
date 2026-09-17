import { useQuery, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import {
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Clock,
  Copy,
  ExternalLink,
  FileJson,
  FlaskConical,
  Link2,
  Loader2,
  XCircle,
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

const STATUS_LABELS: Record<OrderStatus, string> = {
  awaiting_payment: "Awaiting payment",
  payment_confirmed: "Payment confirmed",
  executing: "Executing",
  completed: "Completed",
  failed: "Failed",
  failed_retriable: "Failed — retry available",
  expired: "Expired",
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

/** One step of the selected transaction's journey rail. */
function JourneyStep({
  label,
  state,
  caption,
  activeIcon,
}: {
  label: string;
  state: "done" | "active" | "upcoming";
  caption?: string;
  activeIcon?: "confirmed" | "executing" | "awaiting";
}) {
  const color =
    state === "done"
      ? "text-emerald-300"
      : state === "active"
        ? "text-cyan-300"
        : "text-slate-600";
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        {state === "done" ? (
          <CheckCircle2 className={`size-4 shrink-0 ${color}`} />
        ) : state === "active" ? (
          activeIcon === "executing" ? (
            <Loader2 className={`size-4 shrink-0 animate-spin ${color}`} />
          ) : activeIcon === "confirmed" ? (
            <CircleDot className={`size-4 shrink-0 ${color}`} />
          ) : (
            <Clock className={`size-4 shrink-0 ${color}`} />
          )
        ) : (
          <CircleDot className={`size-4 shrink-0 ${color}`} />
        )}
        <span
          className={`truncate text-sm font-medium ${state === "upcoming" ? "text-slate-600" : ""}`}
        >
          {label}
        </span>
      </div>
      {caption && (
        <p className="mt-0.5 truncate text-xs text-slate-500">{caption}</p>
      )}
    </div>
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

/** Newest-first transaction history grouped by status, with a fully
 * interactive row per transaction. Collapsed groups are a summary only —
 * individual identity, timestamp, and query text stay visible on expand. */
function TransactionGroups({
  orders,
  selected,
  onSelect,
}: {
  orders: OrderDoc[];
  selected: OrderDoc | undefined;
  onSelect: (id: Id<"orders">) => void;
}) {
  const groups = useMemo(() => {
    const map = new Map<OrderStatus, OrderDoc[]>();
    for (const o of orders) {
      const s = o.status as OrderStatus;
      if (!map.has(s)) map.set(s, []);
      map.get(s)!.push(o);
    }
    return [...map.entries()];
  }, [orders]);

  const [open, setOpen] = useState<Record<string, boolean>>({});
  const singleGroup = groups.length === 1;

  // A group holding the selected transaction renders expanded without any
  // open-state bookkeeping (the trivial single-group case is always a plain
  // list). Other groups start collapsed ("Awaiting payment · 2") and the
  // user can expand/collapse them at will.
  const selectedGroup = selected
    ? groups.find(([, items]) => items.some((o) => o._id === selected._id))?.[0]
    : undefined;
  const isCollapsedGroup = (status: OrderStatus, count: number) =>
    count > 1 && status !== selectedGroup && !open[status];

  return (
    <div className="space-y-3">
      {groups.map(([groupStatus, items]) => {
        return (
          <div key={groupStatus}>
            {isCollapsedGroup(groupStatus, items.length) ? (
              <button
                type="button"
                aria-expanded={false}
                onClick={() => setOpen((prev) => ({ ...prev, [groupStatus]: true }))}
                className="flex min-h-[44px] w-full cursor-pointer items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2 text-left transition-colors hover:border-white/20 hover:bg-white/[0.05]"
              >
                <span className="flex items-center gap-2 text-sm text-slate-300">
                  <ChevronDown className="size-4 text-slate-500" />
                  {STATUS_LABELS[groupStatus]}
                </span>
                <Badge
                  variant="outline"
                  className={STATUS_STYLES[groupStatus] ?? "border-white/10"}
                >
                  {items.length}
                </Badge>
              </button>
            ) : (
              <div
                role="listbox"
                aria-label={`Transactions — ${STATUS_LABELS[groupStatus]}`}
                className="space-y-2"
              >
                {!singleGroup && items.length > 1 && (
                  <button
                    type="button"
                    aria-expanded={true}
                    onClick={() =>
                      setOpen((prev) => ({ ...prev, [groupStatus]: false }))
                    }
                    className="flex min-h-[44px] w-full cursor-pointer items-center justify-between rounded-xl px-2 py-1 text-left text-sm text-slate-400 transition-colors hover:text-slate-200"
                  >
                    <span className="flex items-center gap-2">
                      <ChevronDown className="size-4 rotate-180 text-slate-500" />
                      {STATUS_LABELS[groupStatus]}
                    </span>
                    <Badge
                      variant="outline"
                      className={STATUS_STYLES[groupStatus] ?? "border-white/10"}
                    >
                      {items.length}
                    </Badge>
                  </button>
                )}
                {items.map((o) => {
                  const isSelected = selected?._id === o._id;
                  return (
                    <button
                      key={o._id}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => onSelect(o._id)}
                      className={`min-h-[44px] w-full cursor-pointer rounded-xl border p-4 text-left transition-colors ${
                        isSelected
                          ? "border-cyan-400/40 bg-cyan-400/[0.06]"
                          : "border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.05]"
                      }`}
                    >
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        {isSelected && (
                          <span
                            aria-hidden
                            className="inline-block size-2 shrink-0 rounded-full bg-cyan-400"
                          />
                        )}
                        <span className="text-sm font-medium tracking-tight">
                          {serviceName(o.serviceId)}
                        </span>
                        <span className="font-mono text-xs text-slate-500">
                          {formatDateTime(o.createdAt)}
                        </span>
                      </div>
                      <p className="mt-1.5 line-clamp-1 text-sm text-slate-300">
                        “{o.query}”
                      </p>
                      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-xs text-slate-500">
                        <span>
                          {o.amount} {o.currency}
                        </span>
                        {o.executedMs != null && (
                          <span>exec: {formatMs(o.executedMs)}</span>
                        )}
                      </p>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

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
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <span
              aria-hidden
              className="inline-block size-1.5 rounded-full bg-emerald-400"
            />
            Signed in as {user?.email ?? "guest"}
          </div>
          <h1 className="mt-1 text-xl font-bold tracking-tight sm:text-2xl">
            Request AI Research
          </h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-400">
            Get a verifiable research brief — 5 real academic sources, synthesis,
            key findings, and a confidence score — for {MIN_AMOUNT} {CURRENCY},
            paid through Moove.
          </p>

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
                Create payment link ({MIN_AMOUNT} {CURRENCY})
              </Button>
              <ol className="space-y-1 text-xs leading-relaxed text-slate-500">
                <li>
                  1. A Moove payment link is created for this query — paying
                  does not start yet.
                </li>
                <li>2. Complete the {MIN_AMOUNT} {CURRENCY} payment at the Moove checkout.</li>
                <li>3. Payment is confirmed server-side, then the research runs and your result + receipt appear below.</li>
              </ol>
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
              <div className="mt-5">
                <TransactionGroups
                  orders={orders}
                  selected={selected}
                  onSelect={setSelectedId}
                />
              </div>

              {/* Selected transaction — state-driven journey */}
              <div className="mt-8 space-y-6">
                <div>
                  <SectionLabel>Selected transaction</SectionLabel>
                  <p className="mt-2 line-clamp-2 text-base font-medium tracking-tight sm:text-lg">
                    “{selected.query}”
                  </p>
                  <p className="mt-1 font-mono text-xs text-slate-500">
                    {formatDateTime(selected.createdAt)} · {selected.amount}{" "}
                    {selected.currency} ·{" "}
                    <span className={status ? "" : "text-slate-600"}>
                      {status ? STATUS_LABELS[status] : "—"}
                    </span>
                  </p>
                </div>

                {/* Journey rail */}
                {(() => {
                  const failedTerminal =
                    status === "failed" ||
                    status === "failed_retriable" ||
                    status === "expired";
                  return (
                    <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4 sm:gap-x-2">
                      {FLOW.map((s, i) => {
                        const reached =
                          failedTerminal
                            ? i === 0 && isPaid
                            : status != null && FLOW.indexOf(status) >= i;
                        const isCurrent = status === s;
                        return (
                          <JourneyStep
                            key={s}
                            label={STATUS_LABELS[s]}
                            state={isCurrent ? "active" : reached ? "done" : "upcoming"}
                            caption={
                              s === "payment_confirmed" && selected.paymentConfirmedAt
                                ? new Date(selected.paymentConfirmedAt).toLocaleString()
                                : s === "executing" && selected.executedMs != null
                                  ? formatMs(selected.executedMs)
                                  : undefined
                            }
                            activeIcon={
                              s === "executing"
                                ? "executing"
                                : s === "payment_confirmed"
                                  ? "confirmed"
                                  : "awaiting"
                            }
                          />
                        );
                      })}
                      {failedTerminal && status && (
                        <div className="col-span-2 sm:col-span-1">
                          <JourneyStep
                            label={STATUS_LABELS[status]}
                            state={status === "failed_retriable" ? "active" : "upcoming"}
                            caption={
                              status === "failed_retriable"
                                ? "Paid — can be re-run"
                                : undefined
                            }
                          />
                        </div>
                      )}
                    </div>
                  );
                })()}
                {selected.error && (
                  <p className="break-words rounded-lg border border-red-400/20 bg-red-400/[0.06] px-3 py-2 font-mono text-xs text-red-300">
                    {selected.error}
                  </p>
                )}
                {status === "failed_retriable" && (
                  <p className="text-xs text-orange-300/80">
                    A transient execution failure — this transaction is paid and
                    can be re-run without paying again.
                  </p>
                )}

                {/* Primary action per state */}
                <div className="max-w-md">
                  {status === "awaiting_payment" && (
                    <div className="space-y-3">
                      <p className="text-sm text-slate-300">
                        Waiting for your {selected.amount} {selected.currency}{" "}
                        payment through Moove.
                      </p>
                      {selected.moovePaymentUrl && (
                        <Button
                          className="h-11 w-full cursor-pointer bg-cyan-500 text-[#05070d] hover:bg-cyan-400"
                          onClick={() =>
                            window.open(selected.moovePaymentUrl, "_blank", "noopener,noreferrer")
                          }
                        >
                          <Link2 className="mr-2 size-4" />
                          Open Moove payment link
                        </Button>
                      )}
                      <p className="text-xs leading-relaxed text-slate-400">
                        After paying, tap the same button to check payment and
                        start execution — the link accepts exactly{" "}
                        {selected.amount} {selected.currency}.
                      </p>
                    </div>
                  )}
                  {status === "payment_confirmed" && (
                    <div className="space-y-3">
                      <p className="text-sm text-slate-300">
                        Payment confirmed — execution is starting or running.
                      </p>
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
                        Re-check status
                      </Button>
                    </div>
                  )}
                  {status === "executing" && (
                    <div className="space-y-3">
                      <p className="flex items-center gap-2 text-sm text-slate-300">
                        <Loader2 className="size-4 animate-spin text-sky-300" />
                        Execution in progress…
                      </p>
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
                        Refresh status
                      </Button>
                    </div>
                  )}
                  {canRetry && (
                    <div className="space-y-3">
                      <p className="text-sm text-slate-300">
                        {status === "expired"
                          ? "Payment arrived late — claim the service to run it."
                          : "Execution failed transiently — you can retry at no extra charge."}
                      </p>
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
                          ? "Claim service"
                          : "Retry execution (already paid)"}
                      </Button>
                    </div>
                  )}
                </div>

                {/* Payment — compact fact rows, no empty filler */}
                <div className="grid gap-6 lg:grid-cols-2">
                  <Card className="border-white/10 bg-white/[0.03] shadow-none">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base tracking-tight text-slate-100">
                        Payment
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-slate-500">Amount</span>
                        <span className="font-medium">
                          {selected.amount} {selected.currency}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-slate-500">Provider</span>
                        <span>Moove Agentic Payments</span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-slate-500">Moove link status</span>
                        <span className="font-mono text-xs">
                          {selected.mooveLinkStatus ?? "—"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-slate-500">
                          {selected.paymentConfirmedAt != null
                            ? "Completed at"
                            : "Not yet completed"}
                        </span>
                        <span className="font-mono text-xs">
                          {selected.paymentConfirmedAt != null
                            ? new Date(selected.paymentConfirmedAt).toLocaleString()
                            : "—"}
                        </span>
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
                    </CardContent>
                  </Card>

                  {/* Execution */}
                  <Card className="border-white/10 bg-white/[0.03] shadow-none">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base tracking-tight text-slate-100">
                        Execution
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2 text-sm">
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
                    </CardContent>
                  </Card>
                </div>

                {/* Service result — the visual centre when completed */}
                <Card
                  className={`border shadow-none ${
                    status === "completed"
                      ? "border-emerald-400/25 bg-emerald-400/[0.03]"
                      : "border-white/10 bg-white/[0.03]"
                  }`}
                >
                  <CardHeader className="flex-row items-center justify-between pb-3">
                    <CardTitle className="text-base tracking-tight text-slate-100">
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
                          <span className="rounded border border-white/10 px-2 py-1 font-mono">
                            provider: {result.provider}
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
                    ) : status === "completed" ? (
                      <div className="flex items-center gap-3 text-sm text-slate-400">
                        <Loader2 className="size-4 animate-spin" />
                        Loading result…
                      </div>
                    ) : status === "failed" ? (
                      <p className="text-sm text-slate-500">
                        This run failed permanently — no result was produced.
                        See the error above.
                      </p>
                    ) : status === "failed_retriable" ? (
                      <p className="text-sm text-slate-500">
                        Execution failed transiently — retry to produce the
                        result.
                      </p>
                    ) : isPaid ? (
                      <div className="flex items-center gap-3 text-sm text-slate-400">
                        <Loader2 className="size-4 animate-spin" />
                        Waiting for the service to produce its result…
                      </div>
                    ) : (
                      <p className="text-sm text-slate-500">
                        The service result appears here once payment is
                        confirmed and the research runs.
                      </p>
                    )}
                  </CardContent>
                </Card>

                {/* Receipt — verification / proof */}
                <Card className="border-white/10 bg-white/[0.03] shadow-none">
                  <CardHeader className="flex-row items-center justify-between pb-3">
                    <CardTitle className="flex items-center gap-2 text-base tracking-tight text-slate-100">
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
                        <div className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-slate-500">Payment status</span>
                            <span className="font-mono text-xs">
                              {String(receiptData.paymentStatus ?? "—")}
                            </span>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-slate-500">Execution status</span>
                            <span className="font-mono text-xs">
                              {String(receiptData.executionStatus ?? "—")}
                            </span>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-slate-500">Executed in</span>
                            <span className="font-mono text-xs">
                              {typeof receiptData.executedMs === "number"
                                ? formatMs(receiptData.executedMs)
                                : "—"}
                            </span>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-slate-500">Result hash</span>
                            <span className="truncate font-mono text-xs">
                              {String(receiptData.resultHash ?? "").slice(0, 19)}…
                            </span>
                          </div>
                          {typeof receiptData.transactionUrl === "string" && (
                            <div className="flex items-center justify-between gap-2 sm:col-span-2">
                              <span className="text-slate-500">Transaction URL</span>
                              <a
                                href={receiptData.transactionUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="flex min-h-[44px] items-center gap-1 text-cyan-300 hover:underline"
                              >
                                View on explorer <ArrowUpRight className="size-3.5" />
                              </a>
                            </div>
                          )}
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
