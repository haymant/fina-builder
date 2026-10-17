import { useCallback, useMemo, useRef, useState } from "react";

import { resolveSchemaAtPointer } from "../schema";
import type {
  DeepFormChangeEvent,
  DeepFormChangeHandler,
  DeepFormChangeType,
  DeepFormFieldHint,
  DeepFormFieldHints,
  DeepFormFieldValidator,
  DeepFormJsonSchema,
  DeepFormValue,
} from "../types";
import {
  collectContainerPaths,
  getValueAtSegments,
  isJsonArray,
  isPlainObject,
  joinPointer,
  moveArrayItemAtSegments,
  removeValueAtSegments,
  resolveFieldHint,
  setValueAtSegments,
  splitPointer,
  walkLeaves,
} from "../utils";

export interface UseDeepFormStateOptions {
  /** Controlled value. When `onChange` is supplied this is the source of truth. */
  value: DeepFormValue;
  /** Emitted on every mutation with the next document and a change event. */
  onChange?: DeepFormChangeHandler;
  /** JSON Schema used to resolve descriptors for validation. */
  schema?: DeepFormJsonSchema;
  fieldHints?: DeepFormFieldHints;
  /** Top-level validator applied to every primitive leaf. */
  validate?: DeepFormFieldValidator;
  /** Controlled expansion. When supplied the component never owns expansion state. */
  expandedPaths?: string[];
  defaultExpandedPaths?: string[];
  /** Expand all containers up to this depth on mount (default 1 = root only). */
  defaultExpandedDepth?: number;
  onExpandedChange?: (paths: string[]) => void;
}

export interface DeepFormState {
  root: DeepFormValue;
  expanded: Set<string>;
  errors: ReadonlyMap<string, string>;
  changeValue: (path: string, value: unknown) => void;
  addArrayItem: (path: string, index?: number, item?: unknown) => void;
  removeArrayItem: (path: string, index: number) => void;
  moveArrayItem: (path: string, from: number, to: number) => void;
  removeObjectKey: (path: string, key: string) => void;
  setExpanded: (path: string, open: boolean) => void;
  toggleExpanded: (path: string) => void;
  isExpanded: (path: string) => boolean;
  expandAll: () => void;
  collapseAll: () => void;
}

function seedExpanded(value: unknown, explicit: string[] | undefined, depth: number): Set<string> {
  const set = new Set<string>(explicit ?? []);
  if (depth > 0) {
    for (const path of collectContainerPaths(value)) {
      const level = path === "" ? 0 : splitPointer(path).length;
      if (level < depth) set.add(path);
    }
  }
  return set;
}

function makeEvent(
  type: DeepFormChangeType,
  segments: string[],
  value: unknown,
  previousValue: unknown,
  previousRoot: DeepFormValue,
  root: DeepFormValue,
  extra?: { index?: number; toIndex?: number },
): DeepFormChangeEvent {
  const parentPath = segments.length > 0 ? joinPointer("", ...segments.slice(0, -1)) : "";
  const key = segments[segments.length - 1] ?? "";
  return {
    type,
    path: joinPointer("", ...segments),
    parentPath,
    key,
    index: extra?.index,
    segments,
    value,
    previousValue,
    previousRoot,
    root,
    toIndex: extra?.toIndex,
  };
}

/**
 * Owns the deep-form document and expansion state. The component is controlled
 * when `onChange` is provided and self-managed otherwise, mirroring the usual
 * React controlled/uncontrolled convention.
 */
