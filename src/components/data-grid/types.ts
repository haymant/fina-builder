import type { ReactNode } from "react";

import type { ColumnFiltersState, SortingState, VisibilityState } from "@tanstack/react-table";
import { z } from "zod";

// ============================================
// Filter Types
// ============================================

export const FilterTypeSchema = z.enum(["text", "number", "date", "daterange", "select", "multiselect", "boolean"]);
export type FilterType = z.infer<typeof FilterTypeSchema>;

export const FilterOperatorSchema = z.enum([
  // Text operators
  "equals",
  "notEquals",
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "blank",
  "notBlank",
  // Number operators
  "lessThan",
  "lessThanOrEqual",
  "greaterThan",
  "greaterThanOrEqual",
  "inRange",
  // Date operators
  "before",
  "after",
  "between",
  // Set operators
  "inSet",
  "notInSet",
]);
export type FilterOperator = z.infer<typeof FilterOperatorSchema>;

export const FilterConditionSchema = z.object({
  filterType: z.enum(["text", "number", "date", "set", "boolean"]),
  operator: FilterOperatorSchema,
  filter: z.union([z.string(), z.number(), z.boolean()]).optional(),
  filterTo: z.union([z.string(), z.number()]).optional(),
  values: z.array(z.string()).optional(),
});
export type FilterCondition = z.infer<typeof FilterConditionSchema>;

export const CombinedFilterSchema = z.object({
  filterType: z.literal("combined"),
  operator: z.enum(["AND", "OR"]),
  conditions: z.array(FilterConditionSchema),
});
export type CombinedFilter = z.infer<typeof CombinedFilterSchema>;

export const FilterModelSchema = z.record(z.string(), z.union([FilterConditionSchema, CombinedFilterSchema]));
export type FilterModel = z.infer<typeof FilterModelSchema>;

export interface FilterConfig {
  type: FilterType;
  options?: Array<{ label: string; value: string }>;
  placeholder?: string;
}

// ============================================
// Aggregation Types
// ============================================

export const AggregationFnSchema = z.enum(["sum", "avg", "count", "min", "max", "first", "last"]);
export type AggregationFn = z.infer<typeof AggregationFnSchema>;

// ============================================
// Sort Types
// ============================================

export const SortItemSchema = z.object({
  colId: z.string(),
  sort: z.enum(["asc", "desc"]),
});
export type SortItem = z.infer<typeof SortItemSchema>;

// ============================================
// Row Group Types
// ============================================

export const RowGroupColSchema = z.object({
  id: z.string(),
  field: z.string(),
  displayName: z.string(),
});
export type RowGroupCol = z.infer<typeof RowGroupColSchema>;

// ============================================
// Pivot Types
// ============================================

export const PivotColSchema = z.object({
  id: z.string(),
  field: z.string(),
});
export type PivotCol = z.infer<typeof PivotColSchema>;

export const ValueColSchema = z.object({
  id: z.string(),
  field: z.string(),
  aggFunc: AggregationFnSchema,
});
export type ValueCol = z.infer<typeof ValueColSchema>;

export interface PivotState {
  rowGroups: RowGroupCol[];
  columnGroups: PivotCol[];
  values: ValueCol[];
  filters: Array<{
    id: string;
    field: string;
    condition: FilterCondition;
  }>;
}

// ============================================
// SSRM Request/Response
// ============================================

export const SSRMRequestSchema = z.object({
  startRow: z.number().int().nonnegative(),
  endRow: z.number().int().positive(),
  sortModel: z.array(SortItemSchema).default([]),
  filterModel: FilterModelSchema.default({}),
  globalSearch: z.string().optional(),
  globalSearchFields: z.array(z.string()).optional(),
  rowGroupCols: z.array(RowGroupColSchema).default([]),
  groupKeys: z.array(z.string()).default([]),
  pivotMode: z.boolean().default(false),
  pivotCols: z.array(PivotColSchema).default([]),
  valueCols: z.array(ValueColSchema).default([]),
  tableName: z.string().optional(),
  includes: z.array(z.string()).optional(),
});
export type SSRMRequest = z.infer<typeof SSRMRequestSchema>;

export interface GroupedRow<TData = unknown> {
  isGroup: true;
  groupKey: string;
  groupField: string;
  groupValue: string;
  childCount: number;
  aggregations?: Record<string, number | null>;
  /**
   * Optional label shown as a badge next to the group toggle (e.g. `∑ avg`)
   * when the grid was built around a pre-aggregated OLAP matrix.
   */
  aggregationLabel?: string;
  children?: (GroupedRow<TData> | TData)[];
  isExpandable?: boolean;
}

export interface SSRMResponse<TData = unknown> {
  rowData: TData[];
  rowCount: number;
  groupedData?: GroupedRow<TData>[];
  /**
   * When the server pivots values into columns, the generated column IDs will
   * be listed here (in order).  IDs use `valueId::pivotValue` syntax.
   */
  pivotResultCols?: string[];
  metadata?: {
    queryTime?: number;
    cached?: boolean;
    totals?: Record<string, number>;
    /**
     * Values emitted for each pivot column (id -> array of distinct values).
     */
    pivotValues?: Record<string, string[]>;
  };
}

// ============================================
// Column Configuration
// ============================================

export interface ColumnConfig<TData = unknown> {
  id: string;
  accessorKey?: string;
  accessorFn?: (row: TData) => unknown;
  header: string;

  /**
   * Nested child columns. When present this column becomes a *group header*
   * (no own data) whose children render underneath it as a grouped column
   * header tree — used for pivot/spread dimensions.
   */
  columns?: ColumnConfig<TData>[];

