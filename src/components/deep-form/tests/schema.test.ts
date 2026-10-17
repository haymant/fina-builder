import { describe, expect, it } from "vitest";

import {
  buildDefaultFromSchema,
  coerceEnumValue,
  inferFieldRenderer,
  normalizeSchemaType,
  resolveSchemaAtPointer,
  resolveSchemaRef,
} from "../schema";
import type { DeepFormJsonSchema } from "../types";

const SCHEMA: DeepFormJsonSchema = {
  type: "object",
  properties: {
    notional: { type: "number", minimum: 0 },
    currency: { type: "string", enum: ["USD", "EUR"] },
    memory: { type: "boolean" },
    expiry: { type: "string", format: "date" },
    coupon_rate: { type: "number", format: "percentage" },
    underlyings: {
      type: "array",
      items: { $ref: "#/$defs/underlying" },
    },
    nested: {
      type: "object",
      properties: { deep: { type: "string" } },
    },
  },
  $defs: {
    underlying: {
      type: "object",
      properties: { name: { type: "string" }, spot: { type: "number" } },
      required: ["name"],
    },
  },
};

describe("resolveSchemaAtPointer", () => {
  it("walks properties", () => {
    expect(resolveSchemaAtPointer(SCHEMA, "/notional")?.type).toBe("number");
    expect(resolveSchemaAtPointer(SCHEMA, "/nested/deep")?.type).toBe("string");
  });

  it("resolves array items and $ref", () => {
    const descriptor = resolveSchemaAtPointer(SCHEMA, "/underlyings/0/name");
    expect(descriptor?.type).toBe("string");
  });

  it("returns undefined for unknown paths", () => {
    expect(resolveSchemaAtPointer(SCHEMA, "/missing")).toBeUndefined();
  });

  it("resolves $ref targets directly", () => {
    expect(resolveSchemaRef(SCHEMA, "#/$defs/underlying")?.type).toBe("object");
  });
});

describe("type inference", () => {
  it("normalizes schema types", () => {
    expect(normalizeSchemaType({ type: ["null", "number"] })).toBe("number");
    expect(normalizeSchemaType({ enum: [1, 2] })).toBe("number");
  });

  it("infers renderers from schema then value", () => {
    expect(inferFieldRenderer(SCHEMA.properties?.currency, "USD")).toBe("select");
    expect(inferFieldRenderer(SCHEMA.properties?.memory, true)).toBe("switch");
    expect(inferFieldRenderer(SCHEMA.properties?.expiry, "2026-01-01")).toBe("date-input");
    expect(inferFieldRenderer(SCHEMA.properties?.coupon_rate, 0.1)).toBe("percentage-input");
    expect(inferFieldRenderer(undefined, 5)).toBe("number-input");
    expect(inferFieldRenderer(undefined, "text")).toBe("text-input");
    expect(inferFieldRenderer({ "x-renderer": "textarea" }, "text")).toBe("textarea");
  });

  it("lets hints win over schema inference", () => {
    expect(inferFieldRenderer(SCHEMA.properties?.notional, 1, { renderer: "money-input" })).toBe("money-input");
  });
});

describe("buildDefaultFromSchema", () => {
  it("uses explicit defaults and enum first values", () => {
    expect(buildDefaultFromSchema({ default: 10 })).toBe(10);
    expect(buildDefaultFromSchema({ enum: ["a", "b"] })).toBe("a");
  });

  it("builds object defaults recursively", () => {
    const value = buildDefaultFromSchema(SCHEMA.properties?.underlyings);
    expect(value).toEqual([]);
    const obj = buildDefaultFromSchema({ type: "object", properties: { name: { default: "X" }, spot: {} } });
    expect(obj).toEqual({ name: "X" });
  });
});

describe("coerceEnumValue", () => {
  it("maps string options back to typed enum values", () => {
    expect(coerceEnumValue("1", { enum: [1, 2] })).toBe(1);
    expect(coerceEnumValue("USD", { enum: ["USD", "EUR"] })).toBe("USD");
    expect(coerceEnumValue("other", { enum: ["USD"] })).toBe("other");
  });
});
