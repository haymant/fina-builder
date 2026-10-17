"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { DeepFormProvider, type DeepFormProviderProps, useDeepForm } from "./context";
import { DeepFormLayoutView } from "./layout-view";
import { DeepFormNode } from "./node";
import type { DeepFormLayout, DeepFormLayoutNode } from "./types";

export interface DeepFormProps extends Omit<DeepFormProviderProps, "children"> {
  /** Optional layout document. When omitted the tree is derived from the value. */
  layout?: DeepFormLayout | DeepFormLayoutNode;
  title?: ReactNode;
  description?: ReactNode;
  headerActions?: ReactNode;
  className?: string;
}

/**
 * Reusable form renderer for deeply nested JSON. Supply `value` plus an optional
 * JSON `schema` (field types) and `layout` (ordering/grouping/renderers), and
 * receive every edit through `onChange(root, event)`.
 */
export function DeepForm({ layout, title, description, headerActions, className, ...providerProps }: DeepFormProps) {
  return (
    <DeepFormProvider {...providerProps}>
      <DeepFormBody
        layout={layout}
        title={title}
        description={description}
        headerActions={headerActions}
        className={className}
      />
    </DeepFormProvider>
  );
}

function DeepFormBody({
  layout,
  title,
  description,
  headerActions,
  className,
}: {
  layout?: DeepFormLayout | DeepFormLayoutNode;
  title?: ReactNode;
  description?: ReactNode;
  headerActions?: ReactNode;
  className?: string;
}) {
  const { root } = useDeepForm();
  return (
    <div data-slot="deep-form" className={cn("space-y-3", className)}>
      {(title || description || headerActions) && (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-0.5">
            {title && <h3 className="font-medium text-sm">{title}</h3>}
            {description && <p className="text-muted-foreground text-xs">{description}</p>}
          </div>
          {headerActions}
        </div>
      )}
      {layout ? <DeepFormLayoutView node={layout} /> : <DeepFormNode path="" value={root} depth={0} root />}
    </div>
  );
}
