"use client";

import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface DataGridPaginationProps {
  pageIndex: number;
  pageSize: number;
  totalRows: number;
  pageSizeOptions?: number[];
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  showPageSizeSelector?: boolean;
  showRowCount?: boolean;
  isLoading?: boolean;
}

export function DataGridPagination({
  pageIndex,
  pageSize,
  totalRows,
  pageSizeOptions = [10, 20, 50, 100],
  onPageChange,
  onPageSizeChange,
  showPageSizeSelector = true,
  showRowCount = true,
  isLoading,
}: DataGridPaginationProps) {
  const totalPages = Math.ceil(totalRows / pageSize);
  const startRow = pageIndex * pageSize + 1;
  const endRow = Math.min((pageIndex + 1) * pageSize, totalRows);

  const canGoPrevious = pageIndex > 0;
  const canGoNext = pageIndex < totalPages - 1;

  const rowCountLabel = () => {
    if (totalRows === 0) return "No rows";
    if (isLoading) return "Loading...";
    return (
      <>
        Showing <span className="font-medium">{startRow}</span> to <span className="font-medium">{endRow}</span> of{" "}
        <span className="font-medium">{totalRows.toLocaleString()}</span> rows
      </>
    );
  };

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      {/* Row count */}
      {showRowCount && <div className="text-sm text-muted-foreground">{rowCountLabel()}</div>}

      <div className="flex items-center gap-4">
        {/* Page size selector */}
        {showPageSizeSelector && (
          <div className="flex items-center gap-2">
            <span className="whitespace-nowrap text-muted-foreground text-sm">Rows per page</span>
            <Select value={String(pageSize)} onValueChange={(value) => onPageSizeChange(Number(value))}>
              <SelectTrigger className="h-8 w-[70px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {pageSizeOptions.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Page navigation */}
        <div className="flex items-center gap-1">
          {/* First page */}
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            onClick={() => onPageChange(0)}
            disabled={!canGoPrevious || isLoading}
            aria-label="Go to first page"
          >
            <ChevronsLeft className="size-4" />
          </Button>

          {/* Previous page */}
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            onClick={() => onPageChange(pageIndex - 1)}
            disabled={!canGoPrevious || isLoading}
            aria-label="Go to previous page"
          >
            <ChevronLeft className="size-4" />
          </Button>

          {/* Page indicator */}
          <div className="flex min-w-[100px] items-center justify-center gap-1 px-2">
            <span className="text-sm">
              Page <span className="font-medium">{pageIndex + 1}</span> of{" "}
              <span className="font-medium">{totalPages || 1}</span>
            </span>
          </div>

          {/* Next page */}
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            onClick={() => onPageChange(pageIndex + 1)}
            disabled={!canGoNext || isLoading}
            aria-label="Go to next page"
          >
            <ChevronRight className="size-4" />
          </Button>

          {/* Last page */}
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            onClick={() => onPageChange(totalPages - 1)}
            disabled={!canGoNext || isLoading}
            aria-label="Go to last page"
          >
            <ChevronsRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
