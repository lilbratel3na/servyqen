import { motion } from "framer-motion";
import {
  ArrowRight,
  BadgeCheck,
  Boxes,
  CircuitBoard,
  FileJson,
  FlaskConical,
  Gauge,
  ListChecks,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/use-auth";
import logo from "@/assets/logo.svg";

/**
 * The agent-facing API lives on the Convex deployment, not on this Vite
 * host — point machine/API links there. Convex HTTP actions are served on
 * the .convex.site host (the .convex.cloud host serves client RPC). This
 * URL is public and carries no secrets.
 */
const CONVEX_URL = (import.meta.env.VITE_CONVEX_URL as string) ?? "";
const API_BASE = CONVEX_URL.includes(".convex.cloud")
  ? CONVEX_URL.replace(".convex.cloud", ".convex.site")
  : CONVEX_URL;

const steps = [
  {
    icon: Boxes,
    title: "Discover",
    body: "An agent resolves the service index at GET /api/services and finds the AI Research service.",
  },
  {
    icon: FileJson,
    title: "Understand the contract",
    body: "GET /api/services/ai-research-v1/contract returns a machine-readable spec: price, SLA target, input and output schemas.",
  },
  {
    icon: ShieldCheck,
    title: "Pay 1 USDC via Moove",
    body: "A genuine Moove Agentic Payments payment link is created server-side. A human completes the hosted payment — agents never spend from a wallet; confirmation comes only from Moove's status endpoint.",
  },
  {
    icon: BadgeCheck,
    title: "Genuine confirmation",
    body: "Confirmation comes only from Moove's documented status endpoint — never from a button in a UI.",
  },
  {
    icon: FlaskConical,
    title: "Execute",
    body: "Five real arXiv sources are retrieved and synthesized. Wall-clock execution time is measured, not claimed.",
  },
  {
    icon: ListChecks,
    title: "Result + receipt",
    body: "Machine-readable JSON: exactly 5 sources, synthesis, key findings, confidence — plus a hashed receipt.",
  },
];

export default function Landing() {
  const { isLoading, isAuthenticated } = useAuth();
  const ctaLabel = isLoading
    ? "Loading…"
    : isAuthenticated
      ? "Open AgentGate"
      : "Start an order";

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#05070d] text-slate-100">
      {/* ambient grid + glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.14]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(148,163,184,.35) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,.35) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          maskImage:
            "radial-gradient(ellipse 90% 70% at 50% 0%, black 40%, transparent 100%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-[420px] w-[720px] -translate-x-1/2 rounded-full bg-cyan-500/20 blur-[140px]"
      />

      {/* Nav */}
      <header className="relative z-10 border-b border-white/5">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <a href="/" className="flex items-center gap-3">
            <img src={logo} alt="AgentGate" className="h-9 w-9 rounded-lg" />
            <span className="font-bold tracking-tight">AgentGate</span>
            <Badge
              variant="outline"
              className="border-cyan-400/30 bg-cyan-400/10 text-cyan-300"
            >
              V1
            </Badge>
          </a>
          <nav className="flex items-center gap-3">
            <a
              href={`${API_BASE}/api/services`}
              target="_blank"
              rel="noreferrer"
              className="hidden text-sm text-slate-400 transition-colors hover:text-slate-200 sm:block"
            >
              /api/services
            </a>
            <Button
              asChild
              className="cursor-pointer bg-cyan-500 text-[#05070d] hover:bg-cyan-400"
            >
              <a href="/auth?returnTo=%2Fdashboard">{ctaLabel}</a>
            </Button>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <main className="relative z-10">
        <section className="mx-auto max-w-6xl px-6 pb-16 pt-20 sm:pt-28">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="flex flex-col items-start gap-6"
          >
            <Badge
              variant="outline"
              className="gap-2 border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
            >
              <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" />
              Machine-to-service commerce · Moove Agentic Payments
            </Badge>
            <h1 className="max-w-3xl text-4xl font-bold leading-[1.05] tracking-tight sm:text-6xl">
              Agents don't browse.
              <br />
              <span className="bg-gradient-to-r from-cyan-300 via-sky-300 to-violet-300 bg-clip-text text-transparent">
                They read contracts and pay.
              </span>
            </h1>
            <p className="max-w-2xl text-lg leading-relaxed text-slate-400">
              AgentGate is a commerce layer where an AI agent discovers a
              service, reads its machine-readable contract, pays{" "}
              <span className="text-slate-200">1 USDC</span> through a genuine
              Moove payment, and receives a verifiable, machine-readable result
              — in this V1, an AI research service returning exactly five real
              sources.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                asChild
                size="lg"
                className="cursor-pointer bg-cyan-500 text-[#05070d] hover:bg-cyan-400"
              >
                <a href="/auth?returnTo=%2Fdashboard">
                  {ctaLabel} <ArrowRight className="ml-1 size-4" />
                </a>
              </Button>
              <Button
                asChild
                size="lg"
                variant="outline"
                className="cursor-pointer border-white/15 bg-white/5 text-slate-200 hover:bg-white/10"
              >
                <a href={`${API_BASE}/api/services/ai-research-v1/contract`} target="_blank" rel="noreferrer">
                  <Terminal className="mr-1 size-4" />
                  Read the service contract
                </a>
              </Button>
            </div>
          </motion.div>

          {/* Contract snapshot */}
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.15 }}
            className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
          >
            {[
              {
                icon: Gauge,
                label: "Price",
                value: "1 USDC",
                note: "via Moove payment link",
              },
              {
                icon: CircuitBoard,
                label: "Execution target",
                value: "5000 ms",
                note: "target, measured per run — not guaranteed",
              },
              {
                icon: ListChecks,
                label: "Required output",
                value: "Exactly 5 sources",
                note: "+ synthesis, key findings, confidence",
              },
              {
                icon: ShieldCheck,
                label: "Confirmation",
                value: "Server-side only",
                note: "Moove status endpoint, never a UI button",
              },
            ].map((c) => (
              <div
                key={c.label}
                className="rounded-xl border border-white/10 bg-white/[0.03] p-5"
              >
                <c.icon className="size-5 text-cyan-300" />
                <p className="mt-3 text-xs uppercase tracking-widest text-slate-500">
                  {c.label}
                </p>
                <p className="mt-1 font-semibold tracking-tight">{c.value}</p>
                <p className="mt-1 text-xs leading-relaxed text-slate-500">
                  {c.note}
                </p>
              </div>
            ))}
          </motion.div>
        </section>

        {/* Flow */}
        <section className="mx-auto max-w-6xl px-6 pb-24">
          <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">
            The V1 workflow
          </h2>
          <div className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {steps.map((s, i) => (
              <motion.div
                key={s.title}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-60px" }}
                transition={{ duration: 0.4, delay: i * 0.05 }}
                className="group rounded-xl border border-white/10 bg-white/[0.03] p-5 transition-colors hover:border-cyan-400/30 hover:bg-white/[0.05]"
              >
                <div className="flex items-center justify-between">
                  <s.icon className="size-5 text-cyan-300" />
                  <span className="font-mono text-xs text-slate-600">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                </div>
                <h3 className="mt-3 font-semibold tracking-tight">{s.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-slate-400">
                  {s.body}
                </p>
              </motion.div>
            ))}
          </div>
        </section>

        {/* CTA band */}
        <section className="mx-auto max-w-6xl px-6 pb-24">
          <div className="rounded-2xl border border-cyan-400/20 bg-gradient-to-br from-cyan-500/10 via-transparent to-violet-500/10 p-8 sm:p-12">
            <h2 className="max-w-xl text-2xl font-bold tracking-tight sm:text-3xl">
              One workflow. No wallets to manage, no fake test transactions.
            </h2>
            <p className="mt-3 max-w-2xl text-slate-400">
              Sign in, read the contract, initiate a real Moove payment for 1
              USDC, and watch the order move through
              awaiting_payment → payment_confirmed → executing → completed.
            </p>
            <Button
              asChild
              size="lg"
              className="mt-6 cursor-pointer bg-cyan-500 text-[#05070d] hover:bg-cyan-400"
            >
              <a href="/auth?returnTo=%2Fdashboard">
                {ctaLabel} <ArrowRight className="ml-1 size-4" />
              </a>
            </Button>
          </div>
        </section>
      </main>

      <footer className="relative z-10 border-t border-white/5 py-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-6 text-xs text-slate-600 sm:flex-row">
          <span>AgentGate — ProofFlow V1 · machine-to-service commerce</span>
          <span>
            Payments by Moove Agentic Payments · Sources via the public arXiv
            API
          </span>
        </div>
      </footer>
    </div>
  );
}
