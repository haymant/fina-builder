import type { DeepFormFieldHint, DeepFormJsonSchema } from "./types";
import { splitPointer, unescapePointerSegment } from "./utils";

/* -------------------------------------------------------------------------- */
/* $ref / pointer resolution                                                  */
/* -------------------------------------------------------------------------- */

export function resolveSchemaRef(
  rootSchema: DeepFormJsonSchema | undefined,
  ref: string,
): DeepFormJsonSchema | undefined {
  if (!rootSchema || !ref.startsWith("#/")) return undefined;
  let current: unknown = rootSchema;
  for (const raw of ref.slice(2).split("/")) {
    const segment = unescapePointerSegment(raw);
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current as DeepFormJsonSchema | undefined;
}

function deref(rootSchema: DeepFormJsonSchema | undefined, schema: DeepFormJsonSchema | undefined) {
  let current = schema;
  const seen = new Set<string>();
  while (current?.$ref && !seen.has(current.$ref)) {
    seen.add(current.$ref);
    current = resolveSchemaRef(rootSchema, current.$ref) ?? current;
  }
  return current;
}

/** Resolve the schema descriptor for a JSON pointer, walking `properties`/`items` and `$ref`. */
export function resolveSchemaAtPointer(
  rootSchema: DeepFormJsonSchema | undefined,
  pointer: string,
): DeepFormJsonSchema | undefined {
  if (!rootSchema) return undefined;
  const segments = splitPointer(pointer);
  let current: DeepFormJsonSchema | undefined = rootSchema;
  for (const segment of segments) {
    current = deref(rootSchema, current);
    if (!current) return undefined;
    if (current.type === "array" || current.items) {
      const item = deref(rootSchema, current.items);
      if (item && /^\d+$/.test(segment)) {
        current = item;
        continue;
      }
    }
    const properties = current.properties ?? {};
    const next =
      properties[segment] ??
      (typeof current.additionalProperties === "object" ? deref(rootSchema, current.additionalProperties) : undefined);
    current = next;
  }
  return deref(rootSchema, current);
}

/* -------------------------------------------------------------------------- */
/* Type / renderer inference                                                  */
/* -------------------------------------------------------------------------- */

export function normalizeSchemaType(descriptor: DeepFormJsonSchema | undefined): string | undefined {
  if (!descriptor) return undefined;
  const type = descriptor.type;
  if (Array.isArray(type)) return type.find((entry) => entry !== "null") ?? type[0];
  if (typeof type === "string") return type;
  if (descriptor.enum?.length) {
    const first = descriptor.enum.find((value) => value !== null);
    if (typeof first === "number") return "number";
    if (typeof first === "boolean") return "boolean";
    return "string";
  }
  if (descriptor.properties) return "object";
  if (descriptor.items) return "array";
  return undefined;
}

/**
 * Choose a built-in renderer for a field. Priority:
 * hint → layout → schema extension → schema `format`/`enum`/`type` → runtime value.
 */
export function inferFieldRenderer(
  descriptor: DeepFormJsonSchema | undefined,
  value: unknown,
  hint?: DeepFormFieldHint,
): string {
  if (hint?.renderer) return hint.renderer;
  if (descriptor?.["x-renderer"]) return descriptor["x-renderer"];

  if (descriptor) {
    if (descriptor.enum?.length) return "select";
    if (descriptor.const !== undefined) return "readonly";
    const format = descriptor.format;
    if (format === "date" || format === "date-time") return "date-input";
    if (format === "percent" || format === "percentage") return "percentage-input";
    if (format === "currency" || format === "money") return "money-input";
    const type = normalizeSchemaType(descriptor);
    if (type === "boolean") return "switch";
    if (type === "number" || type === "integer") return "number-input";
    if (type === "object" || type === "array") return "json";
  }

  if (typeof value === "boolean") return "switch";
  if (typeof value === "number") return "number-input";
  return "text-input";
}

/** Build a sensible default for a new array item from its schema descriptor. */
export function buildDefaultFromSchema(descriptor: DeepFormJsonSchema | undefined): unknown {
  if (!descriptor) return "";
  if (descriptor.default !== undefined) return descriptor.default;
  if (descriptor.enum?.length) return descriptor.enum[0];
  const type = normalizeSchemaType(descriptor);
  switch (type) {
    case "boolean":
      return false;
    case "number":
    case "integer":
      return descriptor.minimum ?? 0;
    case "array":
      return [];
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(descriptor.properties ?? {})) {
        if (child.default !== undefined) out[key] = child.default;
        else if (child.type === "object") out[key] = buildDefaultFromSchema(child);
        else if (child.type === "array") out[key] = [];
      }
      return out;
    }
    default:
      return "";
  }
}

/** Coerce a renderer's string output back to the schema's enum value type. */
export function coerceEnumValue(raw: string, descriptor: DeepFormJsonSchema | undefined): unknown {
  const options = descriptor?.enum;
  if (options) {
    const match = options.find((option) => String(option) === raw);
    if (match !== undefined) return match;
  }
  return raw;
}
