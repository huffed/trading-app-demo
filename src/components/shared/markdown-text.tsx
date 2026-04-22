"use client";

interface MarkdownTextProps {
  text: string;
  className?: string;
}

function parseLine(line: string): React.ReactNode {
  // Bold: **text**
  const parts = line.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

export function MarkdownText({ text, className }: MarkdownTextProps) {
  const lines = text.split("\n");

  return (
    <div className={className}>
      {lines.map((line, i) => {
        const trimmed = line.trim();

        if (trimmed === "") {
          return <div key={i} className="h-2" />;
        }

        if (trimmed.startsWith("* ") || trimmed.startsWith("- ")) {
          return (
            <div key={i} className="flex gap-2 ml-2">
              <span className="text-muted-foreground shrink-0">•</span>
              <span>{parseLine(trimmed.slice(2))}</span>
            </div>
          );
        }

        return <p key={i}>{parseLine(line)}</p>;
      })}
    </div>
  );
}
