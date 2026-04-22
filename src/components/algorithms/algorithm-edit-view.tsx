"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { STATUS_LABELS } from "@/lib/constants/algorithm";
import type { Algorithm, AlgorithmRules, AlgorithmStatus } from "@/types/algorithm";
import { RulesEditor } from "./rules-editor";

const STATUS_OPTIONS: AlgorithmStatus[] = ["draft", "active", "paused", "archived"];

interface AlgorithmEditViewProps {
  algorithm: Algorithm;
  onSave: (updates: { name: string; description: string; status: AlgorithmStatus; rules: AlgorithmRules }) => void;
  onCancel: () => void;
  isSaving: boolean;
}

function MetadataEditor({ name, setName, description, setDescription, status, setStatus }: {
  name: string; setName: (v: string) => void;
  description: string; setDescription: (v: string) => void;
  status: AlgorithmStatus; setStatus: (v: AlgorithmStatus) => void;
}) {
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="space-y-1">
          <Label className="text-xs">Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Description</Label>
          <textarea
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm leading-relaxed min-h-[100px] focus:outline-none focus:ring-1 focus:ring-ring"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Status</Label>
          <Select value={status} onValueChange={(v) => setStatus(v as AlgorithmStatus)}>
            <SelectTrigger className="w-40">
              <SelectValue>{STATUS_LABELS[status] ?? status}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((s) => <SelectItem key={s} value={s}>{STATUS_LABELS[s] ?? s}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </CardContent>
    </Card>
  );
}

export function AlgorithmEditView({ algorithm, onSave, onCancel, isSaving }: AlgorithmEditViewProps) {
  const [name, setName] = useState(algorithm.name);
  const [description, setDescription] = useState(algorithm.description);
  const [status, setStatus] = useState<AlgorithmStatus>(algorithm.status);

  function handleRulesSave(rules: AlgorithmRules) {
    onSave({ name, description, status, rules });
  }

  return (
    <div className="space-y-4">
      <MetadataEditor
        name={name} setName={setName}
        description={description} setDescription={setDescription}
        status={status} setStatus={setStatus}
      />
      <RulesEditor
        rules={algorithm.rules}
        onSave={handleRulesSave}
        onCancel={onCancel}
        isSaving={isSaving}
      />
    </div>
  );
}
