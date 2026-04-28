import Link from "next/link";
import { ArrowLeft, Briefcase } from "lucide-react";
import { listPortfolios } from "@/app/(dashboard)/portfolios/actions";
import { CorrelationCard } from "@/components/portfolios/correlation-card";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function PortfoliosPage() {
  const result = await listPortfolios();
  const portfolios = result.success ? result.data : [];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon-sm"
          render={<Link href="/dashboard" />}
          nativeButton={false}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Briefcase className="h-5 w-5" />
            Portfolios
          </h1>
          <p className="text-sm text-muted-foreground">
            Cross-algorithm correlation per portfolio. Stacking correlated strategies multiplies
            risk without diversifying — flag pairs above ±0.7 before adding more algorithms.
          </p>
        </div>
      </div>
      <div className="max-w-2xl space-y-4">
        {!result.success && (
          <p className="text-sm text-[var(--loss)]">{result.error}</p>
        )}
        {result.success && portfolios.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No portfolios yet. Group algorithms into a portfolio to share capital and prop-firm
            rules across them.
          </p>
        )}
        {portfolios.map((p) => (
          <CorrelationCard key={p.id} portfolioId={p.id} portfolioName={p.name} />
        ))}
      </div>
    </div>
  );
}
