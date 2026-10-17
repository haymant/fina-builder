"use client";

import { useCallback, useMemo } from "react";

import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { ChevronDown, ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

import { DataGridHeaderCell } from "./data-grid-header";
import { DataGridPagination } from "./data-grid-pagination";
import { useDataGrid } from "./hooks/use-data-grid";
import type { ColumnConfig, GroupedRow } from "./types";
import {
  collectLeafColumns,
  formatCellValue,
  getAlignmentClass,
  getColumnWidthStyle,
  getNestedValue,
  getValueColorClass,
  isGroupRow,
} from "./utils";

export function DataGridTable<TData>() {
  const { config, state, actions, processedData, totalCount, flattenedGroupedData, metadata } = useDataGrid<TData>();

  const features = useMemo(
    () => ({
      sorting: true,
      filtering: true,
      pagination: true,
      ...config.features,
    }),
    [config.features],
  );

  const leafColumns = useMemo(() => collectLeafColumns(config.columns), [config.columns]);
  const leafColumnMap = useMemo(() => new Map(leafColumns.map((col) => [col.id, col])), [leafColumns]);

  const pivotColumnMeta = useMemo(
    () =>
      Array.isArray(metadata?.pivotColumns)
        ? (metadata.pivotColumns as Array<{ id: string; valueId: string; header?: string; labels: string[] }>)
        : [],
    [metadata],
  );

  const pivotColumnMap = useMemo(() => new Map(pivotColumnMeta.map((item) => [item.id, item])), [pivotColumnMeta]);

  // Shared value renderer: alignment + optional conditional tinting + custom cell.
  const renderCellValue = useCallback(
    (value: unknown, col: ColumnConfig<TData> | undefined, row: TData, index: number) => {
      if (!col) return <div className="min-h-10 px-3 py-2" />;
      const tint = col.valueClassName?.(value);
      if (col.cell) {
        return (
          <div className={cn("px-3 py-2", getAlignmentClass(col.align), col.className, tint)}>
            {col.cell(value, row, index)}
          </div>
        );
      }
      return (
        <div className={cn("px-3 py-2", getAlignmentClass(col.align), col.className, tint, getValueColorClass(value))}>
          {formatCellValue(value, col)}
        </div>
      );
    },
    [],
  );

  // Transform column config into TanStack Table column defs. The tree honours
  // `ColumnConfig.columns` (group headers for pivot/spread dimensions) and the
  // `state.columnOrder` sequence, omitting pivot columns when the server has
  // generated pivotResultCols.
  const columns: ColumnDef<TData>[] = useMemo(() => {
    const pivotCols = state.pivotState.columnGroups.map((cg) => cg.id);
    const pivotModeActive = pivotCols.length > 0;
    const orderMap = new Map(state.columnOrder.map((id, idx) => [id, idx]));
    const orderOf = (id: string) => (orderMap.has(id) ? orderMap.get(id)! : Number.POSITIVE_INFINITY);

    const buildLeafDef = (col: ColumnConfig<TData>): ColumnDef<TData> => ({
      id: col.id,
      accessorFn: col.accessorFn ?? (col.accessorKey ? (row) => getNestedValue(row, col.accessorKey!) : undefined),
      header: ({ column }) => {
        const sortDirection = column.getIsSorted();
        const isFiltered = column.getIsFiltered();
        const filterValue = column.getFilterValue();

        if (col.headerCell) {
          return col.headerCell();
        }

        return (
          <DataGridHeaderCell
            column={col}
            sortDirection={sortDirection}
            isFiltered={isFiltered}
            onSort={() => {
              if (col.enableSorting !== false) {
                column.toggleSorting();
              }
            }}
            onFilter={(value) => {
              column.setFilterValue(value);
            }}
            onClearFilter={() => {
              column.setFilterValue(undefined);
            }}
            currentFilterValue={filterValue}
          />
        );
      },
      cell: ({ getValue, row }) => renderCellValue(getValue(), col, row.original, row.index),
      enableSorting: col.enableSorting !== false && features.sorting,
      enableColumnFilter: col.enableFiltering !== false && features.filtering,
      enableHiding: col.enableHiding !== false,
      size: typeof col.width === "number" ? col.width : undefined,
      minSize: col.minWidth,
      maxSize: col.maxWidth,
    });

    const buildGroupDef = (col: ColumnConfig<TData>): ColumnDef<TData> => ({
      id: col.id,
      header: () => (
        <div className={cn("min-h-[40px] px-3 py-2 font-medium text-sm", col.headerClassName)}>
          {col.headerCell ? col.headerCell() : col.header}
        </div>
      ),
      enableSorting: false,
      enableHiding: false,
      columns: col.columns!.map((child) => (child.columns?.length ? buildGroupDef(child) : buildLeafDef(child))),
    });

    const defs: ColumnDef<TData>[] = [];
    for (const col of config.columns) {
      if (col.columns && col.columns.length > 0) {
        defs.push(buildGroupDef(col));
        continue;
      }
      if (pivotModeActive && pivotCols.includes(col.id)) {
        continue;
      }
      defs.push(buildLeafDef(col));
    }
    // Honour pivot-driven reordering on flat leaf columns.
    if (!pivotModeActive && orderMap.size > 0 && defs.length > 1) {
      const flatLeafIndex = new Map<string, { col: ColumnConfig<TData>; def: ColumnDef<TData> }>();
      for (let i = 0; i < defs.length; i++) {
        const col = leafColumns.find((c) => c.id === (defs[i].id as string));
        if (col) flatLeafIndex.set(col.id, { col, def: defs[i] });
      }
      const leaves = Array.from(flatLeafIndex.values());
      if (leaves.length === defs.length) {
        leaves.sort((a, b) => orderOf(a.col.id) - orderOf(b.col.id));
        return leaves.map((entry) => entry.def);
      }
    }

    // append any dynamic pivot columns generated by SSRM
    if (pivotColumnMeta.length === 0) {
      return defs;
    }

    const buildPivotLeaf = (pivotMeta: {
      id: string;
      valueId: string;
      header?: string;
      labels: string[];
    }): ColumnDef<TData> => {
      const valueColumn = leafColumnMap.get(pivotMeta.valueId);
      return {
        id: pivotMeta.id,
        accessorFn: (row: unknown) => (row as Record<string, unknown>)[pivotMeta.id],
        header: valueColumn?.header || pivotMeta.header || pivotMeta.valueId,
        cell: ({ getValue }) => renderCellValue(getValue(), valueColumn, getValue() as TData, 0),
        enableSorting: false,
        enableColumnFilter: false,
        size: typeof valueColumn?.width === "number" ? valueColumn.width : undefined,
        minSize: valueColumn?.minWidth,
        maxSize: valueColumn?.maxWidth,
      };
    };

    const pivotRoots: Array<ColumnDef<TData>> = [];
    const pivotGroupIndex = new Map<string, ColumnDef<TData> & { columns: ColumnDef<TData>[] }>();

    for (const pivotMeta of pivotColumnMeta) {
      let currentPath = "";
      let siblingGroups = pivotRoots;

      pivotMeta.labels.forEach((label) => {
        currentPath = currentPath ? `${currentPath}::${label}` : label;
        const existing = pivotGroupIndex.get(currentPath);
        if (existing) {
          siblingGroups = existing.columns;
          return;
        }

        const group: ColumnDef<TData> & { columns: ColumnDef<TData>[] } = {
          id: `pivot-group-${currentPath}`,
          header: label,
          columns: [],
        };
        siblingGroups.push(group);
        pivotGroupIndex.set(currentPath, group);
        siblingGroups = group.columns;
      });

      siblingGroups.push(buildPivotLeaf(pivotMeta));
    }

    return [...defs, ...pivotRoots];
  }, [config, features, state, leafColumns, leafColumnMap, pivotColumnMeta, renderCellValue]);

  // Create table instance
  const table = useReactTable({
    data: processedData,
    columns,
    state: {
      sorting: state.sorting,
      columnFilters: state.columnFilters,
      columnVisibility: state.columnVisibility,
      rowSelection: state.rowSelection,
      globalFilter: state.globalFilter,
      pagination: {
        pageIndex: state.pageIndex,
        pageSize: state.pageSize,
      },
    },
    onSortingChange: (updater) => actions.setSorting(typeof updater === "function" ? updater(state.sorting) : updater),
    onColumnFiltersChange: (updater) =>
      actions.setColumnFilters(typeof updater === "function" ? updater(state.columnFilters) : updater),
    onColumnVisibilityChange: (updater) =>
      actions.setColumnVisibility(typeof updater === "function" ? updater(state.columnVisibility) : updater),
    onRowSelectionChange: (updater) =>
      actions.setRowSelection(typeof updater === "function" ? updater(state.rowSelection) : updater),
    onGlobalFilterChange: (updater) =>
      actions.setGlobalFilter(typeof updater === "function" ? updater(state.globalFilter) : updater),
    onPaginationChange: (updater) => {
      const next =
        typeof updater === "function" ? updater({ pageIndex: state.pageIndex, pageSize: state.pageSize }) : updater;
      actions.setPageIndex(next.pageIndex);
      actions.setPageSize(next.pageSize);
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: config.dataSource.type === "client" ? getSortedRowModel() : undefined,
    getFilteredRowModel: config.dataSource.type === "client" ? getFilteredRowModel() : undefined,
    getPaginationRowModel: config.dataSource.type === "client" ? getPaginationRowModel() : undefined,
    manualPagination: config.dataSource.type === "server",
    manualSorting: config.dataSource.type === "server",
    manualFiltering: config.dataSource.type === "server",
    pageCount: Math.ceil(totalCount / state.pageSize),
    getRowId: config.getRowId,
  });

  const rows = table.getRowModel().rows;
  const visibleColumns = table.getVisibleLeafColumns();
  const hasGroupedRows = flattenedGroupedData.length > 0;
  const pinnedClass = (pin?: "left" | "right", bg = "bg-background") =>
    cn(pin === "left" && cn("sticky left-0 z-[5]", bg), pin === "right" && cn("sticky right-0 z-[5]", bg));
  const hasFooter = useMemo(() => {
    const scan = (cols: ColumnConfig<TData>[]): boolean => cols.some((c) => c.footer || (c.columns && scan(c.columns)));
    return scan(config.columns);
  }, [config.columns]);

  const renderLeafCell = (columnId: string, row: TData, index: number) => {
    const column = leafColumnMap.get(columnId);
    if (!column) {
      return null;
    }

    const value = column.accessorFn
      ? column.accessorFn(row)
      : column.accessorKey
        ? getNestedValue(row, column.accessorKey)
        : undefined;

    return renderCellValue(value, column, row, index);
  };

  const renderGroupCell = (columnId: string, groupRow: GroupedRow<TData>, depth: number, pathKey: string) => {
    const column = leafColumnMap.get(columnId);
    const pivotMeta = pivotColumnMap.get(columnId);
    const valueColumn = pivotMeta ? leafColumnMap.get(pivotMeta.valueId) : undefined;
    const renderColumn = column || valueColumn;

    if (!renderColumn && !pivotMeta) {
      return <div className="min-h-10 px-3 py-2" />;
    }

    const isGroupingColumn = column?.id === groupRow.groupField;
    const aggregationValue = groupRow.aggregations?.[columnId];

    if (isGroupingColumn) {
      const isExpanded = state.expandedGroups.has(pathKey);
      return (
        <button
          type="button"
          onClick={() => actions.toggleGroup(pathKey)}
          className="flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left"
          style={{ paddingLeft: `${depth * 20 + 12}px` }}
        >
          {isExpanded ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
          <span className="font-medium">{groupRow.groupValue}</span>
          <span className="text-muted-foreground text-xs">({groupRow.childCount})</span>
          {groupRow.aggregationLabel && (
            <Badge variant="secondary" className="gap-0 font-mono text-[9px] normal-case">
              {groupRow.aggregationLabel}
            </Badge>
          )}
        </button>
      );
    }

    if (aggregationValue !== undefined) {
      const tint = renderColumn?.valueClassName?.(aggregationValue);
      return (
        <div
          className={cn("px-3 py-2 font-medium", getAlignmentClass(renderColumn?.align), renderColumn?.className, tint)}
        >
          {renderColumn
            ? renderColumn.cell
              ? renderColumn.cell(aggregationValue, groupRow as unknown as TData, depth)
              : formatCellValue(aggregationValue, renderColumn)
            : String(aggregationValue)}
        </div>
      );
    }

    return <div className="min-h-10 px-3 py-2" />;
  };

  return (
    <div className="space-y-4">
      {/* Table */}
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const colConfig = leafColumnMap.get(header.column.id as string);
                  const isPinned = colConfig?.pin;

                  return (
                    <TableHead
                      key={header.id}
                      colSpan={header.colSpan}
                      style={colConfig ? getColumnWidthStyle(colConfig) : undefined}
                      className={cn("p-0", isPinned && pinnedClass(isPinned))}
                    >
                      {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {state.isLoading ? (
              // Loading skeleton
              Array.from({ length: state.pageSize }).map((_, i) => (
                <TableRow key={`skeleton-${i}`}>
                  {leafColumns.map((col) => (
                    <TableCell key={col.id} className={cn("p-3", col.pin && pinnedClass(col.pin, "bg-muted/40"))}>
                      <Skeleton className="h-5 w-full bg-muted/35" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : hasGroupedRows ? (
              flattenedGroupedData.map((item, index) => {
                const pathKey = item.path.join("::");

                if (isGroupRow(item.data)) {
                  return (
                    <TableRow key={`group-${pathKey}`} className="bg-muted/30 hover:bg-muted/40">
                      {visibleColumns.map((column) => {
                        const colConfig = leafColumnMap.get(column.id as string);
                        return (
                          <TableCell
                            key={`${pathKey}-${column.id}`}
                            className={cn(
                              "p-0 align-middle",
                              colConfig?.pin && pinnedClass(colConfig.pin, "bg-muted/40"),
                            )}
                          >
                            {renderGroupCell(column.id as string, item.data as GroupedRow<TData>, item.depth, pathKey)}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  );
                }

                return (
                  <TableRow key={`row-${pathKey}-${index}`}>
                    {visibleColumns.map((column) => {
                      const colConfig = leafColumnMap.get(column.id as string);
                      return (
                        <TableCell
                          key={`${pathKey}-${column.id}`}
                          className={cn("p-0", colConfig?.pin && pinnedClass(colConfig.pin))}
                        >
                          {renderLeafCell(column.id as string, item.data as TData, index)}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                );
              })
            ) : rows.length === 0 ? (
              // Empty state
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                  {config.emptyMessage ?? "No results found"}
                </TableCell>
              </TableRow>
            ) : (
              // Data rows
              rows.map((row) => (
                <TableRow key={row.id} data-state={row.getIsSelected() && "selected"}>
                  {row.getVisibleCells().map((cell) => {
                    const colConfig = leafColumnMap.get(cell.column.id as string);
                    return (
                      <TableCell key={cell.id} className={cn("p-0", colConfig?.pin && pinnedClass(colConfig.pin))}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))
            )}
          </TableBody>
          {hasFooter && (
            <TableFooter>
              {table.getFooterGroups().map((footerGroup) => (
                <TableRow key={footerGroup.id}>
                  {footerGroup.headers.map((header) => {
                    const colConfig = leafColumnMap.get(header.column.id as string);
                    return (
                      <TableCell
                        key={header.id}
                        colSpan={header.colSpan}
                        className={cn(
                          "whitespace-nowrap px-3 py-2 align-middle",
                          getAlignmentClass(colConfig?.align),
                          colConfig?.pin && pinnedClass(colConfig.pin, "bg-muted/50"),
                          colConfig?.valueClassName?.(undefined) && "",
                        )}
                      >
                        {header.isPlaceholder ? null : (colConfig?.footer?.() ?? null)}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableFooter>
          )}
        </Table>
      </div>

      {/* Pagination */}
      {features.pagination && (
        <DataGridPagination
          pageIndex={state.pageIndex}
          pageSize={state.pageSize}
          totalRows={totalCount}
          pageSizeOptions={config.pagination?.pageSizeOptions || [10, 20, 50, 100]}
          onPageChange={actions.setPageIndex}
          onPageSizeChange={actions.setPageSize}
          showPageSizeSelector={config.pagination?.showPageSizeSelector !== false}
          showRowCount={config.pagination?.showRowCount !== false}
          isLoading={state.isLoading}
        />
      )}

      {/* Error display */}
      {state.error && (
        <div className="rounded-md bg-destructive/10 p-4 text-destructive text-sm">
          Error loading data: {state.error.message}
        </div>
      )}
    </div>
  );
}
