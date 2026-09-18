import { motion } from "framer-motion";
import {
  ArrowRight,
  BadgeCheck,
  Check,
  FileText,
  FileJson,
  FlaskConical,
  Search,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Link } from "react-router";
import { useAuth } from "@/hooks/use-auth";
import { API_BASE } from "@/lib/api-base";
import { RESEARCH_SERVICE } from "@/lib/agentgate-contract";
import logo from "@/assets/logo.svg";

/** Pricing presentation derived from the service contract — the same source
 * of truth the machine API serves. */
const CURRENCY = RESEARCH_SERVICE.payment.currency;
const MIN_AMOUNT = RESEARCH_SERVICE.payment.minimumAmount;
const SLA_TARGET = RESEARCH_SERVICE.execution.slaTargetMs;

const flow = [
  { icon: Search, title: "Discover", body: "Agent finds the service." },
  { icon: FileText, title: "Contract", body: "Agent reads price, inputs and output." },
  { icon: ShieldCheck, title: "Pay", body: "Moove handles payment authorization." },
  { icon: BadgeCheck, title: "Confirm", body: "Server verifies the completed payment." },
  { icon: FlaskConical, title: "Execute", body: "The service runs after payment." },
  { icon: FileJson, title: "Deliver", body: "Result and receipt are returned." },
];

const serviceFacts = [
  { label: "Payment", value: CURRENCY },
  { label: "Minimum", value: `${MIN_AMOUNT} ${CURRENCY}` },
  { label: "Execution target", value: `${SLA_TARGET.toLocaleString()} ms` },
  { label: "Output", value: "5 sources + synthesis + findings + confidence" },
];