  // Feature flags
  enableSorting?: boolean;
  enableFiltering?: boolean;
  enableHiding?: boolean;
  enableGrouping?: boolean;
  enablePivoting?: boolean;
  enableAggregation?: boolean;

  // Filter config
  filterConfig?: FilterConfig;

  // Aggregation
  aggregation?: AggregationFn;

  // Styling
  width?: number | string;
  minWidth?: number;
  maxWidth?: number;
  align?: "left" | "center" | "right";
  className?: string;
  headerClassName?: string;

  // Formatting
  numberFormat?: {
    style?: "decimal" | "currency" | "percent";
    currency?: string;
    minimumFractionDigits?: number;
    maximumFractionDigits?: number;
  };
  dateFormat?: string;

  /**
   * Optional conditional cell styling hooked from the raw value (used for
   * grouped row subtotals, leaf rows and footer/total cells alike).
   */
  valueClassName?: (value: unknown) => string;

  // Visibility
  defaultVisible?: boolean;
  pin?: "left" | "right";

  // Custom rendering
  cell?: (value: unknown, row: TData, index: number) => ReactNode;
  headerCell?: () => ReactNode;
  footer?: () => ReactNode;
}

// ============================================
// Data Source Configuration
// ============================================

export type DataSourceType = "client" | "server";

export interface DataSourceConfig<TData = unknown> {
  type: DataSourceType;
  data?: TData[];
  /**
   * Pre-hierarchised rows for client-side grouping; when present the grid
   * renders group/subtotal rows from this tree (expanded via the grid's
   * own expand/collapse state) instead of flat leaves.
   */
  groupedData?: GroupedRow<TData>[];
  endpoint?: string;
  tableName?: string;
}

// ============================================
// Feature Toggles
// ============================================

export interface GridFeatures {
  sorting?: boolean;
  filtering?: boolean;
  pagination?: boolean;
  columnVisibility?: boolean;
  rowSelection?: boolean;
  rowGrouping?: boolean;
  pivoting?: boolean;
  globalSearch?: boolean;
}

// ============================================
// Pagination Configuration
// ============================================

export interface PaginationConfig {
  pageSize?: number;
  pageSizeOptions?: number[];
  showPageSizeSelector?: boolean;
  showRowCount?: boolean;
}

// ============================================
// Toolbar Filter Configuration
// ============================================

export interface ToolbarFilterConfig {
  id: string;
  label: string;
  type: "select" | "multiselect" | "daterange";
  field: string;
  options?: Array<{ label: string; value: string }>;
}

// ============================================
// Toolbar Configuration
// ============================================

export interface ToolbarConfig {
  showSearch?: boolean;
  showColumnToggle?: boolean;
  showPivotToggle?: boolean;
  titleBadge?: ReactNode;
  customActions?: ReactNode;
  filters?: ToolbarFilterConfig[];
}

// ============================================
// Main Grid Configuration
// ============================================

export interface DataGridConfig<TData = unknown> {
  id?: string;
  columns: ColumnConfig<TData>[];
  dataSource: DataSourceConfig<TData>;
  features?: GridFeatures;
  pagination?: PaginationConfig;
  toolbar?: ToolbarConfig;
  enableRowActions?: boolean;
  getRowId?: (row: TData) => string;
  initialSorting?: SortingState;
  initialFilters?: FilterModel;
  /** Group path keys (`a::b`) expanded on mount; defaults to all groups when client groupedData is supplied. */
  initialExpandedGroups?: string[];
  /** Custom empty-state message. */
  emptyMessage?: string;
  debounceMs?: number;
  onRowAction?: (action: string, row: TData) => void;
}

// ============================================
// Internal Grid State
// ============================================

export interface DataGridState<_TData = unknown> {
  // TanStack Table states
  sorting: SortingState;
  columnFilters: ColumnFiltersState;
  columnVisibility: VisibilityState;
  rowSelection: Record<string, boolean>;
  globalFilter: string;

  // Pagination
  pageIndex: number;
  pageSize: number;

  // SSRM states
  isLoading: boolean;
  error: Error | null;
  totalRows: number;

  // Pivot states
  pivotPanelOpen: boolean;
  pivotState: PivotState;

  // Column ordering (ids in display sequence)
  columnOrder: string[];

  // Group states
  expandedGroups: Set<string>;
}

// ============================================
// Grid Context Actions
// ============================================

export interface DataGridActions<_TData = unknown> {
  setSorting: (sorting: SortingState) => void;
  setColumnFilters: (filters: ColumnFiltersState) => void;
  setColumnVisibility: (visibility: VisibilityState) => void;
  setRowSelection: (selection: Record<string, boolean>) => void;
  setGlobalFilter: (filter: string) => void;
  setPageIndex: (index: number) => void;
  setPageSize: (size: number) => void;
  togglePivotPanel: () => void;
  setPivotState: (state: PivotState) => void;
  /**
   * Reorder the visible column sequence. Takes an array of column IDs
   * representing the desired order, typically coming from the pivot panel's
   * available-field ordering.
   */
  setColumnOrder: (order: string[]) => void;
  /**
   * Convenience helper to move a column id before another.
   */
  reorderColumns: (fromId: string, toId: string) => void;
  toggleGroup: (groupKey: string) => void;
  refresh: () => void;
}

// ============================================
// Grid Context Value
// ============================================

export interface DataGridContextValue<TData = unknown> {
  config: DataGridConfig<TData>;
  state: DataGridState<TData>;
  actions: DataGridActions<TData>;
  data: TData[];
  groupedData?: GroupedRow<TData>[];
  metadata?: Record<string, any>;
}
