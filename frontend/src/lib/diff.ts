/* Minimal line diff (LCS) for side-by-side payload comparison. */
export type DiffRow = { left: string | null; right: string | null; tag: "equal" | "delete" | "insert" | "replace" };

export function lineDiff(a: string[], b: string[]): DiffRow[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops: Array<{ t: "eq" | "del" | "ins"; v: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: "eq", v: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ t: "del", v: a[i++] });
    else ops.push({ t: "ins", v: b[j++] });
  }
  while (i < n) ops.push({ t: "del", v: a[i++] });
  while (j < m) ops.push({ t: "ins", v: b[j++] });
  // Pair adjacent delete/insert runs into replace rows.
  const rows: DiffRow[] = [];
  for (let k = 0; k < ops.length; ) {
    if (ops[k].t === "eq") {
      rows.push({ left: ops[k].v, right: ops[k].v, tag: "equal" });
      k++;
      continue;
    }
    const dels: string[] = [];
    const ins: string[] = [];
    while (k < ops.length && ops[k].t !== "eq") {
      if (ops[k].t === "del") dels.push(ops[k].v);
      else ins.push(ops[k].v);
      k++;
    }
    const span = Math.max(dels.length, ins.length);
    for (let s = 0; s < span; s++) {
      const l = dels[s] ?? null;
      const r = ins[s] ?? null;
      rows.push({ left: l, right: r, tag: l !== null && r !== null ? "replace" : l !== null ? "delete" : "insert" });
    }
  }
  return rows;
}
