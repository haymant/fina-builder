import type { DeepFormCondition, DeepFormFieldHints, DeepFormJsonSchema, DeepFormValue } from "./types";

/* -------------------------------------------------------------------------- */
/* Type guards                                                                */
/* -------------------------------------------------------------------------- */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export function isPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** True for values that render as a nested card/section rather than a table row. */
export function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return isPlainObject(value) || isJsonArray(value);
}

/* -------------------------------------------------------------------------- */
/* JSON pointer helpers                                                       */
/* -------------------------------------------------------------------------- */

export function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function unescapePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

export function splitPointer(pointer: string): string[] {
  if (!pointer) return [];
  return pointer.split("/").slice(1).map(unescapePointerSegment);
}

export function joinPointer(base: string, ...segments: Array<string | number>): string {
  return segments.reduce<string>((acc, segment) => `${acc}/${escapePointerSegment(String(segment))}`, base);
}

/**
 * Resolve a layout node path against a base pointer. Absolute pointers
 * (starting with `/`) are returned as-is; relative pointers are appended to
 * `basePath` with each segment escaped.
 */
export function resolveRelativePointer(path: string, basePath: string): string {
  if (!path) return basePath;
  if (path.startsWith("/")) return path;
  const suffix = path.split("/").filter(Boolean).map(escapePointerSegment).join("/");
  return `${basePath}/${suffix}`;
}

export function parentPointer(pointer: string): string {
  const index = pointer.lastIndexOf("/");
  return index <= 0 ? "" : pointer.slice(0, index);
}

export function lastPointerSegment(pointer: string): string {
  const segments = splitPointer(pointer);
  return segments[segments.length - 1] ?? "";
}

export function toDotPath(pointer: string): string {
  return splitPointer(pointer).join(".");
}

/* -------------------------------------------------------------------------- */
/* Immutable value access                                                     */
/* -------------------------------------------------------------------------- */

