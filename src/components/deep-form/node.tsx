"use client";

import { type ReactNode, useId } from "react";

import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Table, TableBody } from "@/components/ui/table";
import { cn } from "@/lib/utils";

import { useDeepForm } from "./context";
import { DeepFormFieldRow } from "./field-row";
import { DeepFormFieldsTable } from "./fields-table";
import { buildDefaultFromSchema, resolveSchemaAtPointer } from "./schema";
import type { DeepFormValue } from "./types";
import { humanizeKey, isJsonArray, isPlainObject, isPrimitive, joinPointer, partitionEntries } from "./utils";

export interface DeepFormNodeProps {
  /** JSON pointer to this node. */
  path: string;
  /** Object key / array index used for the default title. */
  name?: string;
  value: DeepFormValue;
  depth: number;
  /** Root nodes render without card chrome. */
  root?: boolean;
  /** Extra controls rendered in the card header (remove/move for array items). */
  headerActions?: ReactNode;
}

/**
 * Auto-mode renderer: objects become collapsible cards, arrays become
 * collapsible sections, and primitive leaves become table rows. Used when no
 * explicit layout is supplied.
 */
export function DeepFormNode({ path, name, value, depth, root = false, headerActions }: DeepFormNodeProps) {
  if (isPlainObject(value)) {
    return (
      <ObjectCard path={path} name={name} object={value} depth={depth} root={root} headerActions={headerActions} />
    );
  }
  if (isJsonArray(value)) {
    return (
      <ArraySection path={path} name={name} items={value} depth={depth} root={root} headerActions={headerActions} />
    );
  }
  return <DeepFormFieldRow path={path} />;
}

/* -------------------------------------------------------------------------- */
/* Object card                                                                */
/* -------------------------------------------------------------------------- */

function ObjectCard({
  path,
  name,
  object,
  depth,
  root,
  headerActions,
}: {
  path: string;
  name?: string;
  object: Record<string, unknown>;
  depth: number;
  root: boolean;
  headerActions?: ReactNode;
}) {
  const { isExpanded, toggleExpanded } = useDeepForm();
  const contentId = useId();
  const { fields, sections } = partitionEntries(object);
  const title = name ? humanizeKey(name) : "Details";

  const body = (
    <>
      <DeepFormFieldsTable object={object} basePath={path} />
      {sections.length > 0 && (
        <div className={cn("space-y-2", fields.length > 0 && "mt-3")}>
          {sections.map(([key, child]) => (
            <DeepFormNode
              key={key}
              path={joinPointer(path, key)}
              name={key}
              value={child as DeepFormValue}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
      {fields.length === 0 && sections.length === 0 && <p className="text-muted-foreground text-xs">No fields.</p>}
    </>
  );

  if (root) return <div className="space-y-3">{body}</div>;

  const expanded = isExpanded(path);
  return (
    <Card data-deep-form-path={path} className="overflow-hidden">
      <CardHeader className="flex flex-row items-center gap-2 px-3 py-2">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => toggleExpanded(path)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          {expanded ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
          <span className="min-w-0 flex-1 truncate font-medium text-sm">{title}</span>
          <Badge variant="outline" className="text-[10px]">
            {fields.length + sections.length}
          </Badge>
        </button>
        {headerActions}
      </CardHeader>
      {expanded && (
        <CardContent id={contentId} className="border-t px-3 pt-3">
          {body}
        </CardContent>
      )}
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Array section                                                              */
/* -------------------------------------------------------------------------- */

function ArraySection({
  path,
  name,
  items,
  depth,
  root,
  headerActions,
}: {
  path: string;
  name?: string;
  items: unknown[];
  depth: number;
  root: boolean;
  headerActions?: ReactNode;
}) {
  const { schema, readOnly, isExpanded, toggleExpanded, addArrayItem } = useDeepForm();
  const contentId = useId();
  const expanded = isExpanded(path);
  const title = name ? humanizeKey(name) : "Items";
  const itemsDescriptor = resolveSchemaAtPointer(schema, path)?.items;
  const allPrimitives = items.length > 0 && items.every(isPrimitive);

  const handleAdd = () => addArrayItem(path, undefined, buildDefaultFromSchema(itemsDescriptor));

  const addButton = !readOnly && (
    <Button type="button" variant="outline" size="xs" onClick={handleAdd}>
      <Plus /> Add
    </Button>
  );

  const body = (
    <ArrayBody
      items={items}
      path={path}
      title={title}
      depth={depth}
      readOnly={readOnly}
      allPrimitives={allPrimitives}
    />
  );

  if (root) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-sm">{title}</span>
          {addButton}
        </div>
        {body}
      </div>
    );
  }

  return (
    <Card data-deep-form-path={path} className="overflow-hidden">
      <CardHeader className="flex flex-row items-center gap-2 px-3 py-2">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => toggleExpanded(path)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          {expanded ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
          <span className="min-w-0 flex-1 truncate font-medium text-sm">{title}</span>
          <Badge variant="outline" className="text-[10px]">
            {items.length} item{items.length === 1 ? "" : "s"}
          </Badge>
        </button>
        {addButton}
        {headerActions}
      </CardHeader>
      {expanded && (
        <CardContent id={contentId} className="border-t px-3 pt-3">
          {body}
        </CardContent>
      )}
    </Card>
  );
}

function ArrayBody({
  items,
  path,
  title,
  depth,
  readOnly,
  allPrimitives,
}: {
  items: unknown[];
  path: string;
  title: string;
  depth: number;
  readOnly: boolean;
  allPrimitives: boolean;
}) {
  const { removeArrayItem } = useDeepForm();

  if (items.length === 0) {
    return <p className="text-muted-foreground text-xs">No items yet.</p>;
  }

  if (allPrimitives) {
    return (
      <div className="overflow-hidden rounded-lg border">
        <Table className="table-fixed">
          <TableBody>
            {items.map((_item, index) => (
              <DeepFormFieldRow
                // biome-ignore lint/suspicious/noArrayIndexKey: array items have no stable identity
                key={index}
                path={joinPointer(path, index)}
                label={`#${index + 1}`}
                as="row"
                trailing={
                  readOnly ? undefined : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Remove item ${index + 1}`}
                      onClick={() => removeArrayItem(path, index)}
                    >
                      <Trash2 />
                    </Button>
                  )
                }
              />
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {items.map((item, index) => (
        <DeepFormNode
          // biome-ignore lint/suspicious/noArrayIndexKey: array items have no stable identity
          key={index}
          path={joinPointer(path, index)}
          name={`${title} ${index + 1}`}
          value={item as DeepFormValue}
          depth={depth + 1}
          headerActions={<ArrayItemActions path={path} index={index} count={items.length} />}
        />
      ))}
    </div>
  );
}

function ArrayItemActions({ path, index, count }: { path: string; index: number; count: number }) {
  const { readOnly, removeArrayItem, moveArrayItem } = useDeepForm();
  if (readOnly) return null;
  return (
    <div className="flex items-center gap-0.5">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Move item ${index + 1} up`}
        disabled={index === 0}
        onClick={() => moveArrayItem(path, index, index - 1)}
      >
        <ArrowUp />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Move item ${index + 1} down`}
        disabled={index === count - 1}
        onClick={() => moveArrayItem(path, index, index + 1)}
      >
        <ArrowDown />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Remove item ${index + 1}`}
        onClick={() => removeArrayItem(path, index)}
      >
        <Trash2 />
      </Button>
    </div>
  );
}
