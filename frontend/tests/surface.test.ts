// Run with: npm test (node --experimental-strip-types --test tests/)
import assert from "node:assert/strict";
import { test } from "node:test";
import { firstBelow, isCurrent, monthDetail, rowFor, unitsToBase, type SurfaceData } from "../src/lib/surface.ts";

const surface = (params = { amount_base: "500000000000", release: "milestones", horizon: 3 }): SurfaceData => ({
  months: [0, 1, 2, 3],
  before_base: ["1940000000000", "1842000000000", "1744000000000", "1646000000000"],
  rows: [
    { overrun_pct: 0, amount_base: "500000000000", after_base: ["1940000000000", "1842000000000", "1594000000000", "1496000000000"] },
    { overrun_pct: 30, amount_base: "650000000000", after_base: ["1940000000000", "1842000000000", "1594000000000", "1346000000000"] },
  ],
  params,
  balance_base: "2000000000000",
  available_before_base: "1940000000000",
  net_monthly_burn_base: "98000000000",
  schedule_issues: [],
  value_label: "",
  overrun_note: "",
  block_number: 1,
  as_of: "",
});

test("threshold crossing is the first month strictly below the threshold", () => {
  const row = rowFor(surface(), 30)!.after_base;
  assert.equal(firstBelow(row, [0, 1, 2, 3], unitsToBase("1600000")!), 2);
  assert.equal(firstBelow(row, [0, 1, 2, 3], unitsToBase("1594000")!), 3, "equal to the threshold is not below it");
  assert.equal(firstBelow(row, [0, 1, 2, 3], unitsToBase("1000000")!), null, "not reached within the horizon");
  assert.equal(firstBelow(row, [0, 1, 2, 3], unitsToBase("5000000")!), 0, "already below at month 0");
});

test("comparisons stay exact beyond the float range", () => {
  // 2^53 + 1 is not representable as a double; a float comparison would call these equal.
  assert.equal(firstBelow(["9007199254740993"], [0], 9007199254740993n), null);
  assert.equal(firstBelow(["9007199254740992"], [0], 9007199254740993n), 0);
});

test("month detail reports the model's values and the proposal's difference", () => {
  const d = monthDetail(surface(), 30, 3, 0n)!;
  assert.deepEqual(d, { month: 3, overrunPct: 30, afterBase: "1346000000000", beforeBase: "1646000000000", differenceBase: "-300000000000", belowThreshold: false });
  assert.equal(monthDetail(surface(), 15, 3, 0n), null, "an overrun that was not calculated is never interpolated");
  assert.equal(monthDetail(surface(), 30, 9, 0n), null, "a month outside the horizon has no value");
});

test("a response for older inputs is never treated as the current scenario", () => {
  const older = surface({ amount_base: "500000000000", release: "lump", horizon: 3 });
  assert.equal(isCurrent(older, { amountBase: "500000000000", release: "milestones", horizon: 3 }), false);
  assert.equal(isCurrent(surface(), { amountBase: "600000000000", release: "milestones", horizon: 3 }), false);
  assert.equal(isCurrent(undefined, { amountBase: "500000000000", release: "milestones", horizon: 3 }), false);
  assert.equal(isCurrent(surface(), { amountBase: "500000000000", release: "milestones", horizon: 3 }), true);
});

test("threshold input is parsed to exact base units", () => {
  assert.equal(unitsToBase("500000"), 500000000000n);
  assert.equal(unitsToBase("1,500.5"), 1500500000n);
  assert.equal(unitsToBase("-250000"), -250000000000n);
  assert.equal(unitsToBase("1.0000001"), null, "more precision than mUSDC has");
  assert.equal(unitsToBase("abc"), null);
});
