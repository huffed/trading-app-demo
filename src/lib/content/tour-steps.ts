export interface TourStep {
  id: string;
  title: string;
  description: string;
  icon: string;
  target?: string;
}

export const tourSteps: TourStep[] = [
  {
    id: "welcome",
    title: "Welcome to QuantTrader",
    description:
      "Quick tour of the surfaces you'll use day-to-day. Each step highlights where the feature lives in the sidebar.",
    icon: "👋",
  },
  {
    id: "dashboard",
    title: "Dashboard",
    description:
      "Live ops at a glance — active algos, last scan, open positions, unrealized P&L, and a Scan-all button when you need to evaluate mid-bar.",
    icon: "📊",
    target: "[data-tour='dashboard']",
  },
  {
    id: "algorithms",
    title: "Algorithms",
    description:
      "Your library of deployed algorithms grouped by strategy. Each card shows status, last activity, and a detail page for backtest stats, LLM decisions, and the readiness check.",
    icon: "🤖",
    target: "[data-tour='algorithms']",
  },
  {
    id: "reports",
    title: "Reports",
    description:
      "Engine activity and per-cohort attribution — how each algorithm and cluster performed. The source of truth for what's working and what isn't.",
    icon: "📈",
    target: "[data-tour='reports']",
  },
  {
    id: "chart",
    title: "Chart",
    description:
      "Live TA chart with ICT/SMC patterns, indicators, your paper-trade markers, and an OANDA live-price line that ticks every 5 seconds.",
    icon: "📉",
    target: "[data-tour='chart']",
  },
  {
    id: "done",
    title: "You're All Set",
    description:
      "Algorithms run on the scan cron every 15 minutes. The Dashboard and Reports pages will populate as scans fire.",
    icon: "🚀",
  },
];
