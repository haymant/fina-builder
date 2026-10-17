"use client";

import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import type { ColumnFiltersState, SortingState, VisibilityState } from "@tanstack/react-table";

import type {
  DataGridActions,
  DataGridConfig,
  DataGridContextValue,
  DataGridState,
  FilterModel,
  GroupedRow,
  PivotState,
  SortItem,
  SSRMRequest,
  SSRMResponse,
} from "../types";
import { collectGroupKeys, flattenGroupedData } from "../utils";

// Default values
const defaultPivotState: PivotState = {
  rowGroups: [],
  columnGroups: [],
  values: [],
  filters: [],
};

export const defaultFeatures = {
  sorting: true,
  filtering: true,
  pagination: true,
  columnVisibility: true,
  rowSelection: false,
  rowGrouping: false,
  pivoting: false,
  globalSearch: true,
};

const defaultPagination = {
  pageSize: 20,
  pageSizeOptions: [10, 20, 50, 100],
  showPageSizeSelector: true,
  showRowCount: true,
};

// Context
const DataGridContext = createContext<DataGridContextValue<unknown> | null>(null);

export function useDataGridContext<TData = unknown>() {
  const context = useContext(DataGridContext) as DataGridContextValue<TData> | null;
  if (!context) {
    throw new Error("useDataGridContext must be used within DataGridProvider");
  }
  return context;
}

// Provider Props
interface DataGridProviderProps<TData> {
  config: DataGridConfig<TData>;
  children: React.ReactNode;
}

