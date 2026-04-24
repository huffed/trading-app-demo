"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Upload, FileText, Check, AlertCircle, ArrowLeft } from "lucide-react";
import Papa from "papaparse";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useImportTrades } from "@/hooks/use-trades";
import { csvRowSchema, type TradeFormValues } from "@/lib/validators/trade";
import { PreviewTable, type ParsedRow } from "./preview-table";

interface ImportSuccessProps {
  result: { imported: number; errors: string[] };
  onViewTrades: () => void;
}

function ImportSuccess({ result, onViewTrades }: ImportSuccessProps) {
  return (
    <Card>
      <CardContent className="py-8 text-center">
        <Check className="mx-auto h-8 w-8 text-[var(--profit)] mb-3" />
        <p className="font-medium">
          {result.imported} trade{result.imported !== 1 && "s"} imported
        </p>
        {result.errors.length > 0 && (
          <p className="text-sm text-muted-foreground mt-1">
            {result.errors.length} row
            {result.errors.length !== 1 && "s"} skipped
          </p>
        )}
        <Button className="mt-4" onClick={onViewTrades}>
          View Trades
        </Button>
      </CardContent>
    </Card>
  );
}

interface UploadAreaProps {
  onDrop: (e: React.DragEvent) => void;
  onFileInput: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

function UploadArea({ onDrop, onFileInput }: UploadAreaProps) {
  return (
    <Card>
      <CardContent
        className="flex flex-col items-center justify-center py-12 cursor-pointer"
        onDrop={onDrop}
        onDragOver={(e) => e.preventDefault()}
        onClick={() => document.getElementById("csv-input")?.click()}
      >
        <Upload className="h-8 w-8 text-muted-foreground mb-3" />
        <p className="text-sm font-medium">Drop a CSV file here or click to browse</p>
        <p className="text-xs text-muted-foreground mt-1">
          Required columns: symbol, side, quantity, entry_price, entry_date
        </p>
        <p className="text-xs text-muted-foreground">
          Optional: exit_price, exit_date, commission, fees, strategy, notes, asset_class
        </p>
        <input id="csv-input" type="file" accept=".csv" className="hidden" onChange={onFileInput} />
      </CardContent>
    </Card>
  );
}

interface ImportPreviewProps {
  fileName: string;
  parsedRows: ParsedRow[];
  validCount: number;
  errorCount: number;
  isPending: boolean;
  onReset: () => void;
  onImport: () => void;
}

function ImportPreview({
  fileName,
  parsedRows,
  validCount,
  errorCount,
  isPending,
  onReset,
  onImport,
}: ImportPreviewProps) {
  return (
    <>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">{fileName}</span>
          <Badge variant="secondary" className="text-xs">
            {parsedRows.length} rows
          </Badge>
          {validCount > 0 && (
            <Badge className="text-xs bg-[var(--profit)]/10 text-[var(--profit)]">
              {validCount} valid
            </Badge>
          )}
          {errorCount > 0 && (
            <Badge variant="destructive" className="text-xs">
              {errorCount} errors
            </Badge>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onReset}>
            Reset
          </Button>
          <Button size="sm" disabled={validCount === 0 || isPending} onClick={onImport}>
            {isPending
              ? "Importing..."
              : `Import ${validCount} trade${validCount !== 1 ? "s" : ""}`}
          </Button>
        </div>
      </div>

      {errorCount > 0 && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {errorCount} row{errorCount !== 1 && "s"} have validation errors and will be skipped.
          </AlertDescription>
        </Alert>
      )}

      <PreviewTable parsedRows={parsedRows} />
    </>
  );
}

function parseCsvRow(raw: unknown, i: number): ParsedRow {
  const data = raw as Record<string, string>;
  const result = csvRowSchema.safeParse(data);
  if (result.success) {
    return {
      data,
      parsed: {
        ...result.data,
        status: result.data.exit_price != null ? "closed" : ("open" as const),
        tags: [],
        currency: "USD",
      } as TradeFormValues,
      error: null,
      rowIndex: i + 1,
    };
  }
  return {
    data,
    parsed: null,
    error: result.error.issues[0].message,
    rowIndex: i + 1,
  };
}

function ImportPageHeader() {
  return (
    <div className="flex items-center gap-3">
      <Button variant="ghost" size="icon-sm" render={<Link href="/trades" />} nativeButton={false}>
        <ArrowLeft className="h-4 w-4" />
      </Button>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Import Trades</h1>
        <p className="text-sm text-muted-foreground">Upload a CSV file to bulk import trades.</p>
      </div>
    </div>
  );
}

export default function ImportPage() {
  const router = useRouter();
  const importTrades = useImportTrades();
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<{
    imported: number;
    errors: string[];
  } | null>(null);

  const handleFile = useCallback((file: File) => {
    setFileName(file.name);
    setImportResult(null);
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, "_"),
      complete: (results) => {
        setParsedRows(results.data.map(parseCsvRow));
      },
      error: () => {
        setFileName(null);
        setParsedRows([]);
      },
    });
  }, []);

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith(".csv")) handleFile(file);
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }

  async function handleImport() {
    const validRows = parsedRows.filter((r) => r.parsed != null).map((r) => r.parsed!);
    const result = await importTrades.mutateAsync(validRows);
    if (result.success) {
      setImportResult(result.data);
    }
  }

  const validCount = parsedRows.filter((r) => r.parsed != null).length;
  const errorCount = parsedRows.filter((r) => r.error != null).length;

  return (
    <div className="space-y-4">
      <ImportPageHeader />

      {importResult && (
        <ImportSuccess result={importResult} onViewTrades={() => router.push("/trades")} />
      )}
      {!importResult && !fileName && (
        <UploadArea onDrop={handleDrop} onFileInput={handleFileInput} />
      )}
      {!importResult && fileName && (
        <ImportPreview
          fileName={fileName}
          parsedRows={parsedRows}
          validCount={validCount}
          errorCount={errorCount}
          isPending={importTrades.isPending}
          onReset={() => {
            setParsedRows([]);
            setFileName(null);
          }}
          onImport={handleImport}
        />
      )}
    </div>
  );
}
