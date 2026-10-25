import type { ReactNode } from "react";
import type { DiffRow } from "../lib/diff";
import { cx } from "../lib/format";

/** Side-by-side diff with line numbers. Equal rows can be collapsed with `changesOnly`. */
export function DiffViewer({ rows, leftTitle, rightTitle, changesOnly, mono = true, leftTone = "success", rightTone = "danger" }: {
  rows: DiffRow[];
  leftTitle: ReactNode;
  rightTitle: ReactNode;
  changesOnly?: boolean;
  mono?: boolean;
  leftTone?: "success" | "neutral";
  rightTone?: "danger" | "success" | "neutral";
}) {
  let l = 0;
  let r = 0;
  const numbered = rows.map((row) => ({ row, ln: row.left !== null ? ++l : null, rn: row.right !== null ? ++r : null }));
  const shown = changesOnly ? numbered.filter((x) => x.row.tag !== "equal") : numbered;
  const changed = rows.some((x) => x.tag !== "equal");
  const headTone = (t: string) => (t === "success" ? "bg-primary/10 text-primary" : t === "danger" ? (changed ? "bg-danger/10 text-danger" : "bg-primary/10 text-primary") : "bg-subtle text-muted");
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="grid grid-cols-2 border-b border-line text-xs font-semibold">
        <div className={cx("px-3 py-2", headTone(leftTone))}>{leftTitle}</div>
        <div className={cx("border-l border-line px-3 py-2", headTone(rightTone))}>{rightTitle}</div>
      </div>
      <div className={cx("max-h-[460px] overflow-auto scroll-thin text-[11.5px] leading-[18px]", mono && "font-mono")}>
        {shown.length === 0 && <p className="p-4 text-center text-xs text-muted">No differences: both sides are identical.</p>}
        {shown.map(({ row, ln, rn }, i) => (
          <div key={i} className="grid grid-cols-2">
            <div className={cx("flex min-w-0", row.tag === "delete" || row.tag === "replace" ? "bg-danger/8" : "")}>
              <span className="w-9 shrink-0 select-none border-r border-line pr-1.5 text-right text-faint">{ln ?? ""}</span>
              <span className={cx("min-w-0 whitespace-pre-wrap break-all px-2", (row.tag === "delete" || row.tag === "replace") && "text-danger")}>
                {row.tag === "delete" || row.tag === "replace" ? "− " : "  "}
                {row.left ?? ""}
              </span>
            </div>
            <div className={cx("flex min-w-0 border-l border-line", row.tag === "insert" || row.tag === "replace" ? "bg-primary/8" : "")}>
              <span className="w-9 shrink-0 select-none border-r border-line pr-1.5 text-right text-faint">{rn ?? ""}</span>
              <span className={cx("min-w-0 whitespace-pre-wrap break-all px-2", (row.tag === "insert" || row.tag === "replace") && "text-primary")}>
                {row.tag === "insert" || row.tag === "replace" ? "+ " : "  "}
                {row.right ?? ""}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
