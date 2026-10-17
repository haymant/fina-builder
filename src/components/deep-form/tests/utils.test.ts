import { describe, expect, it } from "vitest";

import {
  collectContainerPaths,
  escapePointerSegment,
  formatValue,
  getValueAtPointer,
  getValueAtSegments,
  humanizeKey,
  joinPointer,
  moveArrayItemAtSegments,
  partitionEntries,
  pointerLabel,
  removeValueAtSegments,
  resolveRelativePointer,
  setValueAtSegments,
  splitPointer,
  unescapePointerSegment,
  walkLeaves,
} from "../utils";

describe("pointer helpers", () => {
  it("escapes and unescapes reserved characters", () => {
    expect(escapePointerSegment("a/b~c")).toBe("a~1b~0c");
    expect(unescapePointerSegment("a~1b~0c")).toBe("a/b~c");
  });

  it("round-trips join and split", () => {
    const pointer = joinPointer("", "a", 0, "b/c");
    expect(pointer).toBe("/a/0/b~1c");
    expect(splitPointer(pointer)).toEqual(["a", "0", "b/c"]);
  });

  it("resolves relative layout paths", () => {
    expect(resolveRelativePointer("protection/return_ratio", "")).toBe("/protection/return_ratio");
    expect(resolveRelativePointer("/notional", "/economics")).toBe("/notional");
    expect(resolveRelativePointer("return_ratio", "/protection")).toBe("/protection/return_ratio");
  });
});

describe("value access", () => {
  const doc = { a: { b: [{ c: 1 }, { c: 2 }] } };

  it("reads nested values by segments and pointer", () => {
    expect(getValueAtSegments(doc, ["a", "b", "1", "c"])).toBe(2);
    expect(getValueAtPointer(doc, "/a/b/0/c")).toBe(1);
  });

  it("sets values immutably", () => {
    const next = setValueAtSegments(doc, ["a", "b", "0", "c"], 42);
    expect(getValueAtPointer(next, "/a/b/0/c")).toBe(42);
    expect(getValueAtPointer(doc, "/a/b/0/c")).toBe(1);
    expect(doc).toEqual({ a: { b: [{ c: 1 }, { c: 2 }] } });
  });

  it("removes array items and object keys", () => {
    expect(getValueAtPointer(removeValueAtSegments(doc, ["a", "b", "0"]), "/a/b")).toEqual([{ c: 2 }]);
    expect(removeValueAtSegments({ x: 1, y: 2 }, ["x"])).toEqual({ y: 2 });
  });

  it("moves array items", () => {
    const moved = moveArrayItemAtSegments({ list: [1, 2, 3] }, ["list"], 0, 2);
    expect(getValueAtPointer(moved, "/list")).toEqual([2, 3, 1]);
  });
});

describe("traversal", () => {
  it("visits primitive leaves", () => {
    const seen: string[] = [];
    walkLeaves({ a: 1, b: { c: true, d: [null, "x"] } }, "", (pointer) => seen.push(pointer));
    expect(seen).toEqual(["/a", "/b/c", "/b/d/0", "/b/d/1"]);
  });

  it("collects container paths", () => {
    const paths = collectContainerPaths({ a: { b: 1 }, c: [{ d: 2 }] });
    expect([...paths].sort()).toEqual(["", "/a", "/c", "/c/0"]);
  });

  it("partitions entries into fields and sections", () => {
    const { fields, sections } = partitionEntries({ a: 1, b: { c: 2 }, d: [1] });
    expect(fields.map(([key]) => key)).toEqual(["a"]);
    expect(sections.map(([key]) => key)).toEqual(["b", "d"]);
  });
});

describe("labels and formatting", () => {
  it("humanizes keys", () => {
    expect(humanizeKey("coupon_rate")).toBe("Coupon rate");
    expect(humanizeKey("returnRatio")).toBe("Return Ratio");
    expect(humanizeKey("")).toBe("");
  });

  it("builds pointer labels", () => {
    expect(pointerLabel("/protection/return_ratio")).toBe("Protection › Return ratio");
  });

  it("formats values", () => {
    expect(formatValue(null)).toBe("—");
    expect(formatValue(true)).toBe("Yes");
    expect(formatValue(3.5)).toBe("3.5");
    expect(formatValue([1, 2])).toBe("[1,2]");
  });
});
