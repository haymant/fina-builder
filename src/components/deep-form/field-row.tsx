"use client";

import { type ReactNode, useId } from "react";

import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

import { useDeepForm } from "./context";
import { inferFieldRenderer, resolveSchemaAtPointer } from "./schema";
import type { DeepFormRendererProps } from "./types";
import { getValueAtSegments, humanizeKey, resolveFieldHint, splitPointer } from "./utils";

export interface DeepFormFieldRowProps {
  /** JSON pointer to the field value. */
  path: string;
  label?: string;
  description?: string;
  /** Renderer override (wins over hints and schema inference). */
  renderer?: string;
  placeholder?: string;
  readOnly?: boolean;
  /** Render as a table row (default) or a two-column div. */
  as?: "row" | "div";
  /** Extra control rendered after the editor (e.g. a remove button). */
  trailing?: ReactNode;
  className?: string;
}

/**
 * A single editable field: resolves the descriptor, hint and renderer, then
 * delegates to the renderer registry. Values are read from the surrounding
 * document via `path`, so rows stay in sync with the controlled value.
 */
export function DeepFormFieldRow({
  path,
  label,
  description,
  renderer,
  placeholder,
  readOnly,
  as = "row",
  trailing,
  className,
}: DeepFormFieldRowProps) {
  const { root, schema, renderers, fieldHints, errors, readOnly: formReadOnly, changeValue } = useDeepForm();
  const reactId = useId();

  const segments = splitPointer(path);
  const value = getValueAtSegments(root, segments);
  const descriptor = resolveSchemaAtPointer(schema, path);
  const hint = resolveFieldHint(fieldHints, path);

  const resolvedLabel =
    label ??
    hint?.label ??
    descriptor?.["x-label"] ??
    descriptor?.title ??
    humanizeKey(segments[segments.length - 1] ?? "");
  const resolvedDescription =
    description ?? hint?.description ?? descriptor?.["x-description"] ?? descriptor?.description;
  const resolvedReadOnly = readOnly ?? hint?.readOnly ?? descriptor?.["x-readonly"] ?? formReadOnly;
  const resolvedPlaceholder = placeholder ?? hint?.placeholder ?? descriptor?.["x-placeholder"];
  const error = errors.get(path);
  const errorId = `${reactId}-error`;
  const inputId = `${reactId}-input`;

  const rendererName = renderer ?? hint?.renderer ?? inferFieldRenderer(descriptor, value, hint);
  const Renderer = renderers[rendererName] ?? renderers["text-input"];

  const rendererProps: DeepFormRendererProps = {
    id: inputId,
    path,
    segments,
    value,
    descriptor,
    hint,
    label: resolvedLabel,
    readOnly: resolvedReadOnly,
    invalid: Boolean(error),
    describedBy: error ? errorId : undefined,
    placeholder: resolvedPlaceholder,
    onChange: (next) => changeValue(path, next),
  };

  const labelBlock = (
    <div className="min-w-0">
      <label htmlFor={inputId} className="block font-medium text-sm">
        {resolvedLabel}
      </label>
      {resolvedDescription && <p className="mt-0.5 text-muted-foreground text-xs">{resolvedDescription}</p>}
    </div>
  );

  const editorBlock = (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          {Renderer ? <Renderer {...rendererProps} /> : <span className="text-muted-foreground text-sm">—</span>}
        </div>
        {trailing}
      </div>
      {error && (
        <p id={errorId} role="alert" className="mt-1 text-destructive text-xs">
          {error}
        </p>
      )}
    </div>
  );

  if (as === "div") {
    return (
      <div
        data-deep-form-path={path}
        className={cn("grid grid-cols-1 gap-x-4 gap-y-1 py-1.5 sm:grid-cols-[minmax(9rem,2fr)_3fr]", className)}
      >
        {labelBlock}
        {editorBlock}
      </div>
    );
  }

  return (
    <TableRow data-deep-form-path={path} className={cn("border-b last:border-b-0", className)}>
      <TableHead scope="row" className="w-[38%] min-w-[9rem] whitespace-normal py-2 align-top">
        {labelBlock}
      </TableHead>
      <TableCell className="whitespace-normal py-2 align-top">{editorBlock}</TableCell>
    </TableRow>
  );
}
