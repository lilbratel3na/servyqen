import { useMutation, useQuery, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useState } from "react";
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
  ShieldCheck,
  Timer,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { LogoDropdown } from "@/components/LogoDropdown";
import { useAuth } from "@/hooks/use-auth";
import { RESEARCH_SERVICE } from "@/lib/agentgate-contract";

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

export default function Dashboard() {
  const { user } = useAuth();
  const orders = useQuery(api.orders.listMine) ?? [];
  const initiate = useAction(api.agentgate.initiateOrder);
  const runOrder = useAction(api.agentgate.runOrder);

  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  const activeOrder = orders[0];
  const orderId = activeOrder?._id as Id<"orders"> | undefined;
  const result = useQuery(
    api.orders.getResult,
    orderId ? { orderId } : "skip",
  );
  const receipt = useQuery(
    api.orders.getReceipt,
    orderId ? { orderId } : "skip",
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
      window.open(paymentUrl, "_blank", "noopener,noreferrer");
      toast.success(
        "Real Moove payment link created — complete the 1 USDC payment in the opened tab.",
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
    if (!orderId || busy) return;
    setBusy(true);
    try {
      const res = await runOrder({ orderId });
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

  const copy = (value: unknown) => {
    navigator.clipboard
      .writeText(JSON.stringify(value, null, 2))
      .then(() => toast.success("Copied JSON to clipboard."))
      .catch(() => toast.error("Clipboard unavailable."));
  };

  return (
    <div className="min-h-screen bg-[#05070d] text-slate-100">
      <header className="border-b border-white/5">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <LogoDropdown />
            <span className="font-bold tracking-tight">AgentGate</span>
            <Badge
              variant="outline"
              className="border-cyan-400/30 bg-cyan-400/10 text-cyan-300"
            >
              V1
            </Badge>
          </div>
          <a
            href="/api/services/ai-research-v1/contract"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-sm text-slate-400 transition-colors hover:text-slate-200"
          >
            Public contract endpoint <ExternalLink className="size-3.5" />
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        {/* Contract */}
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
          <p className="text-sm text-slate-500">
            Signed in as {user?.email ?? "guest"} · Service contract
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">
            {RESEARCH_SERVICE.name}
          </h1>

          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="border-white/10 bg-white/[0.03] shadow-none">
              <CardContent className="pt-6">
                <p className="text-xs uppercase tracking-widest text-slate-500">
                  Price
                </p>
                <p className="mt-1 text-2xl font-bold tracking-tight">
                  {RESEARCH_SERVICE.payment.amount}{" "}
                  {RESEARCH_SERVICE.payment.currency}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  via Moove payment link
                </p>
              </CardContent>
            </Card>
            <Card className="border-white/10 bg-white/[0.03] shadow-none">
              <CardContent className="pt-6">
                <p className="text-xs uppercase tracking-widest text-slate-500">
                  Execution target
                </p>
                <p className="mt-1 flex items-center gap-2 text-2xl font-bold tracking-tight">
                  <Timer className="size-5 text-cyan-300" />
                  {RESEARCH_SERVICE.execution.slaTargetMs} ms
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  target — measured per run, never guaranteed
                </p>
              </CardContent>
            </Card>
            <Card className="border-white/10 bg-white/[0.03] shadow-none">
              <CardContent className="pt-6">
                <p className="text-xs uppercase tracking-widest text-slate-500">
                  Required output
                </p>
                <p className="mt-1 text-lg font-bold tracking-tight">
                  Exactly 5 sources
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  + synthesis, key findings, confidence
                </p>
              </CardContent>
            </Card>
            <Card className="border-white/10 bg-white/[0.03] shadow-none">
              <CardContent className="pt-6">
                <p className="text-xs uppercase tracking-widest text-slate-500">
                  Confirmation
                </p>
                <p className="mt-1 flex items-center gap-2 text-lg font-bold tracking-tight">
                  <ShieldCheck className="size-5 text-emerald-300" />
                  Server-side only
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Moove status endpoint — not a UI button
                </p>
              </CardContent>
            </Card>
          </div>
        </motion.section>

        <Separator className="my-10 bg-white/5" />

        {/* Order console */}
        <section className="grid gap-6 lg:grid-cols-5">
          <div className="lg:col-span-2 space-y-6">
            <Card className="border-white/10 bg-white/[0.03] shadow-none">
              <CardHeader>
                <CardTitle className="tracking-tight">
                  Start a transaction
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="e.g. scaling laws for sparse mixture-of-experts"
                  disabled={busy}
                  className="border-white/10 bg-white/5"
                />
                <Button
                  className="w-full cursor-pointer bg-cyan-500 text-[#05070d] hover:bg-cyan-400"
                  onClick={handleInitiate}
                  disabled={busy}
                >
                  {busy ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : (
                    <FlaskConical className="mr-2 size-4" />
                  )}
                  Pay 1 USDC with Moove
                </Button>
                <p className="text-xs leading-relaxed text-slate-500">
                  Creates a genuine Moove Agentic Payments payment link for
                  exactly 1 USDC and opens the real checkout. Confirmation
                  happens only when Moove reports the link paid.
                </p>
              </CardContent>
            </Card>

            {activeOrder && (
              <Card className="border-white/10 bg-white/[0.03] shadow-none">
                <CardHeader>
                  <CardTitle className="tracking-tight">
                    Live transaction
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500">Status</span>
                    <Badge
                      variant="outline"
                      className={
                        STATUS_STYLES[activeOrder.status as OrderStatus] ??
                        "border-white/10"
                      }
                    >
                      {activeOrder.status}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-500">Payment link</span>
                    <a
                      href={activeOrder.moovePaymentUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1 text-cyan-300 hover:underline"
                    >
                      Open <ArrowUpRight className="size-3.5" />
                    </a>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500">Moove status</span>
                    <span className="font-mono text-xs">
                      {activeOrder.mooveLinkStatus ?? "—"}
                    </span>
                  </div>
                  {activeOrder.mooveTransactionUrl && (
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">Tx</span>
                      <a
                        href={activeOrder.mooveTransactionUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1 text-cyan-300 hover:underline"
                      >
                        On-chain proof <ExternalLink className="size-3.5" />
                      </a>
                    </div>
                  )}
                  {activeOrder.executedMs != null && (
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">Measured</span>
                      <span className="font-mono text-xs">
                        {activeOrder.executedMs} ms
                      </span>
                    </div>
                  )}
                  {(activeOrder.status === "awaiting_payment" ||
                    activeOrder.status === "expired" ||
                    activeOrder.status === "failed_retriable") && (
                    <Button
                      className="w-full cursor-pointer"
                      variant="outline"
                      onClick={handleRun}
                      disabled={busy}
                    >
                      {busy ? (
                        <Loader2 className="mr-2 size-4 animate-spin" />
                      ) : (
                        <CircleDot className="mr-2 size-4" />
                      )}
                      {activeOrder.status === "failed_retriable"
                        ? "Retry execution (already paid)"
                        : "Check payment & execute"}
                    </Button>
                  )}
                </CardContent>
              </Card>
            )}
          </div>

          {/* Result + receipt */}
          <div className="lg:col-span-3 space-y-6">
            {/* state machine progress */}
            <Card className="border-white/10 bg-white/[0.03] shadow-none">
              <CardContent className="pt-6">
                <div className="flex flex-wrap items-center gap-2">
                  {FLOW.map((s, i) => {
                    const order =
                      activeOrder?.status === "completed" ? "completed" : activeOrder?.status;
                    const reached =
                      order != null &&
                      FLOW.indexOf(order as OrderStatus) >= i &&
                      order !== "failed" &&
                      order !== "expired";
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
                          {reached ? <Check className="mr-1 size-3" /> : null}
                          {s}
                        </Badge>
                        {i < FLOW.length - 1 && (
                          <span className="text-slate-700">→</span>
                        )}
                      </div>
                    );
                  })}
                  {activeOrder &&
                    (activeOrder.status === "failed" ||
                      activeOrder.status === "expired") && (
                      <Badge
                        variant="outline"
                        className={STATUS_STYLES[activeOrder.status]}
                      >
                        {activeOrder.status}
                      </Badge>
                    )}
                </div>
                {activeOrder?.error && (
                  <p className="mt-3 break-words font-mono text-xs text-red-300">
                    {activeOrder.error}
                  </p>
                )}
              </CardContent>
            </Card>

            {result ? (
              <Card className="border-white/10 bg-white/[0.03] shadow-none">
                <CardHeader className="flex-row items-center justify-between">
                  <CardTitle className="tracking-tight">
                    Machine-readable result
                  </CardTitle>
                  <Button
                    size="sm"
                    variant="outline"
                    className="cursor-pointer border-white/10"
                    onClick={() => copy(result)}
                  >
                    <Copy className="mr-1 size-3.5" /> Copy JSON
                  </Button>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex flex-wrap gap-2 text-xs text-slate-400">
                    <span className="rounded border border-white/10 px-2 py-1 font-mono">
                      sources: {result.sourcesCount}
                    </span>
                    <span className="rounded border border-white/10 px-2 py-1 font-mono">
                      measured: {result.measuredMs} ms
                    </span>
                    <span className="rounded border border-white/10 px-2 py-1 font-mono">
                      confidence: {(result.confidence * 100).toFixed(0)}%
                    </span>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-widest text-slate-500">
                      Synthesis
                    </p>
                    <p className="mt-1 text-sm leading-relaxed text-slate-300">
                      {result.synthesis}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-widest text-slate-500">
                      Key findings
                    </p>
                    <ul className="mt-1 space-y-1">
                      {result.keyFindings.map((f, i) => (
                        <li key={i} className="text-sm leading-relaxed text-slate-300">
                          • {f}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-widest text-slate-500">
                      Sources ({result.sources.length})
                    </p>
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
                </CardContent>
              </Card>
            ) : (
              activeOrder &&
              activeOrder.status !== "awaiting_payment" && (
                <Card className="border-white/10 bg-white/[0.03] shadow-none">
                  <CardContent className="flex items-center gap-3 pt-6 text-sm text-slate-400">
                    <Loader2 className="size-4 animate-spin" />
                    Waiting for the service to produce its result…
                  </CardContent>
                </Card>
              )
            )}

            {receipt && (
              <Card className="border-white/10 bg-white/[0.03] shadow-none">
                <CardHeader className="flex-row items-center justify-between">
                  <CardTitle className="flex items-center gap-2 tracking-tight">
                    <FileJson className="size-5 text-emerald-300" />
                    Transaction receipt
                  </CardTitle>
                  <Button
                    size="sm"
                    variant="outline"
                    className="cursor-pointer border-white/10"
                    onClick={() => copy(receipt.receipt)}
                  >
                    <Copy className="mr-1 size-3.5" /> Copy receipt
                  </Button>
                </CardHeader>
                <CardContent>
                  <pre className="max-h-72 overflow-auto rounded-lg border border-white/10 bg-black/40 p-4 font-mono text-xs leading-relaxed text-slate-300">
                    {JSON.stringify(receipt.receipt, null, 2)}
                  </pre>
                </CardContent>
              </Card>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
