"use client";

import { Table, TableBody } from "@/components/ui/table";
import { cn } from "@/lib/utils";

import { DeepFormFieldRow } from "./field-row";
import { joinPointer, partitionEntries } from "./utils";

export interface DeepFormFieldsTableProps {
  /** The object whose scalar fields are rendered as rows. */
  object: Record<string, unknown>;
  /** JSON pointer to `object` within the document. */
  basePath: string;
  className?: string;
}

/**
 * Renders the flat (non-container) fields of an object as a two-column
 * "Field / Value" table. Nested objects and arrays are handled by the caller as
 * separate cards/sections.
 */
export function DeepFormFieldsTable({ object, basePath, className }: DeepFormFieldsTableProps) {
  const { fields } = partitionEntries(object);
  if (fields.length === 0) return null;

  return (
    <div className={cn("overflow-hidden rounded-lg border", className)}>
      <Table className="table-fixed">
        <TableBody>
          {fields.map(([key]) => (
            <DeepFormFieldRow key={key} path={joinPointer(basePath, key)} as="row" />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