export function getValueAtSegments(root: unknown, segments: string[]): unknown {
  let current: unknown = root;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      current = current[Number(segment)];
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

export function getValueAtPointer(root: unknown, pointer: string): unknown {
  return getValueAtSegments(root, splitPointer(pointer));
}

function cloneContainer(container: Record<string, unknown> | unknown[]): Record<string, unknown> | unknown[] {
  return Array.isArray(container) ? [...container] : { ...container };
}

/** Immutably set `value` at `segments`, cloning only the containers along the path. */
export function setValueAtSegments(root: unknown, segments: string[], value: unknown): DeepFormValue {
  if (segments.length === 0) return value as DeepFormValue;
  const [head, ...rest] = segments;
  if (!isContainer(root)) {
    return rest.length === 0 ? (value as DeepFormValue) : ({} as DeepFormValue);
  }
  const next = cloneContainer(root);
  const currentChild = Array.isArray(root) ? root[Number(head)] : root[head];
  const nextChild = rest.length === 0 ? value : setValueAtSegments(currentChild, rest, value);
  if (Array.isArray(next)) {
    next[Number(head)] = nextChild;
  } else {
    next[head] = nextChild;
  }
  return next as DeepFormValue;
}

export function setValueAtPointer(root: unknown, pointer: string, value: unknown): DeepFormValue {
  return setValueAtSegments(root, splitPointer(pointer), value);
}

/** Immutably remove the value at `segments` (array splice or object key delete). */
export function removeValueAtSegments(root: unknown, segments: string[]): DeepFormValue {
  if (segments.length === 0) return root as DeepFormValue;
  const [head, ...rest] = segments;
  if (rest.length === 0) {
    if (Array.isArray(root)) return root.filter((_, index) => index !== Number(head)) as DeepFormValue;
    if (isPlainObject(root)) {
      const next = { ...root };
      delete next[head];
      return next as DeepFormValue;
    }
    return root as DeepFormValue;
  }
  const child = getValueAtSegments(root, [head]);
  return setValueAtSegments(root, [head], removeValueAtSegments(child, rest));
}

/** Immutably move an array item inside the array located at `segments`. */
export function moveArrayItemAtSegments(root: unknown, segments: string[], from: number, to: number): DeepFormValue {
  const array = getValueAtSegments(root, segments);
  if (!Array.isArray(array)) return root as DeepFormValue;
  if (from === to || from < 0 || to < 0 || from >= array.length || to >= array.length) {
    return root as DeepFormValue;
  }
  const next = [...array];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return setValueAtSegments(root, segments, next);
}

/* -------------------------------------------------------------------------- */
/* Traversal                                                                  */
/* -------------------------------------------------------------------------- */

/** Visit every primitive leaf (plus `null`) with its JSON pointer. */
export function walkLeaves(
  value: unknown,
  pointer: string,
  visit: (pointer: string, value: unknown, segments: string[]) => void,
): void {
  if (isContainer(value)) {
    if (isJsonArray(value)) {
      value.forEach((item, index) => {
        walkLeaves(item, joinPointer(pointer, index), visit);
      });
    } else {
      for (const [key, child] of Object.entries(value)) walkLeaves(child, joinPointer(pointer, key), visit);
    }
    return;
  }
  visit(pointer, value, splitPointer(pointer));
}

/** Collect every container (object/array) pointer reachable from `value`. */
export function collectContainerPaths(value: unknown, pointer = "", into: Set<string> = new Set()): Set<string> {
  if (!isContainer(value)) return into;
  into.add(pointer);
  if (isJsonArray(value)) {
    value.forEach((item, index) => {
      collectContainerPaths(item, joinPointer(pointer, index), into);
    });
  } else {
    for (const [key, child] of Object.entries(value)) collectContainerPaths(child, joinPointer(pointer, key), into);
  }
  return into;
}

export function partitionEntries(object: Record<string, unknown>): {
  fields: Array<[string, unknown]>;
  sections: Array<[string, unknown]>;
} {
  const fields: Array<[string, unknown]> = [];
  const sections: Array<[string, unknown]> = [];
  for (const entry of Object.entries(object)) {
    (isContainer(entry[1]) ? sections : fields).push(entry);
  }
  return { fields, sections };
}

/* -------------------------------------------------------------------------- */
/* Labels / formatting                                                        */
/* -------------------------------------------------------------------------- */

export function humanizeKey(key: string): string {
  if (!key) return "";
  const spaced = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  if (!spaced) return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function pointerLabel(pointer: string): string {
  return splitPointer(pointer).map(humanizeKey).join(" › ");
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/* -------------------------------------------------------------------------- */
/* Hints / conditions                                                         */
/* -------------------------------------------------------------------------- */

export function resolveFieldHint(
  hints: DeepFormFieldHints | undefined,
  pointer: string,
): DeepFormFieldHints[string] | undefined {
  if (!hints) return undefined;
  return hints[pointer] ?? hints[toDotPath(pointer)];
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (isContainer(a) && isContainer(b)) {
    const aKeys = Object.keys(a as object);
    const bKeys = Object.keys(b as object);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
  }
  return false;
}

export function evaluateCondition(
  condition: DeepFormCondition | undefined,
  root: DeepFormValue,
  basePath = "",
): boolean {
  if (!condition) return true;
  const pointer = condition.path.startsWith("/") ? condition.path : joinPointer(basePath, condition.path);
  const value = getValueAtPointer(root, pointer);
  if (condition.exists !== undefined) return (value !== undefined && value !== null) === condition.exists;
  if ("equals" in condition) return deepEqual(value, condition.equals);
  if ("not_equals" in condition) return !deepEqual(value, condition.not_equals);
  if ("in" in condition && Array.isArray(condition.in)) return condition.in.some((item) => deepEqual(item, value));
  return true;
}

/* -------------------------------------------------------------------------- */
/* Misc                                                                       */
/* -------------------------------------------------------------------------- */

export function asRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

export function schemaIsEmpty(descriptor: DeepFormJsonSchema | undefined): boolean {
  return !descriptor || Object.keys(descriptor).length === 0;
}
