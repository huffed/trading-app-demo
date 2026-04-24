"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { JournalForm } from "@/components/journal/journal-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default function NewJournalEntryPage() {
  const router = useRouter();

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon-sm"
          render={<Link href="/journal" />}
          nativeButton={false}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">New Journal Entry</h1>
          <p className="text-sm text-muted-foreground">Take a moment to reflect on your trading.</p>
        </div>
      </div>

      <Card>
        <CardContent className="p-6">
          <JournalForm onSuccess={() => router.push("/journal")} />
        </CardContent>
      </Card>
    </div>
  );
}
