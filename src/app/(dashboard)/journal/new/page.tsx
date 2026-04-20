import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

export default function NewJournalEntryPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            New Journal Entry
          </h1>
          <p className="text-sm text-muted-foreground">
            Document your trade reasoning and emotions.
          </p>
        </div>
        <Badge variant="secondary">Coming soon</Badge>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Entry Editor</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-64 w-full" />
        </CardContent>
      </Card>
    </div>
  );
}
