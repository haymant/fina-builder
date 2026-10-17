"use client";

import { useId, useState } from "react";

import { ChevronDown, ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

import { useDeepForm } from "./context";
import { DeepFormFieldRow } from "./field-row";
import { DeepFormNode } from "./node";
import type { DeepFormLayout, DeepFormLayoutNode, DeepFormValue } from "./types";
import { evaluateCondition, getValueAtPointer, humanizeKey, lastPointerSegment, resolveRelativePointer } from "./utils";

export interface DeepFormLayoutViewProps {
  /** A layout document or a single layout node. */
  node: DeepFormLayout | DeepFormLayoutNode;
  /** Base pointer that relative node paths resolve against. */
  basePath?: string;
  depth?: number;
}

function isLayoutDocument(node: DeepFormLayout | DeepFormLayoutNode): node is DeepFormLayout {
  return "children" in node && !("kind" in node);
}

/**
 * Layout-mode renderer. The supplied layout document controls ordering,
 * grouping, static text/divider nodes, per-field renderer overrides and
 * `visible_when` conditions.
 */
export function DeepFormLayoutView({ node, basePath = "", depth = 0 }: DeepFormLayoutViewProps) {
  if (isLayoutDocument(node)) {
    return (
      <div className="space-y-3">
        {node.children.map((child, index) => (
          <DeepFormLayoutNodeView
            // biome-ignore lint/suspicious/noArrayIndexKey: layout nodes have no stable id
            key={index}
            node={child}
            basePath={basePath}
            depth={depth}
          />
        ))}
      </div>
    );
  }
  return <DeepFormLayoutNodeView node={node} basePath={basePath} depth={depth} />;
}

function DeepFormLayoutNodeView({
  node,
  basePath,
  depth,
}: {
  node: DeepFormLayoutNode;
  basePath: string;
  depth: number;
}) {
  const { root } = useDeepForm();
  const contentId = useId();
  const [collapsed, setCollapsed] = useState(
    node.kind === "group" || node.kind === "layout" ? node.defaultExpanded === false : false,
  );

  const condition =
    node.kind === "field" || node.kind === "group" || node.kind === "layout" ? node.visible_when : undefined;
  if (condition && !evaluateCondition(condition, root, basePath)) return null;

  switch (node.kind) {
    case "text":
      return <p className={cn("text-muted-foreground text-sm", node.className)}>{node.text}</p>;

    case "divider":
      return <Separator />;

    case "field":
      return (
        <DeepFormFieldRow
          path={resolveRelativePointer(node.path, basePath)}
          label={node.label}
          description={node.description}
          renderer={node.renderer}
          placeholder={node.placeholder}
          readOnly={node.readOnly}
          as="div"
          className={node.className}
        />
      );

    case "group":
    case "layout": {
      const groupPath = node.path ? resolveRelativePointer(node.path, basePath) : basePath;
      const children = node.children ?? [];
      const collapsible = node.collapsible ?? false;
      const expanded = !collapsible || !collapsed;
      const title = node.title ?? (node.path ? humanizeKey(lastPointerSegment(groupPath)) : "Group");

      const body =
        children.length > 0 ? (
          <div className="space-y-3">
            {children.map((child, childIndex) => (
              <DeepFormLayoutNodeView
                // biome-ignore lint/suspicious/noArrayIndexKey: layout nodes have no stable id
                key={childIndex}
                node={child}
                basePath={groupPath}
                depth={depth + 1}
              />
            ))}
          </div>
        ) : (
          <DeepFormNode
            path={groupPath}
            value={getValueAtPointer(root, groupPath) as DeepFormValue}
            depth={depth + 1}
            root
          />
        );

      return (
        <Card data-deep-form-path={groupPath} className={cn("overflow-hidden", node.className)}>
          <CardHeader className="flex flex-row items-center gap-2 px-3 py-2">
            {collapsible ? (
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls={contentId}
                onClick={() => setCollapsed((previous) => !previous)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                {expanded ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-sm">{title}</span>
                  {node.description && (
                    <span className="mt-0.5 block text-muted-foreground text-xs">{node.description}</span>
                  )}
                </span>
                {children.length > 0 && (
                  <Badge variant="outline" className="text-[10px]">
                    {children.length}
                  </Badge>
                )}
              </button>
            ) : (
              <div className="min-w-0 flex-1">
                <span className="block font-medium text-sm">{title}</span>
                {node.description && (
                  <span className="mt-0.5 block text-muted-foreground text-xs">{node.description}</span>
                )}
              </div>
            )}
          </CardHeader>
          {expanded && (
            <CardContent id={contentId} className="border-t px-3 pt-3">
              {body}
            </CardContent>
          )}
        </Card>
      );
    }

    default:
      return null;
  }
}
