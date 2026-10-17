"use client";

import { createContext, type ReactNode, useContext, useMemo } from "react";

import { type UseDeepFormStateOptions, useDeepFormState } from "./hooks/use-deep-form";
import { builtInRenderers } from "./renderers";
import type {
  DeepFormFieldHints,
  DeepFormJsonSchema,
  DeepFormRenderer,
  DeepFormRenderers,
  DeepFormValue,
} from "./types";

export interface DeepFormContextValue {
  root: DeepFormValue;
  schema?: DeepFormJsonSchema;
  renderers: DeepFormRenderers;
  fieldHints: DeepFormFieldHints;
  readOnly: boolean;
  errors: ReadonlyMap<string, string>;
  expanded: Set<string>;
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

const DeepFormContext = createContext<DeepFormContextValue | null>(null);

export interface DeepFormProviderProps extends Omit<UseDeepFormStateOptions, "schema"> {
  schema?: DeepFormJsonSchema;
  renderers?: DeepFormRenderers;
  readOnly?: boolean;
  children: ReactNode;
}

export function DeepFormProvider({
  value,
  onChange,
  schema,
  fieldHints,
  validate,
  expandedPaths,
  defaultExpandedPaths,
  defaultExpandedDepth,
  onExpandedChange,
  renderers,
  readOnly = false,
  children,
}: DeepFormProviderProps) {
  const state = useDeepFormState({
    value,
    onChange,
    schema,
    fieldHints,
    validate,
    expandedPaths,
    defaultExpandedPaths,
    defaultExpandedDepth,
    onExpandedChange,
  });

  const mergedRenderers = useMemo<DeepFormRenderers>(() => ({ ...builtInRenderers, ...renderers }), [renderers]);

  const contextValue = useMemo<DeepFormContextValue>(
    () => ({
      root: state.root,
      schema,
      renderers: mergedRenderers,
      fieldHints: fieldHints ?? {},
      readOnly,
      errors: state.errors,
      expanded: state.expanded,
      changeValue: state.changeValue,
      addArrayItem: state.addArrayItem,
      removeArrayItem: state.removeArrayItem,
      moveArrayItem: state.moveArrayItem,
      removeObjectKey: state.removeObjectKey,
      setExpanded: state.setExpanded,
      toggleExpanded: state.toggleExpanded,
      isExpanded: state.isExpanded,
      expandAll: state.expandAll,
      collapseAll: state.collapseAll,
    }),
    [state, schema, mergedRenderers, fieldHints, readOnly],
  );

  return <DeepFormContext.Provider value={contextValue}>{children}</DeepFormContext.Provider>;
}

export function useDeepForm(): DeepFormContextValue {
  const context = useContext(DeepFormContext);
  if (!context) throw new Error("deep-form: useDeepForm must be used inside a <DeepForm> or <DeepFormProvider>.");
  return context;
}

/** Resolve the renderer for a field given the context registry. */
export function useDeepFormRenderer(name: string | undefined): DeepFormRenderer | undefined {
  const { renderers } = useDeepForm();
  if (!name) return undefined;
  return renderers[name] ?? builtInRenderers[name];
}
