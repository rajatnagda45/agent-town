import type { ReactNode } from "react";
import CopyButton from "./CopyButton";
// Render response text as React nodes. Raw HTML is never interpreted.
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\[[^\]]+\]\([^\s)]+\)|\*\*[^*]+\*\*|\*[^*]+\*)/g).map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
    const link = part.match(/^\[([^\]]+)\]\(([^\s)]+)\)$/);
    if (link) {
      const href = link[2];
      if (/^\/work\/compose_[a-f0-9]{32}$/.test(href))
        return (
          <a key={i} href={href}>
            {link[1]}
          </a>
        );
      if (/^https?:\/\//i.test(href))
        return (
          <a key={i} href={href} target="_blank" rel="noopener noreferrer">
            {link[1]}
          </a>
        );
      return link[1];
    }
    if (part.startsWith("**") && part.endsWith("**"))
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("*") && part.endsWith("*")) return <em key={i}>{part.slice(1, -1)}</em>;
    return part;
  });
}
export default function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  const boundary = (line: string) =>
    /^\s*$|^\s*```|^#{1,6}\s|^\s*[-*+]\s|^\s*\d+[.)]\s|^>\s?/.test(line);
  while (i < lines.length) {
    const line = lines[i];
    const key = i;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.trimStart().startsWith("```")) {
      const language = line.trim().slice(3);
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) code.push(lines[i++]);
      i++;
      blocks.push(
        <div className="ui-code" key={key}>
          <div className="ui-code__header">
            <span>{language || "Code"}</span>
            <CopyButton text={code.join("\n")} label="Copy code" />
          </div>
          <pre className="hud-chat__codeblock">
            <code>{code.join("\n")}</code>
          </pre>
        </div>,
      );
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)/);
    if (heading) {
      const Tag = `h${Math.min(heading[1].length + 1, 6)}` as "h2" | "h3" | "h4" | "h5" | "h6";
      blocks.push(<Tag key={key}>{inline(heading[2])}</Tag>);
      i++;
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items: ReactNode[] = [];
      const pattern = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/;
      while (i < lines.length && pattern.test(lines[i])) {
        items.push(<li key={i}>{inline(lines[i].replace(pattern, ""))}</li>);
        i++;
      }
      blocks.push(
        ordered ? (
          <ol key={key} start={Number(line.trim().match(/^\d+/)?.[0]) || 1}>
            {items}
          </ol>
        ) : (
          <ul key={key}>{items}</ul>
        ),
      );
      continue;
    }
    if (line.startsWith(">")) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].startsWith(">"))
        quote.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push(<blockquote key={key}>{inline(quote.join("\n"))}</blockquote>);
      continue;
    }
    const paragraph = [line];
    i++;
    while (i < lines.length && !boundary(lines[i])) paragraph.push(lines[i++]);
    blocks.push(<p key={key}>{inline(paragraph.join("\n"))}</p>);
  }
  return <div className="ui-markdown">{blocks}</div>;
}
