// Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { BLOCKS, blockFirmness, forgeState, linkLock, seeded, smoothstep } from "../src/lib/forge.ts";

test("the chain starts loose and ends fully forged", () => {
  assert.deepEqual(forgeState(0), { verified: 0, links: 0, integrity: 0, stage: 0 });
  const end = forgeState(1);
  assert.equal(end.verified, BLOCKS);
  assert.equal(end.links, BLOCKS - 1);
  assert.equal(end.integrity, 100);
  assert.equal(end.stage, 4);
});

test("blocks forge in order and a link never locks before both of its blocks", () => {
  for (let p = 0; p <= 1; p += 0.01) {
    for (let i = 1; i < BLOCKS; i++) assert.ok(blockFirmness(p, i) <= blockFirmness(p, i - 1) + 1e-9, `block ${i} ahead at ${p}`);
    for (let i = 0; i < BLOCKS - 1; i++) {
      if (linkLock(p, i) > 0) assert.ok(blockFirmness(p, i) > 0.5 && blockFirmness(p, i + 1) > 0.5, `link ${i} early at ${p}`);
    }
  }
});

test("progress is monotonic and the helpers are stable", () => {
  let last = -1;
  for (let p = 0; p <= 1.0001; p += 0.05) {
    const s = forgeState(p);
    assert.ok(s.integrity >= last);
    last = s.integrity;
  }
  assert.equal(smoothstep(0, 1, 0.5), 0.5);
  const a = seeded(7);
  const b = seeded(7);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
});
