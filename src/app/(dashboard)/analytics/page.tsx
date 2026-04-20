import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function AnalyticsPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
          <p className="text-sm text-muted-foreground">
            Performance metrics and trading statistics.
          </p>
        </div>
        <Badge variant="secondary">Coming soon</Badge>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {["Equity Curve", "Drawdown", "Win/Loss Distribution", "Trade Duration"].map(
          (title) => (
            <Card key={title}>
              <CardHeader>
                <CardTitle className="text-sm font-medium">{title}</CardTitle>
              </CardHeader>
              <CardContent>
                <Skeleton className="h-40 w-full" />
              </CardContent>
            </Card>
          )
        )}
      </div>
    </div>
  );
}
