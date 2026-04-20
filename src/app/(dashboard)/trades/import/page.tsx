import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

export default function ImportTradesPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Import Trades</h1>
          <p className="text-sm text-muted-foreground">
            Import trades from CSV or connect a broker.
          </p>
        </div>
        <Badge variant="secondary">Coming soon</Badge>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Upload CSV</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-40 w-full" />
        </CardContent>
      </Card>
    </div>
  );
}
