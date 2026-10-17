import { format } from "date-fns";

import type { ColumnConfig, GroupedRow } from "./types";

/**
 * Get nested value from object using dot notation path
 * e.g., getNestedValue(obj, "user.profile.name")
 */
export function getNestedValue<T>(obj: T, path: string): unknown {
  if (!path) return undefined;
  const keys = path.split(".");
  let value: unknown = obj;
  for (const key of keys) {
    if (value === null || value === undefined) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/**
 * Format a cell value based on column configuration
 */
export function formatCellValue<TData>(value: unknown, column: ColumnConfig<TData>): string {
  if (value === null || value === undefined) {
    return "-";
  }

  // Date formatting (only if value is Date or column explicitly requests it)
  const dateFormat = column.dateFormat ?? "yyyy-MM-dd";
  if (column.dateFormat || value instanceof Date) {
    const date = value instanceof Date ? value : new Date(String(value));
    if (!isNaN(date.getTime())) {
      return format(date, dateFormat);
    }
    // fall through
  }

  // Number formatting (default 2 decimals)
  const num = typeof value === "number" ? value : parseFloat(String(value));
  if (!Number.isNaN(num)) {
    return new Intl.NumberFormat("en-US", {
      style: column.numberFormat?.style ?? "decimal",
      currency: column.numberFormat?.currency,
      minimumFractionDigits: column.numberFormat?.minimumFractionDigits ?? 2,
      maximumFractionDigits: column.numberFormat?.maximumFractionDigits ?? 2,
    }).format(num);
  }

  // Boolean formatting
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }

  return String(value);
}

export function getValueColorClass(value: unknown): string {
  const num = typeof value === "number" ? value : parseFloat(String(value));
  if (!Number.isNaN(num)) {
    if (num < 0) return "text-destructive";
    if (num > 0) return "text-emerald-600";
  }
  return "";
}

/**
 * Generate a unique ID for the grid instance
 */
export function generateGridId(): string {
  return `grid-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Calculate column width class based on configuration
 */
export function getColumnWidthStyle<TData = unknown>(column: ColumnConfig<TData>): React.CSSProperties {
  const style: React.CSSProperties = {};

  if (column.width) {
    style.width = typeof column.width === "number" ? `${column.width}px` : column.width;
  }

  if (column.minWidth) {
    style.minWidth = `${column.minWidth}px`;
  }

  if (column.maxWidth) {
    style.maxWidth = `${column.maxWidth}px`;
  }

  return style;
}

/**
 * Get alignment class for cell
 */
export function getAlignmentClass(align?: "left" | "center" | "right"): string {
  switch (align) {
    case "right":
      return "text-right";
    case "center":
      return "text-center";
    default:
      return "text-left";
  }
}

/**
 * Debounce function
 */
export function debounce<T extends (...args: Parameters<T>) => void>(
  fn: T,
  ms: number,
): (...args: Parameters<T>) => void {
  let timeoutId: NodeJS.Timeout;
  return (...args: Parameters<T>) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), ms);
  };
}

/**
 * Create a cache key from SSRM request parameters
 */
export function createCacheKey(params: Record<string, unknown>): string {
  return JSON.stringify(params, Object.keys(params).sort());
}

/**
 * Parse filter value based on filter type
 */
export function parseFilterValue(value: string, filterType: string): unknown {
  switch (filterType) {
    case "number":
      return parseFloat(value) || 0;
    case "boolean":
      return value.toLowerCase() === "true";
    case "date":
      return value; // Keep as string for date
    default:
      return value;
  }
}

/**
 * Serialize pivot state for URL/storage
 */
export function serializePivotState(state: {
  rowGroups: Array<{ id: string; field: string; displayName: string }>;
  columnGroups: Array<{ id: string; field: string }>;
  values: Array<{ id: string; field: string; aggFunc: string }>;
}): string {
  return JSON.stringify({
    rg: state.rowGroups.map((r) => r.id),
    cg: state.columnGroups.map((c) => c.id),
    v: state.values.map((v) => `${v.id}:${v.aggFunc}`),
  });
}

/**
 * Deserialize pivot state from URL/storage
 */
export function deserializePivotState(
  serialized: string,
  columns: ColumnConfig<unknown>[],
): {
  rowGroups: Array<{ id: string; field: string; displayName: string }>;
  columnGroups: Array<{ id: string; field: string }>;
  values: Array<{ id: string; field: string; aggFunc: string }>;
} | null {
  try {
    const parsed = JSON.parse(serialized);

    const rowGroups = (parsed.rg || [])
      .map((id: string) => {
        const col = columns.find((c) => c.id === id);
        if (!col || !col.accessorKey) return null;
        return { id: col.id, field: col.accessorKey, displayName: col.header };
      })
      .filter(Boolean);

    const columnGroups = (parsed.cg || [])
      .map((id: string) => {
        const col = columns.find((c) => c.id === id);
        if (!col || !col.accessorKey) return null;
        return { id: col.id, field: col.accessorKey };
      })
      .filter(Boolean);

    const values = (parsed.v || [])
      .map((v: string) => {
        const [id, aggFunc] = v.split(":");
        const col = columns.find((c) => c.id === id);
        if (!col || !col.accessorKey) return null;
        return { id: col.id, field: col.accessorKey, aggFunc: aggFunc || "sum" };
      })
      .filter(Boolean);

    return { rowGroups, columnGroups, values };
  } catch {
    return null;
  }
}

/**
 * Collect leaf column configs from a possibly-nested column tree (group
 * headers carry `columns`). Returns the leaves in depth-first order.
 */
export function collectLeafColumns<TData>(columns: ColumnConfig<TData>[]): ColumnConfig<TData>[] {
  const leaves: ColumnConfig<TData>[] = [];
  for (const col of columns) {
    if (col.columns && col.columns.length > 0) {
      leaves.push(...collectLeafColumns(col.columns));
    } else {
      leaves.push(col);
    }
  }
  return leaves;
}

/**
 * Check if a row is a group row
 */
export function isGroupRow<TData>(row: TData | GroupedRow<TData>): row is GroupedRow<TData> {
  return typeof row === "object" && row !== null && "isGroup" in row && (row as { isGroup: boolean }).isGroup === true;
}

/**
 * Collect every group path key (`a::b`) reachable from a grouped row tree,
 * used to seed the expanded set for client-side OLAP hierarchies.
 */
export function collectGroupKeys<TData>(
  groupedData: Array<GroupedRow<TData> | TData>,
  parentPath: string[] = [],
): string[] {
  const keys: string[] = [];
  for (const item of groupedData) {
    if (isGroupRow(item)) {
      const currentPath = [...parentPath, item.groupKey];
      keys.push(currentPath.join("::"));
      if (item.children) {
        keys.push(...collectGroupKeys(item.children, currentPath));
      }
    }
  }
  return keys;
}

/**
 * Flatten grouped data for display
 */
export function flattenGroupedData<TData>(
  groupedData: Array<GroupedRow<TData> | TData>,
  expandedGroups: Set<string>,
  parentPath: string[] = [],
): Array<{ data: TData | GroupedRow<TData>; depth: number; path: string[] }> {
  const result: Array<{ data: TData | GroupedRow<TData>; depth: number; path: string[] }> = [];

  for (const item of groupedData) {
    const depth = parentPath.length;

    if (isGroupRow(item)) {
      const currentPath = [...parentPath, item.groupKey];
      const pathKey = currentPath.join("::");

      result.push({ data: item, depth, path: currentPath });

      if (expandedGroups.has(pathKey) && item.children) {
        const childResults = flattenGroupedData(
          item.children as Array<GroupedRow<TData> | TData>,
          expandedGroups,
          currentPath,
        );
        result.push(...childResults);
      }
    } else {
      result.push({ data: item, depth, path: parentPath });
    }
  }

  return result;
}