export default function Landing() {
  const { isLoading, isAuthenticated } = useAuth();
  const consoleLabel = isLoading ? "Loading…" : "Start";
  // An existing session (guest or email) goes straight to the Console instead
  // of flashing through the auth screen. While auth is still resolving — or
  // when signed out — /auth remains the safe target: it auto-redirects to
  // /dashboard once an existing session is confirmed.
  const consoleTarget = isAuthenticated
    ? "/dashboard"
    : "/auth?returnTo=%2Fdashboard";

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
        className="pointer-events-none absolute -top-40 left-1/2 h-[420px] w-[720px] -translate-x-1/2 rounded-full bg-cyan-500/10 blur-[140px]"
      />

      {/* Nav */}
      <header className="relative z-10 border-b border-white/5">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-6">
          {/* SPA link: a plain <a href="/"> would perform a full document
              navigation on tap — observed as an apparent page "refresh" on
              mobile. */}
          <Link
            to="/"
            className="flex items-center gap-3"
            aria-label="Home"
          >
            <img src={logo} alt="Logo" className="h-9 w-9 rounded-lg" />
            <span className="font-bold tracking-tight">Servyqen</span>
          </Link>
        </div>
      </header>

      <main className="relative z-10">
        {/* Hero + service card */}
        <section className="mx-auto max-w-6xl px-5 pb-16 pt-12 sm:px-6 sm:pt-20">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="max-w-2xl"
          >
            <Badge
              variant="outline"
              className="border-cyan-400/30 bg-cyan-400/10 text-cyan-300"
            >
              Machine-to-service commerce
            </Badge>
            <h1 className="mt-5 text-4xl font-bold leading-[1.08] tracking-tight sm:text-6xl">
              Services with contracts
              <br />
              <span className="bg-gradient-to-r from-cyan-300 to-sky-300 bg-clip-text text-transparent">
                agents can buy from.
              </span>
            </h1>
            <p className="mt-4 text-base leading-relaxed text-slate-400 sm:text-lg">
              AI agents discover services, read their machine-readable
              contracts, pay through Moove, and receive verifiable results.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Button
                asChild
                size="lg"
                className="h-11 cursor-pointer bg-cyan-500 text-[#05070d] hover:bg-cyan-400"
              >
                <Link to={consoleTarget}>
                  {consoleLabel} <ArrowRight className="ml-1 size-4" />
                </Link>
              </Button>
              <Button
                asChild
                size="lg"
                variant="outline"
                className="h-11 cursor-pointer border-white/15 bg-white/5 text-slate-200 hover:bg-white/10"
              >
                <a href={`${API_BASE}/api/services`} target="_blank" rel="noreferrer">
                  <Terminal className="mr-1 size-4" />
                  Agent API
                </a>
              </Button>
            </div>
          </motion.div>

          {/* Service card */}
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.15 }}
            className="mt-12 max-w-2xl rounded-2xl border border-white/10 bg-white/[0.03] p-6 sm:p-7"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold tracking-tight">
                  AI Research
                </h2>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-400">
                  Research query → 5 real academic sources → synthesis → key
                  findings → confidence.
                </p>
              </div>
              <FlaskConical className="size-6 shrink-0 text-cyan-300" />
            </div>
            <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              {serviceFacts.map((f) => (
                <div key={f.label}>
                  <dt className="text-xs uppercase tracking-widest text-slate-500">
                    {f.label}
                  </dt>
                  <dd className="mt-0.5 font-medium tracking-tight text-slate-200">
                    {f.value}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="mt-4 text-xs leading-relaxed text-slate-500">
              Execution target is a target, not a guarantee — every result
              reports its measured time. Payment is confirmed server-side
              through Moove.
            </p>
            <div className="mt-5">
              <a
                href={`${API_BASE}/api/services/ai-research-v1/contract`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-[44px] items-center gap-1.5 text-sm font-medium text-cyan-300 transition-colors hover:text-cyan-200"
              >
                View contract <ArrowRight className="size-3.5" />
              </a>
            </div>
          </motion.div>
        </section>

        {/* Flow */}
        <section className="mx-auto max-w-6xl px-5 pb-16 sm:px-6 sm:pb-24">
          <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">
            How it works
          </h2>
          <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-6">
            {flow.map((s, i) => (
              <motion.div
                key={s.title}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-60px" }}
                transition={{ duration: 0.35, delay: i * 0.05 }}
                className="rounded-xl border border-white/10 bg-white/[0.03] p-4"
              >
                <div className="flex items-center gap-2">
                  <s.icon className="size-4 text-cyan-300" />
                  <h3 className="font-semibold tracking-tight">{s.title}</h3>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
                  {s.body}
                </p>
              </motion.div>
            ))}
          </div>
        </section>

        {/* Verified transaction — historical evidence from the already-completed
            transaction. Static and clearly labelled; contains no capability
            token, credentials, full payment URL, or live transaction. */}
        <section className="mx-auto max-w-6xl px-5 pb-16 sm:px-6 sm:pb-24">
          <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">
            Verified transaction
          </h2>
          <p className="mt-2 text-sm text-slate-400">
            Evidence from a previous completed run, not a live transaction.
          </p>
          <div className="mt-5 max-w-2xl rounded-xl border border-white/10 bg-white/[0.03] p-5 sm:p-6">
            <Badge
              variant="outline"
              className="border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
            >
              <Check className="mr-1 size-3" />
              Completed
            </Badge>
            <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
              {[
                { label: "Service", value: "AI Research" },
                { label: "Payment", value: `1 ${CURRENCY}` },
                { label: "Sources", value: "5" },
                { label: "Execution", value: "526 ms" },
                { label: "Confidence", value: "100%" },
                { label: "Confirmation", value: "Moove" },
              ].map((f) => (
                <div key={f.label}>
                  <p className="text-xs uppercase tracking-widest text-slate-500">
                    {f.label}
                  </p>
                  <p className="mt-0.5 font-medium tracking-tight text-slate-200">
                    {f.value}
                  </p>
                </div>
              ))}
            </div>
            <p className="mt-4 break-all font-mono text-xs text-slate-500">
              result hash: sha256:a0d26b3a…f512355
            </p>
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer text-cyan-300 transition-colors hover:text-cyan-200">
                View sources
              </summary>
              <ol className="mt-2 space-y-1.5">
                {[
                  { n: 1, title: "PyramidTNT: Improved Transformer-in-Transformer Baselines", url: "http://arxiv.org/abs/2201.00978v1" },
                  { n: 2, title: "Learning to Cluster Faces via Transformer", url: "http://arxiv.org/abs/2104.11502v1" },
                  { n: 3, title: "MLP Can Be A Good Transformer Learner", url: "http://arxiv.org/abs/2404.05657v1" },
                  { n: 4, title: "Multi-Scale Implicit Transformer", url: "http://arxiv.org/abs/2403.06536v1" },
                  { n: 5, title: "Music Transformer", url: "http://arxiv.org/abs/1809.04281v3" },
                ].map((s) => (
                  <li key={s.n} className="text-xs">
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-cyan-300 hover:underline"
                    >
                      [{s.n}] {s.title}
                    </a>
                  </li>
                ))}
              </ol>
            </details>
          </div>
        </section>
      </main>

      <footer className="relative z-10 border-t border-white/5 py-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-5 text-xs text-slate-600 sm:flex-row sm:px-6">
          <span>Servyqen · machine-to-service commerce</span>
          <span>
            Payments by Moove Agentic Payments · Sources via the public arXiv
            API
          </span>
        </div>
      </footer>
    </div>
  );
}
