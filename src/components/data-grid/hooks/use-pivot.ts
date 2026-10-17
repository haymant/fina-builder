"use client";

import { useCallback, useMemo, useState } from "react";

import type { AggregationFn, ColumnConfig, PivotCol, PivotState, RowGroupCol, ValueCol } from "../types";

const emptyPivotState: PivotState = {
  rowGroups: [],
  columnGroups: [],
  values: [],
  filters: [],
};

interface PivotApplyArgs {
  pivotState: PivotState;
  availableOrder: string[];
}

interface UsePivotOptions<TData> {
  columns: ColumnConfig<TData>[];
  initialState?: Partial<PivotState>;
  /**
   * Called when the user hits Apply. Provides both the final pivot state and
   * the current ordering of all columns (used by the grid to rearrange
   * visible columns).
   */
  onApply?: (args: PivotApplyArgs) => void;
}

export function usePivot<TData = unknown>(options: UsePivotOptions<TData>) {
  const { columns, initialState, onApply } = options;
  const initialAvailableOrder = useMemo(() => columns.map((column) => column.id), [columns]);

  const [pivotState, setPivotState] = useState<PivotState>({
    ...emptyPivotState,
    ...initialState,
  });

  const [draftState, setDraftState] = useState<PivotState>(pivotState);
  const [availableOrder, setAvailableOrder] = useState<string[]>(initialAvailableOrder);
  const [isDirty, setIsDirty] = useState(false);

  const getColumnById = useCallback(
    (columnId: string) => {
      return columns.find((column) => column.id === columnId);
    },
    [columns],
  );

  const reorderList = useCallback(<TItem extends { id: string }>(items: TItem[], fromId: string, toId: string) => {
    const fromIndex = items.findIndex((item) => item.id === fromId);
    const toIndex = items.findIndex((item) => item.id === toId);

    if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) {
      return items;
    }

    const next = [...items];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    return next;
  }, []);

  // Available fields that can be used in pivot
  const availableFields = useMemo(() => {
    const columnMap = new Map(columns.map((column) => [column.id, column]));
    const orderedIds = [
      ...availableOrder,
      ...columns.map((column) => column.id).filter((id) => !availableOrder.includes(id)),
    ];

    return orderedIds
      .map((id) => columnMap.get(id))
      .filter((column): column is ColumnConfig<TData> => Boolean(column))
      .filter((column) => {
        const isUsedAsRowGroup = draftState.rowGroups.some((rowGroup) => rowGroup.id === column.id);
        const isUsedAsColumnGroup = draftState.columnGroups.some((columnGroup) => columnGroup.id === column.id);
        const isUsedAsValue = draftState.values.some((value) => value.id === column.id);

        return !isUsedAsRowGroup && !isUsedAsColumnGroup && !isUsedAsValue;
      });
  }, [availableOrder, columns, draftState]);

  // Fields that can be grouped (non-numeric typically)
  const groupableFields = useMemo(() => {
    return columns.filter((col) => col.enableGrouping !== false);
  }, [columns]);

  // Fields that can be aggregated (numeric)
  const aggregatableFields = useMemo(() => {
    return columns.filter((col) => col.enableAggregation === true);
  }, [columns]);

  // Add to row groups
  const addRowGroup = useCallback(
    (columnId: string) => {
      if (draftState.rowGroups.some((rowGroup) => rowGroup.id === columnId)) return;

      const col = getColumnById(columnId);
      if (!col || !col.accessorKey) return;

      const rowGroupCol: RowGroupCol = {
        id: col.id,
        field: col.accessorKey,
        displayName: col.header,
      };

      setDraftState((prev) => ({
        ...prev,
        rowGroups: [...prev.rowGroups, rowGroupCol],
      }));
      setIsDirty(true);
    },
    [draftState.rowGroups, getColumnById],
  );

  // Remove from row groups
  const removeRowGroup = useCallback((columnId: string) => {
    setDraftState((prev) => ({
      ...prev,
      rowGroups: prev.rowGroups.filter((rg) => rg.id !== columnId),
    }));
    setIsDirty(true);
  }, []);

  // Reorder row groups
  const reorderRowGroups = useCallback((fromIndex: number, toIndex: number) => {
    setDraftState((prev) => {
      const newRowGroups = [...prev.rowGroups];
      const [removed] = newRowGroups.splice(fromIndex, 1);
      newRowGroups.splice(toIndex, 0, removed);
      return { ...prev, rowGroups: newRowGroups };
    });
    setIsDirty(true);
  }, []);

  // Add to column groups (pivot columns)
  const addColumnGroup = useCallback(
    (columnId: string) => {
      if (draftState.columnGroups.some((columnGroup) => columnGroup.id === columnId)) return;

      const col = getColumnById(columnId);
      if (!col || !col.accessorKey) return;

      const pivotCol: PivotCol = {
        id: col.id,
        field: col.accessorKey,
      };

      setDraftState((prev) => ({
        ...prev,
        columnGroups: [...prev.columnGroups, pivotCol],
      }));
      setIsDirty(true);
    },
    [draftState.columnGroups, getColumnById],
  );

  // Remove from column groups
  const removeColumnGroup = useCallback((columnId: string) => {
    setDraftState((prev) => ({
      ...prev,
      columnGroups: prev.columnGroups.filter((cg) => cg.id !== columnId),
    }));
    setIsDirty(true);
  }, []);

  // Add to values
  const addValue = useCallback(
    (columnId: string, aggFunc: AggregationFn = "sum") => {
      if (draftState.values.some((value) => value.id === columnId)) return;

      const col = getColumnById(columnId);
      if (!col || !col.accessorKey) return;

      const valueCol: ValueCol = {
        id: col.id,
        field: col.accessorKey,
        aggFunc,
      };

      setDraftState((prev) => ({
        ...prev,
        values: [...prev.values, valueCol],
      }));
      setIsDirty(true);
    },
    [draftState.values, getColumnById],
  );

  // Remove from values
  const removeValue = useCallback((columnId: string) => {
    setDraftState((prev) => ({
      ...prev,
      values: prev.values.filter((v) => v.id !== columnId),
    }));
    setIsDirty(true);
  }, []);

  // Update value aggregation function
  const updateValueAggFunc = useCallback((columnId: string, aggFunc: AggregationFn) => {
    setDraftState((prev) => ({
      ...prev,
      values: prev.values.map((v) => (v.id === columnId ? { ...v, aggFunc } : v)),
    }));
    setIsDirty(true);
  }, []);

  // Add filter
  const addFilter = useCallback(
    (columnId: string) => {
      if (draftState.filters.some((filter) => filter.id === columnId)) return;

      const col = getColumnById(columnId);
      if (!col || !col.accessorKey) return;

      setDraftState((prev) => ({
        ...prev,
        filters: [
          ...prev.filters,
          {
            id: col.id,
            field: col.accessorKey!,
            condition: {
              filterType: "text",
              operator: "contains",
              filter: "",
            },
          },
        ],
      }));
      setIsDirty(true);
    },
    [draftState.filters, getColumnById],
  );

  const reorderAvailable = useCallback(
    (fromId: string, toId: string) => {
      setAvailableOrder((prev) => {
        const order = prev.length > 0 ? prev : columns.map((column) => column.id);
        const fromIndex = order.indexOf(fromId);
        const toIndex = order.indexOf(toId);

        if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) {
          return order;
        }

        const next = [...order];
        const [moved] = next.splice(fromIndex, 1);
        next.splice(toIndex, 0, moved);
        return next;
      });
      setIsDirty(true);
    },
    [columns],
  );

  const reorderZone = useCallback(
    (zone: "rowGroups" | "columnGroups" | "values" | "filters", fromId: string, toId: string) => {
      setDraftState((prev) => {
        switch (zone) {
          case "rowGroups":
            return { ...prev, rowGroups: reorderList(prev.rowGroups, fromId, toId) };
          case "columnGroups":
            return { ...prev, columnGroups: reorderList(prev.columnGroups, fromId, toId) };
          case "values":
            return { ...prev, values: reorderList(prev.values, fromId, toId) };
          case "filters":
            return { ...prev, filters: reorderList(prev.filters, fromId, toId) };
        }
      });
      setIsDirty(true);
    },
    [reorderList],
  );

  // Remove filter
  const removeFilter = useCallback((columnId: string) => {
    setDraftState((prev) => ({
      ...prev,
      filters: prev.filters.filter((f) => f.id !== columnId),
    }));
    setIsDirty(true);
  }, []);

  // Move field between zones
  const moveField = useCallback(
    (
      columnId: string,
      fromZone: "available" | "rowGroups" | "columnGroups" | "values" | "filters",
      toZone: "available" | "rowGroups" | "columnGroups" | "values" | "filters",
    ) => {
      if (fromZone === toZone) return;

      if (toZone === "available") {
        switch (fromZone) {
          case "rowGroups":
            removeRowGroup(columnId);
            break;
          case "columnGroups":
            removeColumnGroup(columnId);
            break;
          case "values":
            removeValue(columnId);
            break;
          case "filters":
            removeFilter(columnId);
            break;
        }
        return;
      }

      if (toZone === "filters") {
        addFilter(columnId);
        return;
      }

      if (fromZone !== "available" && fromZone !== "filters") {
        switch (fromZone) {
          case "rowGroups":
            removeRowGroup(columnId);
            break;
          case "columnGroups":
            removeColumnGroup(columnId);
            break;
          case "values":
            removeValue(columnId);
            break;
        }
      }

      switch (toZone) {
        case "rowGroups":
          addRowGroup(columnId);
          break;
        case "columnGroups":
          addColumnGroup(columnId);
          break;
        case "values":
          addValue(columnId);
          break;
      }
    },
    [addRowGroup, removeRowGroup, addColumnGroup, removeColumnGroup, addValue, removeValue, addFilter, removeFilter],
  );

  // Apply changes
  const apply = useCallback(() => {
    setPivotState(draftState);
    setIsDirty(false);
    onApply?.({ pivotState: draftState, availableOrder });
  }, [draftState, availableOrder, onApply]);

  // Reset draft state to an empty configuration so apply can re-run SSRM.
  const reset = useCallback(() => {
    setDraftState(emptyPivotState);
    setIsDirty(true);
  }, []);

  // Clear all
  const clear = useCallback(() => {
    setDraftState(emptyPivotState);
    setIsDirty(true);
  }, []);

  return {
    // State
    pivotState,
    draftState,
    isDirty,

    // Derived
    availableFields,
    groupableFields,
    aggregatableFields,

    // Row group actions
    addRowGroup,
    removeRowGroup,
    reorderRowGroups,

    // Column group actions
    addColumnGroup,
    removeColumnGroup,

    // Value actions
    addValue,
    removeValue,
    updateValueAggFunc,

    // Filter actions
    addFilter,
    removeFilter,

    // General actions
    moveField,
    reorderAvailable,
    reorderZone,
    apply,
    reset,
    clear,
  };
}