export function DataGridProvider<TData>({ config, children }: DataGridProviderProps<TData>) {
  const pagination = { ...defaultPagination, ...config.pagination };

  // Initialize column visibility from config
  const initialVisibility = useMemo(() => {
    const visibility: VisibilityState = {};
    for (const col of config.columns) {
      if (col.defaultVisible === false) {
        visibility[col.id] = false;
      }
    }
    return visibility;
  }, [config.columns]);

  // State
  const [sorting, setSorting] = useState<SortingState>(config.initialSorting || []);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(initialVisibility);
  const [rowSelection, setRowSelection] = useState<Record<string, boolean>>({});
  const [globalFilter, setGlobalFilter] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(pagination.pageSize || 20);
  const [pivotPanelOpen, setPivotPanelOpen] = useState(false);
  const [pivotState, setPivotState] = useState<PivotState>(defaultPivotState);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => {
    if (config.initialExpandedGroups) {
      return new Set(config.initialExpandedGroups);
    }
    const grouped = config.dataSource.groupedData;
    return grouped ? new Set(collectGroupKeys(grouped)) : new Set();
  });

  // Column ordering state (to support pivot-driven reordering)
  const [columnOrder, setColumnOrder] = useState<string[]>(() => config.columns.map((c) => c.id));

  // Server-side state
  const [isLoading, setIsLoading] = useState(config.dataSource.type === "server");
  const [error, setError] = useState<Error | null>(null);
  const [totalRows, setTotalRows] = useState(0);
  const [serverData, setServerData] = useState<TData[]>([]);
  const [serverGroupedData, setServerGroupedData] = useState<GroupedRow<TData>[] | undefined>(undefined);
  const [metadata, setMetadata] = useState<Record<string, any>>({});

  // Debounce ref
  const debounceRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const debounceMs = config.debounceMs ?? 300;

  // Convert column filters to filter model
  const buildFilterModel = useCallback((): FilterModel => {
    const model: FilterModel = {};

    for (const filter of columnFilters) {
      if (filter.value !== undefined && filter.value !== "") {
        const columnConfig = config.columns.find((c) => c.id === filter.id);
        const filterType = columnConfig?.filterConfig?.type || "text";

        // Determine the operator from the filter type and value below.
        const filterValue = filter.value;

        if (filterType === "select" || filterType === "multiselect") {
          if (Array.isArray(filterValue)) {
            model[filter.id] = {
              filterType: "set",
              operator: "inSet",
              values: filterValue as string[],
            };
          } else {
            model[filter.id] = {
              filterType: "text",
              operator: "equals",
              filter: filterValue as string,
            };
          }
        } else if (filterType === "number") {
          model[filter.id] = {
            filterType: "number",
            operator: "equals",
            filter: filterValue as number,
          };
        } else if (filterType === "date" || filterType === "daterange") {
          if (typeof filterValue === "object" && filterValue !== null && "from" in filterValue) {
            const range = filterValue as { from?: Date; to?: Date };
            model[filter.id] = {
              filterType: "date",
              operator: "between",
              filter: range.from?.toISOString().split("T")[0],
              filterTo: range.to?.toISOString().split("T")[0],
            };
          } else {
            model[filter.id] = {
              filterType: "date",
              operator: "equals",
              filter: filterValue as string,
            };
          }
        } else {
          model[filter.id] = {
            filterType: "text",
            operator: "contains",
            filter: filterValue as string,
          };
        }
      }
    }

    return model;
  }, [columnFilters, config.columns]);

  // Build sort model
  const buildSortModel = useCallback((): SortItem[] => {
    return sorting.map((s) => ({
      colId: s.id,
      sort: s.desc ? ("desc" as const) : ("asc" as const),
    }));
  }, [sorting]);

  // Fetch data from server
  const fetchServerData = useCallback(async () => {
    if (config.dataSource.type !== "server" || !config.dataSource.endpoint) {
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const request: SSRMRequest = {
        startRow: pageIndex * pageSize,
        endRow: (pageIndex + 1) * pageSize,
        sortModel: buildSortModel(),
        filterModel: buildFilterModel(),
        globalSearch: globalFilter || undefined,
        globalSearchFields: config.columns
          .filter((c) => c.enableFiltering !== false)
          .map((c) => c.accessorKey || c.id)
          .filter(Boolean),
        tableName: config.dataSource.tableName,
        rowGroupCols: pivotState.rowGroups,
        groupKeys: [],
        pivotMode: pivotState.columnGroups.length > 0,
        pivotCols: pivotState.columnGroups,
        valueCols: pivotState.values,
      };

      const response = await fetch(config.dataSource.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        throw new Error(`SSRM request failed: ${response.statusText}`);
      }

      const data: SSRMResponse<TData> = await response.json();

      setServerData(data.rowData);
      setTotalRows(data.rowCount);
      setServerGroupedData(data.groupedData);
      setMetadata({
        ...(data.metadata ?? {}),
        pivotResultCols: data.pivotResultCols ?? [],
      });
    } catch (err) {
      setError(err instanceof Error ? err : new Error("Unknown error"));
    } finally {
      setIsLoading(false);
    }
  }, [
    config.dataSource,
    config.columns,
    pageIndex,
    pageSize,
    buildSortModel,
    buildFilterModel,
    globalFilter,
    pivotState,
  ]);

  // Debounced fetch
  const debouncedFetch = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(fetchServerData, debounceMs);
  }, [fetchServerData, debounceMs]);

  // Effect to fetch data when relevant state changes
  useEffect(() => {
    if (config.dataSource.type === "server") {
      debouncedFetch();
    }
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [debouncedFetch, config.dataSource.type]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally depends on the filter inputs, not their rendered values
  useEffect(() => {
    setPageIndex(0);
  }, [sorting, columnFilters, globalFilter, pivotState]);

  // Actions
  const actions: DataGridActions<TData> = useMemo(
    () => ({
      setSorting,
      setColumnFilters,
      setColumnVisibility,
      setRowSelection,
      setGlobalFilter,
      setPageIndex,
      setPageSize: (size) => {
        setPageSize(size);
        setPageIndex(0); // Reset to first page when page size changes
      },
      togglePivotPanel: () => setPivotPanelOpen((prev) => !prev),
      setPivotState,
      setColumnOrder: (order: string[]) => {
        setColumnOrder(order);
      },
      reorderColumns: (fromId: string, toId: string) => {
        setColumnOrder((prev) => {
          const fromIndex = prev.indexOf(fromId);
          const toIndex = prev.indexOf(toId);
          if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) {
            return prev;
          }
          const next = [...prev];
          const [moved] = next.splice(fromIndex, 1);
          next.splice(toIndex, 0, moved);
          return next;
        });
      },
      toggleGroup: (groupKey: string) => {
        setExpandedGroups((prev) => {
          const next = new Set(prev);
          if (next.has(groupKey)) {
            next.delete(groupKey);
          } else {
            next.add(groupKey);
          }
          return next;
        });
      },
      refresh: () => {
        if (config.dataSource.type === "server") {
          void fetchServerData();
        }
      },
    }),
    [config.dataSource.type, fetchServerData],
  );

  // State object
  const state: DataGridState<TData> = useMemo(
    () => ({
      sorting,
      columnFilters,
      columnVisibility,
      rowSelection,
      globalFilter,
      pageIndex,
      pageSize,
      isLoading,
      error,
      totalRows,
      pivotPanelOpen,
      pivotState,
      columnOrder,
      expandedGroups,
    }),
    [
      sorting,
      columnFilters,
      columnVisibility,
      rowSelection,
      globalFilter,
      pageIndex,
      pageSize,
      isLoading,
      error,
      totalRows,
      pivotPanelOpen,
      pivotState,
      columnOrder,
      expandedGroups,
    ],
  );

  // Determine which data to use
  const data = useMemo(() => {
    if (config.dataSource.type === "server") {
      return serverData;
    }
    return config.dataSource.data ?? [];
  }, [config.dataSource, serverData]);

  // Client grouped rows are derived live from config so a rebuilt group tree
  // (e.g. an OLAP row-axis change) flows through to the grid without a remount.
  const groupedData = useMemo(() => {
    if (config.dataSource.type === "server") {
      return serverGroupedData;
    }
    return config.dataSource.groupedData ?? [];
  }, [config.dataSource, serverGroupedData]);

  // Keep newly-seen group keys expanded (the grid defaults to everything open)
  // so a rebuilt client group tree is never hidden behind stale expansion state.
  useEffect(() => {
    setExpandedGroups((prev) => {
      const keys = collectGroupKeys(groupedData ?? []);
      if (keys.length === 0) {
        return prev;
      }
      const next = new Set(prev);
      let changed = false;
      for (const key of keys) {
        if (!next.has(key)) {
          next.add(key);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [groupedData]);

  // Context value
  const contextValue: DataGridContextValue<TData> = useMemo(
    () => ({
      config,
      state,
      actions,
      data,
      groupedData,
      metadata,
    }),
    [config, state, actions, data, groupedData, metadata],
  );

  return createElement(DataGridContext.Provider, { value: contextValue as DataGridContextValue<unknown> }, children);
}

// Hook to use data grid with TanStack Table
export function useDataGrid<TData>() {
  const context = useDataGridContext<TData>();
  // include metadata from context so we can use it below without causing a ReferenceError
  const { config, state, data, groupedData } = context;

  // Client-side filtering
  const filteredData = useMemo(() => {
    if (config.dataSource.type === "server") {
      return data; // Server handles filtering
    }

    let result = [...data];

    // Apply global filter
    if (state.globalFilter) {
      const search = state.globalFilter.toLowerCase();
      result = result.filter((row) => {
        return config.columns.some((col) => {
          if (col.enableFiltering === false) return false;
          const key = col.accessorKey;
          if (!key) return false;
          const value = getNestedValue(row, key);
          return String(value).toLowerCase().includes(search);
        });
      });
    }

    // Apply column filters
    for (const filter of state.columnFilters) {
      const col = config.columns.find((c) => c.id === filter.id);
      if (!col || !col.accessorKey) continue;

      result = result.filter((row) => {
        const value = getNestedValue(row, col.accessorKey!);
        if (filter.value === undefined || filter.value === "") return true;

        // Simple contains filter for text
        return String(value).toLowerCase().includes(String(filter.value).toLowerCase());
      });
    }

    return result;
  }, [data, config.dataSource.type, config.columns, state.globalFilter, state.columnFilters]);

  // Client-side sorting
  const sortedData = useMemo(() => {
    if (config.dataSource.type === "server") {
      return filteredData; // Server handles sorting
    }

    if (state.sorting.length === 0) {
      return filteredData;
    }

    return [...filteredData].sort((a, b) => {
      for (const sort of state.sorting) {
        const col = config.columns.find((c) => c.id === sort.id);
        if (!col || !col.accessorKey) continue;

        const aVal = getNestedValue(a, col.accessorKey);
        const bVal = getNestedValue(b, col.accessorKey);

        let comparison = 0;
        if (aVal === null || aVal === undefined) comparison = 1;
        else if (bVal === null || bVal === undefined) comparison = -1;
        else if (aVal < bVal) comparison = -1;
        else if (aVal > bVal) comparison = 1;

        if (comparison !== 0) {
          return sort.desc ? -comparison : comparison;
        }
      }
      return 0;
    });
  }, [filteredData, config.dataSource.type, config.columns, state.sorting]);

  // Client-side pagination – react-table will handle the slicing for us via
  // getPaginationRowModel. We only need to supply the full sorted data here.
  const paginatedData = useMemo(() => {
    return sortedData;
  }, [sortedData]);

  // Total count for pagination
  const totalCount = config.dataSource.type === "server" ? state.totalRows : sortedData.length;

  const flattenedGroupedData = useMemo(() => {
    if (!groupedData || groupedData.length === 0) {
      return [];
    }
    return flattenGroupedData(groupedData, state.expandedGroups);
  }, [groupedData, state.expandedGroups]);

  // return an augmented context — metadata is already included in `context`,
  // so we dont need to redeclare it separately. Keeping it here is harmless but
  // referencing the variable ensures it's defined.
  return {
    ...context,
    processedData: paginatedData,
    totalCount,
    flattenedGroupedData,
  };
}

// Utility to get nested value from object
function getNestedValue(obj: unknown, path: string): unknown {
  const keys = path.split(".");
  let value: unknown = obj;
  for (const key of keys) {
    if (value === null || value === undefined) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
