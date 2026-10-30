import type { JSX } from "react";
import { Input } from "@/components/ui/input";

/** Labelled email input shared by the login and signup forms. */
export function EmailField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="email" className="text-sm font-medium">
        Email
      </label>
      <Input
        id="email"
        type="email"
        placeholder="you@example.com"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        required
      />
    </div>
  );
}
