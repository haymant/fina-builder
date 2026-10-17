"use client";

import { useState } from "react";

import { MoreVertical } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { DataGridFilterPopover } from "./data-grid-filter-popover";
import type { ColumnConfig } from "./types";

interface DataGridHeaderCellProps<TData> {
  column: ColumnConfig<TData>;
  sortDirection?: "asc" | "desc" | false;
  isFiltered?: boolean;
  onSort?: () => void;
  onFilter?: (value: unknown) => void;
  onClearFilter?: () => void;
  currentFilterValue?: unknown;
}

export function DataGridHeaderCell<TData>({
  column,
  sortDirection,
  isFiltered,
  onSort,
  onFilter,
  onClearFilter,
  currentFilterValue,
}: DataGridHeaderCellProps<TData>) {
  const [isFilterOpen, setIsFilterOpen] = useState(false);

  const canSort = column.enableSorting !== false;
  const canFilter = column.enableFiltering !== false && column.filterConfig;
  const showFilterControl = Boolean(canFilter);

  const alignClass = cn(column.align === "right" && "text-right", column.align === "center" && "text-center");

  const filterWidget = showFilterControl ? (
    <DataGridFilterPopover
      column={column}
      isOpen={isFilterOpen}
      onOpenChange={setIsFilterOpen}
      onApply={onFilter}
      onClear={onClearFilter}
      currentValue={currentFilterValue}
    >
      <Button
        variant="ghost"
        size="icon"
        className={cn(
          "size-6 transition-opacity",
          isFilterOpen || isFiltered
            ? "opacity-100"
            : "pointer-events-none opacity-0 group-focus-within:opacity-100 group-hover:opacity-100",
          isFiltered && "text-primary",
        )}
        aria-label={`Filter ${column.header}`}
      >
        <MoreVertical className="size-3.5" />
      </Button>
    </DataGridFilterPopover>
  ) : isFiltered ? (
    <span className="size-1.5 rounded-full bg-primary" role="status" aria-label="Filter active" />
  ) : null;

  return (
    <div
      className={cn(
        "group relative flex select-none items-center gap-2",
        "min-h-[40px] px-3 py-2",
        column.headerClassName,
      )}
    >
      {/* Header content with sort indicator */}
      {canSort ? (
        <button
          type="button"
          className={cn("relative flex-1 cursor-pointer font-medium text-sm", alignClass)}
          onClick={onSort}
        >
          <span className="relative z-10">{column.header}</span>

          {/* Sort indicator shadow - below text for ASC */}
          {sortDirection === "asc" && (
            <span
              className="absolute right-0 bottom-0 left-0 h-[3px] bg-gradient-to-t from-primary/40 to-transparent"
              aria-hidden="true"
            />
          )}

          {/* Sort indicator shadow - above text for DESC */}
          {sortDirection === "desc" && (
            <span
              className="absolute top-0 right-0 left-0 h-[3px] bg-gradient-to-b from-primary/40 to-transparent"
              aria-hidden="true"
            />
          )}
        </button>
      ) : (
        <span className={cn("relative flex-1 font-medium text-sm", alignClass)}>{column.header}</span>
      )}

      <div className="flex w-6 shrink-0 items-center justify-center">{filterWidget}</div>

      {/* Screen reader text for sort state */}
      {sortDirection && <span className="sr-only">Sorted {sortDirection === "asc" ? "ascending" : "descending"}</span>}
    </div>
  );
}

// Simpler header for non-interactive columns (like actions)
interface DataGridHeaderSimpleProps {
  children?: React.ReactNode;
  className?: string;
  align?: "left" | "center" | "right";
}

export function DataGridHeaderSimple({ children, className, align = "left" }: DataGridHeaderSimpleProps) {
  return (
    <div
      className={cn(
        "flex min-h-[40px] items-center px-3 py-2 font-medium text-sm",
        align === "right" && "justify-end",
        align === "center" && "justify-center",
        className,
      )}
    >
      {children}
    </div>
  );
}
