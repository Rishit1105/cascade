/* Small, safe markdown renderer for assistant answers: headings, lists, quotes, bold, italics,
   inline code and links. In-app paths become router links; nothing is injected as HTML. */
import { Fragment, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { cx } from "../lib/format";

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|_[^_\s][^_]*_)/g;

function inline(text: string, onNavigate?: () => void): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (!part) return null;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i} className="font-semibold text-fg">{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={i} className="rounded bg-subtle px-1 py-[1px] font-mono text-[0.86em] text-fg">{part.slice(1, -1)}</code>;
    if (part.startsWith("_") && part.endsWith("_") && part.length > 2) return <em key={i} className="text-muted">{part.slice(1, -1)}</em>;
    const m = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (m) {
      const [, label, href] = m;
      if (href.startsWith("/")) return <Link key={i} to={href} onClick={onNavigate} className="font-medium text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary">{label}</Link>;
      if (/^https?:\/\//.test(href)) return <a key={i} href={href} target="_blank" rel="noopener noreferrer" className="font-medium text-info underline underline-offset-2">{label}</a>;
      return <Fragment key={i}>{label}</Fragment>;
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

export function Markdown({ text, onNavigate, className }: { text: string; onNavigate?: () => void; className?: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push(<p key={i} className={cx("font-semibold text-fg", h[1].length <= 2 ? "text-[15px]" : "text-[14px]", blocks.length > 0 && "mt-3")}>{inline(h[2], onNavigate)}</p>);
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        let item = lines[i].replace(/^\s*[-*]\s+/, "");
        while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]) && !/^\s*[-*]\s+/.test(lines[i + 1])) item += "\n" + lines[++i].trim();
        items.push(item);
        i++;
      }
      blocks.push(
        <ul key={i} className="mt-1.5 space-y-1">
          {items.map((it, k) => (
            <li key={k} className="flex gap-2">
              <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70" />
              <span className="min-w-0 whitespace-pre-line">{inline(it, onNavigate)}</span>
            </li>
          ))}
        </ul>,
      );
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ""));
      blocks.push(
        <ol key={i} className="mt-1.5 space-y-1.5">
          {items.map((it, k) => (
            <li key={k} className="flex gap-2">
              <span className="mt-[1px] flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary/12 text-[10px] font-bold text-primary">{k + 1}</span>
              <span className="min-w-0">{inline(it, onNavigate)}</span>
            </li>
          ))}
        </ol>,
      );
      continue;
    }
    if (line.trim().startsWith("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++]));
      blocks.push(
        <div key={i} className="mt-2 overflow-x-auto rounded-lg border border-line">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="bg-subtle/70">
                {head.map((h, k) => <th key={k} className="whitespace-nowrap px-2.5 py-1.5 text-left text-[11px] font-semibold text-muted">{inline(h, onNavigate)}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className="border-t border-line">
                  {r.map((c, k) => <td key={k} className="px-2.5 py-1.5 align-top">{inline(c, onNavigate)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (line.startsWith(">")) {
      const q: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) q.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push(<blockquote key={i} className="mt-2 border-l-2 border-primary/40 bg-primary/[0.04] py-1.5 pl-3 pr-2 text-muted">{inline(q.join(" "), onNavigate)}</blockquote>);
      continue;
    }
    const para: string[] = [lines[i++]]; // always consume the first line, so a stray "|" line cannot stall the loop
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*[-*]\s+|\s*\d+[.)]\s+|>|\s*\|)/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={i} className={cx(blocks.length > 0 && "mt-2")}>{inline(para.join(" "), onNavigate)}</p>);
  }
  return <div className={cx("text-[13px] leading-relaxed text-fg", className)}>{blocks}</div>;
}
