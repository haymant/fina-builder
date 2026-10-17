"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { GroupedRow, SSRMRequest, SSRMResponse } from "../types";

interface UseSSRMOptions {
  endpoint: string;
  tableName?: string;
  debounceMs?: number;
  enabled?: boolean;
}

interface UseSSRMReturn<TData> {
  data: TData[];
  groupedData?: GroupedRow<TData>[];
  totalRows: number;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  fetchPage: (request: Omit<SSRMRequest, "tableName">) => Promise<void>;
}

export function useSSRM<TData = unknown>(options: UseSSRMOptions): UseSSRMReturn<TData> {
  const { endpoint, tableName, debounceMs = 300, enabled = true } = options;

  const [data, setData] = useState<TData[]>([]);
  const [groupedData, setGroupedData] = useState<GroupedRow<TData>[]>();
  const [totalRows, setTotalRows] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const lastRequestRef = useRef<SSRMRequest | null>(null);
  const debounceRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const abortControllerRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(
    async (request: SSRMRequest) => {
      if (!enabled) return;

      // Cancel previous request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      abortControllerRef.current = new AbortController();

      setIsLoading(true);
      setError(null);

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
          signal: abortControllerRef.current.signal,
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || `Request failed: ${response.statusText}`);
        }

        const result: SSRMResponse<TData> = await response.json();

        setData(result.rowData);
        setTotalRows(result.rowCount);
        setGroupedData(result.groupedData);
        lastRequestRef.current = request;
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          // Request was cancelled, don't update state
          return;
        }
        setError(err instanceof Error ? err : new Error("Unknown error occurred"));
      } finally {
        setIsLoading(false);
      }
    },
    [endpoint, enabled],
  );

  const fetchPage = useCallback(
    async (request: Omit<SSRMRequest, "tableName">) => {
      const fullRequest: SSRMRequest = {
        ...request,
        tableName,
      };

      // Clear any pending debounced request
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      // Debounce the request
      return new Promise<void>((resolve) => {
        debounceRef.current = setTimeout(async () => {
          await fetchData(fullRequest);
          resolve();
        }, debounceMs);
      });
    },
    [fetchData, tableName, debounceMs],
  );

  const refetch = useCallback(async () => {
    if (lastRequestRef.current) {
      await fetchData(lastRequestRef.current);
    }
  }, [fetchData]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  return {
    data,
    groupedData,
    totalRows,
    isLoading,
    error,
    refetch,
    fetchPage,
  };
}

// Hook to expand/collapse groups and fetch children
interface UseGroupExpansionOptions {
  endpoint: string;
  tableName?: string;
}

export function useGroupExpansion<TData>(options: UseGroupExpansionOptions) {
  const { endpoint, tableName } = options;

  const [expandedGroups, setExpandedGroups] = useState<Map<string, TData[] | GroupedRow<TData>[]>>(new Map());
  const [loadingGroups, setLoadingGroups] = useState<Set<string>>(new Set());

  const toggleGroup = useCallback(
    async (groupKey: string, parentKeys: string[], rowGroupCols: SSRMRequest["rowGroupCols"]) => {
      const fullKey = [...parentKeys, groupKey].join("::");

      if (expandedGroups.has(fullKey)) {
        // Collapse: just remove from expanded
        setExpandedGroups((prev) => {
          const next = new Map(prev);
          next.delete(fullKey);
          return next;
        });
        return;
      }

      // Expand: fetch children
      setLoadingGroups((prev) => new Set(prev).add(fullKey));

      try {
        const request: SSRMRequest = {
          startRow: 0,
          endRow: 1000, // Load all children for now
          sortModel: [],
          filterModel: {},
          rowGroupCols,
          groupKeys: [...parentKeys, groupKey],
          tableName,
          pivotMode: false,
          pivotCols: [],
          valueCols: [],
        };

        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        });

        if (!response.ok) {
          throw new Error("Failed to load group children");
        }

        const result: SSRMResponse<TData> = await response.json();

        setExpandedGroups((prev) => {
          const next = new Map(prev);
          next.set(fullKey, result.groupedData ?? result.rowData);
          return next;
        });
      } catch (err) {
        console.error("Failed to expand group:", err);
      } finally {
        setLoadingGroups((prev) => {
          const next = new Set(prev);
          next.delete(fullKey);
          return next;
        });
      }
    },
    [expandedGroups, endpoint, tableName],
  );

  const isExpanded = useCallback(
    (groupKey: string, parentKeys: string[]) => {
      const fullKey = [...parentKeys, groupKey].join("::");
      return expandedGroups.has(fullKey);
    },
    [expandedGroups],
  );

  const isLoading = useCallback(
    (groupKey: string, parentKeys: string[]) => {
      const fullKey = [...parentKeys, groupKey].join("::");
      return loadingGroups.has(fullKey);
    },
    [loadingGroups],
  );

  const getChildren = useCallback(
    (groupKey: string, parentKeys: string[]) => {
      const fullKey = [...parentKeys, groupKey].join("::");
      return expandedGroups.get(fullKey);
    },
    [expandedGroups],
  );

  const collapseAll = useCallback(() => {
    setExpandedGroups(new Map());
  }, []);

  return {
    toggleGroup,
    isExpanded,
    isLoading,
    getChildren,
    collapseAll,
  };
}
