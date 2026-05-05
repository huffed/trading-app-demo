"use client";

/**
 * Pilot page for the redesigned UI. Composes the new design-system
 * primitives (`Surface`, `Stat`, `DataRow`, `KpiStrip`, `DashboardGrid`,
 * `ContentShell`) over mock data so the look + feel can be evaluated
 * without touching a real page.
 *
 * Temporary — deleted once the dashboard rebuild migrates real pages
 * onto these primitives.
 */
import { Activity, ArrowUpRight, TrendingUp } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { ContentShell } from "@/components/layout/content-shell";
import { DashboardGrid } from "@/components/layout/dashboard-grid";
import { KpiStrip } from "@/components/layout/kpi-strip";
import { Badge } from "@/components/ui/badge";
import { DataRow } from "@/components/ui/data-row";
import { Stat } from "@/components/ui/stat";
import { Surface } from "@/components/ui/surface";

const MOCK_CURVE = Array.from({ length: 30 }, (_, i) => ({
  date: `d${i + 1}`,
  value: Math.round(1000 + i * 80 + Math.sin(i / 3) * 400),
}));

const MOCK_POSITIONS = [
  { id: "p1", ticker: "XAU/USD", side: "Long", entry: "4523.40", pnl: "+$340", state: "profit" },
  { id: "p2", ticker: "XAU/USD", side: "Short", entry: "4587.20", pnl: "-$120", state: "loss" },
  { id: "p3", ticker: "XAU/USD", side: "Long", entry: "4501.10", pnl: "+$60", state: "profit" },
] as const;

const MOCK_ACTIVITY = [
  { id: "a1", time: "09:42", text: "Position opened — XAU/USD long @ 4523.40" },
  { id: "a2", time: "09:38", text: "LLM decision — confidence 78% (HH regime)" },
  { id: "a3", time: "08:30", text: "Scan started — 1 algorithm active" },
  { id: "a4", time: "08:00", text: "Manage tick — 2 positions synced from broker" },
];

function PageHeader() {
  return (
    <div className="mb-6 flex items-center justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Design system preview</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pilot page composing the new glass primitives over mock data.
        </p>
      </div>
      <Badge variant="outline" className="border-glass-border-strong">
        <span className="font-mono text-xs">PILOT · /preview</span>
      </Badge>
    </div>
  );
}

function EquityCard() {
  return (
    <Surface elevation="mid" className="p-5 lg:col-span-8">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Cumulative P&amp;L
          </p>
          <p className="mt-1 font-mono text-3xl font-semibold tabular-nums text-[var(--profit)]">
            +$3,420
          </p>
        </div>
        <Badge variant="outline" className="border-glass-border">
          <TrendingUp className="mr-1 h-3 w-3" /> 30d
        </Badge>
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <AreaChart data={MOCK_CURVE} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
          <defs>
            <linearGradient id="previewGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--color-chart-1)" stopOpacity={0.4} />
              <stop offset="95%" stopColor="var(--color-chart-1)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="date" hide />
          <YAxis hide />
          <Area
            type="monotone"
            dataKey="value"
            stroke="var(--color-chart-1)"
            fill="url(#previewGradient)"
            strokeWidth={2}
          />
        </AreaChart>
      </ResponsiveContainer>
    </Surface>
  );
}

function PositionsCard() {
  return (
    <Surface elevation="mid" className="p-5 lg:col-span-4">
      <p className="mb-3 text-xs uppercase tracking-wide text-muted-foreground">Open positions</p>
      <div className="flex flex-col">
        {MOCK_POSITIONS.map((p) => (
          <DataRow
            key={p.id}
            label={p.ticker}
            hint={`${p.side} @ ${p.entry}`}
            value={
              <span
                className={
                  p.state === "profit" ? "text-[var(--profit)]" : "text-[var(--loss)]"
                }
              >
                {p.pnl}
              </span>
            }
          />
        ))}
      </div>
    </Surface>
  );
}

function AlgorithmCard() {
  return (
    <Surface elevation="mid" interactive className="p-5 lg:col-span-6">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Active algorithm</p>
          <p className="mt-1 text-base font-medium">Gold LLM-Trader v1</p>
        </div>
        <ArrowUpRight className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="flex flex-col">
        <DataRow label="Timeframe" value="4h" />
        <DataRow label="Risk per trade" value="1.0%" />
        <DataRow label="Stop loss" value="1.5%" hint="MVP — see structural-SL roadmap" />
        <DataRow label="LLM provider" value="Anthropic Haiku" />
      </div>
    </Surface>
  );
}

function ActivityCard() {
  return (
    <Surface elevation="mid" className="p-5 lg:col-span-6">
      <div className="mb-3 flex items-center gap-2">
        <Activity className="h-4 w-4 text-muted-foreground" />
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Recent activity</p>
      </div>
      <ul className="space-y-2">
        {MOCK_ACTIVITY.map((e) => (
          <li key={e.id} className="flex items-start gap-3 text-sm">
            <span className="font-mono text-xs text-muted-foreground tabular-nums">{e.time}</span>
            <span className="text-foreground">{e.text}</span>
          </li>
        ))}
      </ul>
    </Surface>
  );
}

function InspectorRail() {
  return (
    <div className="space-y-4">
      <Surface elevation="low" className="p-4">
        <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Live status</p>
        <div className="flex flex-col">
          <DataRow label="Broker" value="MetaApi MT5" />
          <DataRow label="Last scan" value="2m ago" />
          <DataRow label="Drift state" value={<span className="text-[var(--profit)]">OK</span>} />
          <DataRow label="DLL distance" value="-3.2%" />
        </div>
      </Surface>
      <Surface elevation="low" className="p-4">
        <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Compliance</p>
        <div className="flex flex-col">
          <DataRow label="Today's loss" value={<span className="text-[var(--profit)]">0.0%</span>} />
          <DataRow label="Drawdown" value="2.1%" hint="Threshold 10%" />
          <DataRow label="Profit target" value="3.4%" hint="Threshold 10%" />
        </div>
      </Surface>
    </div>
  );
}

export default function PreviewPage() {
  return (
    <ContentShell inspector={<InspectorRail />}>
      <PageHeader />
      <KpiStrip className="mb-6">
        <Stat label="Today" value="+$1,240" delta="+1.24% · 4 trades" state="profit" />
        <Stat label="Open positions" value="3" delta="2 long · 1 short" />
        <Stat label="Week" value="+$3,420" delta="+3.42%" state="profit" />
        <Stat label="DLL distance" value="-3.2%" delta="Threshold 5%" state="warn" />
      </KpiStrip>
      <DashboardGrid>
        <EquityCard />
        <PositionsCard />
        <AlgorithmCard />
        <ActivityCard />
      </DashboardGrid>
    </ContentShell>
  );
}
