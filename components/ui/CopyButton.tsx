"use client";
import { useState } from "react";
import { Check, Copy } from "lucide-react";
export default function CopyButton({
  text,
  label = "Copy message",
}: {
  text: string;
  label?: string;
}) {
  const [result, setResult] = useState<{ text: string; status: "copied" | "failed" }>();
  const status = result?.text === text ? result.status : "idle";
  return (
    <button
      type="button"
      className="ui-copy"
      aria-label={label}
      title={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setResult({ text, status: "copied" });
        } catch {
          setResult({ text, status: "failed" });
        }
      }}
    >
      {status === "copied" ? <Check size={13} /> : <Copy size={13} />}
      <span role="status">
        {status === "copied" ? "Copied" : status === "failed" ? "Copy failed — retry" : "Copy"}
      </span>
    </button>
  );
}
