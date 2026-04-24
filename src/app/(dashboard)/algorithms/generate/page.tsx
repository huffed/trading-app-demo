import Link from "next/link";
import { ArrowLeft, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default function GenerateAlgorithmPage() {
  return (
    <div className="mx-auto max-w-md space-y-4">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon-sm"
          render={<Link href="/algorithms" />}
          nativeButton={false}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">Generate Algorithm</h1>
      </div>
      <Card>
        <CardContent className="py-8 text-center space-y-4">
          <MessageCircle className="h-8 w-8 text-primary mx-auto" />
          <div className="space-y-1">
            <p className="text-sm font-medium">Use the AI Chat to create algorithms</p>
            <p className="text-xs text-muted-foreground">
              Click the chat button in the bottom-right corner and tell the AI what kind of
              algorithm you want. It will ask you questions and build it for you.
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            Try saying: &quot;Create me a trading algorithm for crypto&quot;
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
