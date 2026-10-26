// Run with: npm test
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { anchorT, buildTree, leafT, nodeT, pathToRoot, sha256Hex, stage, tamperT, TAMPERED } from "../src/lib/merkle.ts";

const docs = ["proposal", "memo.pdf", "forum", "multisig", "disclosure", "manifest", "milestones", "votes"];

test("sha256 matches Node's implementation", async () => {
  assert.equal(await sha256Hex("daoguard"), createHash("sha256").update("daoguard").digest("hex"));
});

test("the tree has 8 → 4 → 2 → 1 nodes and editing one document changes only its path", async () => {
  const a = await buildTree(docs);
  assert.deepEqual(a.map((l) => l.length), [8, 4, 2, 1]);
  const edited = docs.map((d, i) => (i === TAMPERED ? `${d} (edited)` : d));
  const b = await buildTree(edited);
  const path = pathToRoot(TAMPERED);
  assert.deepEqual(path, [5, 2, 1, 0]);
  a.forEach((level, d) => level.forEach((h, k) => assert.equal(h !== b[d][k], k === path[d], `level ${d} node ${k}`)));
});

test("a node never starts before both children are complete, and the tamper stage comes last", () => {
  for (let p = 0; p <= 1.0001; p += 0.005) {
    for (let level = 1; level <= 3; level++) {
      for (let i = 0; i < 8 >> level; i++) {
        if (nodeT(p, level, i) === 0) continue;
        const kids = [2 * i, 2 * i + 1].map((k) => (level === 1 ? leafT(p, k) : nodeT(p, level - 1, k)));
        assert.ok(kids.every((k) => k === 1), `level ${level} node ${i} started early at ${p.toFixed(3)}`);
      }
    }
    if (anchorT(p) > 0) assert.equal(nodeT(p, 3, 0), 1, `anchored before the root at ${p}`);
    if (tamperT(p) > 0) assert.equal(anchorT(p), 1, `tampered before anchoring at ${p}`);
  }
  assert.deepEqual([0, 0.4, 0.66, 0.75, 0.9].map(stage), [0, 1, 2, 3, 4]);
});