export function useDeepFormState({
  value,
  onChange,
  schema,
  fieldHints,
  validate,
  expandedPaths,
  defaultExpandedPaths,
  defaultExpandedDepth = 1,
  onExpandedChange,
}: UseDeepFormStateOptions): DeepFormState {
  const controlled = onChange !== undefined;
  const [internalValue, setInternalValue] = useState<DeepFormValue>(value);
  const root = controlled ? value : internalValue;

  // Keep a stable ref to the latest root for event builders.
  const rootRef = useRef(root);
  rootRef.current = root;

  const commit = useCallback(
    (nextRoot: DeepFormValue, event: DeepFormChangeEvent) => {
      if (!controlled) setInternalValue(nextRoot);
      onChange?.(nextRoot, event);
    },
    [controlled, onChange],
  );

  const changeValue = useCallback(
    (path: string, next: unknown) => {
      const segments = splitPointer(path);
      const previousRoot = rootRef.current;
      const previousValue = getValueAtSegments(previousRoot, segments);
      const nextRoot = setValueAtSegments(previousRoot, segments, next);
      commit(nextRoot, makeEvent("update", segments, next, previousValue, previousRoot, nextRoot));
    },
    [commit],
  );

  const addArrayItem = useCallback(
    (path: string, index?: number, item: unknown = {}) => {
      const segments = splitPointer(path);
      const previousRoot = rootRef.current;
      const array = getValueAtSegments(previousRoot, segments);
      if (!isJsonArray(array)) return;
      const insertAt = index ?? array.length;
      const nextArray = [...array.slice(0, insertAt), item, ...array.slice(insertAt)];
      const nextRoot = setValueAtSegments(previousRoot, segments, nextArray);
      commit(
        nextRoot,
        makeEvent("add", [...segments, String(insertAt)], item, undefined, previousRoot, nextRoot, {
          index: insertAt,
        }),
      );
    },
    [commit],
  );

  const removeArrayItem = useCallback(
    (path: string, index: number) => {
      const segments = splitPointer(path);
      const previousRoot = rootRef.current;
      const array = getValueAtSegments(previousRoot, segments);
      if (!isJsonArray(array)) return;
      const previousValue = array[index];
      const nextRoot = removeValueAtSegments(previousRoot, [...segments, String(index)]);
      commit(
        nextRoot,
        makeEvent("remove", [...segments, String(index)], undefined, previousValue, previousRoot, nextRoot, {
          index,
        }),
      );
    },
    [commit],
  );

  const moveArrayItem = useCallback(
    (path: string, from: number, to: number) => {
      const segments = splitPointer(path);
      const previousRoot = rootRef.current;
      const array = getValueAtSegments(previousRoot, segments);
      if (!isJsonArray(array)) return;
      const nextRoot = moveArrayItemAtSegments(previousRoot, segments, from, to);
      if (nextRoot === previousRoot) return;
      commit(
        nextRoot,
        makeEvent("move", [...segments, String(to)], array[from], array[to], previousRoot, nextRoot, {
          index: from,
          toIndex: to,
        }),
      );
    },
    [commit],
  );

  const removeObjectKey = useCallback(
    (path: string, key: string) => {
      const segments = splitPointer(path);
      const previousRoot = rootRef.current;
      const container = getValueAtSegments(previousRoot, segments);
      if (!isPlainObject(container)) return;
      const previousValue = container[key];
      const nextRoot = removeValueAtSegments(previousRoot, [...segments, key]);
      commit(nextRoot, makeEvent("remove", [...segments, key], undefined, previousValue, previousRoot, nextRoot));
    },
    [commit],
  );

  /* ----------------------------- expansion ------------------------------ */

  const expansionControlled = expandedPaths !== undefined;
  const [internalExpanded, setInternalExpanded] = useState<Set<string>>(() =>
    seedExpanded(value, defaultExpandedPaths, defaultExpandedDepth),
  );
  const expanded = useMemo(
    () => (expansionControlled ? new Set(expandedPaths) : internalExpanded),
    [expansionControlled, expandedPaths, internalExpanded],
  );

  const applyExpansion = useCallback(
    (next: Set<string>) => {
      if (!expansionControlled) setInternalExpanded(next);
      onExpandedChange?.([...next]);
    },
    [expansionControlled, onExpandedChange],
  );

  const setExpanded = useCallback(
    (path: string, open: boolean) => {
      const next = new Set(expanded);
      if (open) next.add(path);
      else next.delete(path);
      applyExpansion(next);
    },
    [expanded, applyExpansion],
  );

  const toggleExpanded = useCallback(
    (path: string) => {
      const next = new Set(expanded);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      applyExpansion(next);
    },
    [expanded, applyExpansion],
  );

  const isExpanded = useCallback((path: string) => expanded.has(path), [expanded]);

  const expandAll = useCallback(() => {
    applyExpansion(collectContainerPaths(rootRef.current));
  }, [applyExpansion]);

  const collapseAll = useCallback(() => {
    applyExpansion(new Set());
  }, [applyExpansion]);

  /* ------------------------------- errors ------------------------------- */

  const errors = useMemo(() => {
    const map = new Map<string, string>();
    walkLeaves(root, "", (path, leafValue, segments) => {
      const hint: DeepFormFieldHint | undefined = resolveFieldHint(fieldHints, path);
      const descriptor = resolveSchemaAtPointer(schema, path);
      const message =
        hint?.validate?.(leafValue, { path, segments, root, descriptor }) ??
        validate?.(leafValue, { path, segments, root, descriptor });
      if (typeof message === "string" && message.length > 0) map.set(path, message);
    });
    return map;
  }, [root, fieldHints, schema, validate]);

  return {
    root,
    expanded,
    errors,
    changeValue,
    addArrayItem,
    removeArrayItem,
    moveArrayItem,
    removeObjectKey,
    setExpanded,
    toggleExpanded,
    isExpanded,
    expandAll,
    collapseAll,
  };
}
