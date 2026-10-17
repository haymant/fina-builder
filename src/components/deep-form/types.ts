import type { ReactNode } from "react";

import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Value model                                                                */
/* -------------------------------------------------------------------------- */

export type DeepFormPrimitive = string | number | boolean | null;
export type DeepFormObject = { [key: string]: DeepFormValue };
export type DeepFormArray = DeepFormValue[];
export type DeepFormValue = DeepFormPrimitive | DeepFormObject | DeepFormArray;

/* -------------------------------------------------------------------------- */
/* JSON Schema (structural subset + deep-form extensions)                    */
/* -------------------------------------------------------------------------- */

/**
 * The subset of JSON Schema the deep-form understands when inferring editors.
 * `x-*` keys are deep-form extensions (mirroring the `x-` convention used by
 * tooling such as OpenAPI) and let a schema carry presentation hints without a
 * separate layout document.
 */
export interface DeepFormJsonSchema {
  $id?: string;
  $ref?: string;
  title?: string;
  description?: string;
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  format?: string;
  properties?: Record<string, DeepFormJsonSchema>;
  items?: DeepFormJsonSchema;
  $defs?: Record<string, DeepFormJsonSchema>;
  required?: string[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  additionalProperties?: boolean | DeepFormJsonSchema;
  oneOf?: DeepFormJsonSchema[];
  anyOf?: DeepFormJsonSchema[];
  allOf?: DeepFormJsonSchema[];
  // deep-form presentation extensions
  "x-renderer"?: string;
  "x-label"?: string;
  "x-description"?: string;
  "x-options"?: Array<{ label: string; value: string }>;
  "x-readonly"?: boolean;
  "x-display-scale"?: number;
  "x-unit"?: string;
  "x-placeholder"?: string;
}

/* -------------------------------------------------------------------------- */
/* Layout schema                                                              */
/* -------------------------------------------------------------------------- */

export interface DeepFormCondition {
  /** JSON pointer (absolute, or relative to the enclosing group). */
  path: string;
  equals?: unknown;
  not_equals?: unknown;
  in?: unknown[];
  exists?: boolean;
}

export interface DeepFormFieldLayoutNode {
  kind: "field";
  /** JSON pointer (absolute, or relative to the enclosing group). */
  path: string;
  label?: string;
  description?: string;
  /** Renderer key resolved against the renderer registry. */
  renderer?: string;
  placeholder?: string;
  readOnly?: boolean;
  visible_when?: DeepFormCondition;
  className?: string;
}

export interface DeepFormGroupLayoutNode {
  kind: "group" | "layout";
  id?: string;
  title?: string;
  description?: string;
  /** Optional subtree binding; children resolve relative to it. */
  path?: string;
  children?: DeepFormLayoutNode[];
  collapsible?: boolean;
  defaultExpanded?: boolean;
  visible_when?: DeepFormCondition;
  className?: string;
}

export interface DeepFormTextLayoutNode {
  kind: "text";
  text: string;
  className?: string;
}

export interface DeepFormDividerLayoutNode {
  kind: "divider";
}

export type DeepFormLayoutNode =
  | DeepFormFieldLayoutNode
  | DeepFormGroupLayoutNode
  | DeepFormTextLayoutNode
  | DeepFormDividerLayoutNode;

export interface DeepFormLayout {
  title?: string;
  description?: string;
  children: DeepFormLayoutNode[];
}

/* -------------------------------------------------------------------------- */
/* Field hints                                                                */
/* -------------------------------------------------------------------------- */

export interface DeepFormValidatorContext {
  path: string;
  segments: string[];
  root: DeepFormValue;
  descriptor?: DeepFormJsonSchema;
}

export type DeepFormFieldValidator = (
  value: unknown,
  context: DeepFormValidatorContext,
) => string | null | undefined | false;

export interface DeepFormFieldHint {
  label?: string;
  description?: string;
  /** Renderer key resolved against the renderer registry. */
  renderer?: string;
  placeholder?: string;
  readOnly?: boolean;
  options?: Array<{ label: string; value: string }>;
  /** Multiplier applied for percentage-style renderers (default 100). */
  displayScale?: number;
  /** Unit suffix, e.g. "USD" or "%". */
  unit?: string;
  className?: string;
  validate?: DeepFormFieldValidator;
}

/** Field hints keyed by JSON pointer (`/a/b`) or dotted path (`a.b`). */
export type DeepFormFieldHints = Record<string, DeepFormFieldHint>;

/* -------------------------------------------------------------------------- */
/* Change events                                                              */
/* -------------------------------------------------------------------------- */

export const DeepFormChangeTypeSchema = z.enum(["update", "add", "remove", "move"]);
export type DeepFormChangeType = z.infer<typeof DeepFormChangeTypeSchema>;

/**
 * Emitted for every mutation. `path` is a JSON pointer to the changed value and
 * `root` is the immutably-updated next document, so a host can either apply the
 * whole document or react to a single field.
 */
export interface DeepFormChangeEvent {
  type: DeepFormChangeType;
  /** JSON pointer to the changed location, e.g. `/protection/return_ratio`. */
  path: string;
  /** JSON pointer to the parent container ("" for root-level keys). */
  parentPath: string;
  /** Last path segment (object key or array index as a string). */
  key: string;
  /** Array index when the parent container is an array. */
  index?: number;
  segments: string[];
  /** New value at `path` (`undefined` for removals). */
  value: unknown;
  /** Previous value at `path`. */
  previousValue: unknown;
  /** Document before the change. */
  previousRoot: DeepFormValue;
  /** Document after the change. */
  root: DeepFormValue;
  /** Destination index for `move` events. */
  toIndex?: number;
}

export type DeepFormChangeHandler = (root: DeepFormValue, event: DeepFormChangeEvent) => void;

/* -------------------------------------------------------------------------- */
/* Renderers                                                                  */
/* -------------------------------------------------------------------------- */

export interface DeepFormRendererProps {
  id: string;
  path: string;
  segments: string[];
  value: unknown;
  descriptor?: DeepFormJsonSchema;
  hint?: DeepFormFieldHint;
  label: string;
  readOnly: boolean;
  invalid: boolean;
  describedBy?: string;
  placeholder?: string;
  onChange: (next: unknown) => void;
}

export type DeepFormRenderer = (props: DeepFormRendererProps) => ReactNode;

/** Renderer registry keyed by renderer name. */
export type DeepFormRenderers = Record<string, DeepFormRenderer>;

/* -------------------------------------------------------------------------- */
/* Zod schemas (parity with data-grid, useful for host validation)            */
/* -------------------------------------------------------------------------- */

export const DeepFormFieldHintSchema = z.object({
  label: z.string().optional(),
  description: z.string().optional(),
  renderer: z.string().optional(),
  placeholder: z.string().optional(),
  readOnly: z.boolean().optional(),
  options: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
  displayScale: z.number().optional(),
  unit: z.string().optional(),
  className: z.string().optional(),
});

export const DeepFormChangeEventSchema = z.object({
  type: DeepFormChangeTypeSchema,
  path: z.string(),
  parentPath: z.string(),
  key: z.string(),
  index: z.number().int().optional(),
  segments: z.array(z.string()),
  value: z.unknown(),
  previousValue: z.unknown(),
  previousRoot: z.unknown(),
  root: z.unknown(),
  toIndex: z.number().int().optional(),
});

const DeepFormConditionSchema = z.object({
  path: z.string(),
  equals: z.unknown().optional(),
  not_equals: z.unknown().optional(),
  in: z.array(z.unknown()).optional(),
  exists: z.boolean().optional(),
});

const DeepFormFieldLayoutNodeSchema = z.object({
  kind: z.literal("field"),
  path: z.string(),
  label: z.string().optional(),
  description: z.string().optional(),
  renderer: z.string().optional(),
  placeholder: z.string().optional(),
  readOnly: z.boolean().optional(),
  visible_when: DeepFormConditionSchema.optional(),
  className: z.string().optional(),
});

const DeepFormTextLayoutNodeSchema = z.object({
  kind: z.literal("text"),
  text: z.string(),
  className: z.string().optional(),
});

const DeepFormDividerLayoutNodeSchema = z.object({ kind: z.literal("divider") });

export const DeepFormLayoutNodeSchema: z.ZodType<DeepFormLayoutNode> = z.lazy(() =>
  z.union([
    DeepFormFieldLayoutNodeSchema,
    DeepFormTextLayoutNodeSchema,
    DeepFormDividerLayoutNodeSchema,
    z.object({
      kind: z.union([z.literal("group"), z.literal("layout")]),
      id: z.string().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      path: z.string().optional(),
      children: z.array(DeepFormLayoutNodeSchema).optional(),
      collapsible: z.boolean().optional(),
      defaultExpanded: z.boolean().optional(),
      visible_when: DeepFormConditionSchema.optional(),
      className: z.string().optional(),
    }),
  ]),
);

export const DeepFormLayoutSchema: z.ZodType<DeepFormLayout> = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  children: z.array(DeepFormLayoutNodeSchema),
});
