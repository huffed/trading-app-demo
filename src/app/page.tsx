import Link from "next/link";
import { ArrowRight, BarChart3, Bot, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";

const features = [
  {
    icon: Bot,
    title: "Autonomous LLM trader",
    desc: "Per-bar entry decisions from Claude Haiku, audited and replayable.",
  },
  {
    icon: ShieldCheck,
    title: "Deterministic risk engine",
    desc: "Structural SL/TP, daily DD halts, consistency rules — never bypassed by the LLM.",
  },
  {
    icon: BarChart3,
    title: "Paper to live, mirrored",
    desc: "Validate on paper, then mirror to a connected MT5 broker via MetaApi.",
  },
];

function FeatureCards() {
  return (
    <div className="mt-20 grid max-w-3xl gap-8 sm:grid-cols-3">
      {features.map((feature) => (
        <div key={feature.title} className="text-center space-y-2">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <feature.icon className="h-5 w-5 text-primary" />
          </div>
          <h3 className="text-sm font-semibold">{feature.title}</h3>
          <p className="text-xs text-muted-foreground">{feature.desc}</p>
        </div>
      ))}
    </div>
  );
}

export default function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-14 items-center border-b border-border px-6">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary">
            <span className="text-xs font-bold text-primary-foreground">Q</span>
          </div>
          <span className="font-semibold">QuantTrader</span>
        </div>
        <nav className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" render={<Link href="/login" />}>
            Sign in
          </Button>
          <Button size="sm" render={<Link href="/signup" />}>
            Get started
          </Button>
        </nav>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <div className="max-w-2xl space-y-6">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Smarter trading,
            <br />
            <span className="text-primary">powered by AI</span>
          </h1>
          <p className="text-lg text-muted-foreground">
            AI-generated algorithms, intelligent trade journaling, and multi-broker integration.
            Everything you need to trade profitably.
          </p>
          <div className="flex items-center justify-center gap-3">
            <Button size="lg" render={<Link href="/signup" />}>
              Start trading
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </div>
        </div>

        <FeatureCards />
      </main>
    </div>
  );
}
