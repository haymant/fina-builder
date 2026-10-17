"use client";

import { useState } from "react";

import { format } from "date-fns";
import { Calendar, Columns3, PanelRight, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Calendar as CalendarComponent } from "@/components/ui/calendar";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { useDataGridContext } from "./hooks/use-data-grid";
import type { ColumnConfig, ToolbarConfig, ToolbarFilterConfig } from "./types";

interface DataGridToolbarProps<TData> {
  columns: ColumnConfig<TData>[];
  toolbar?: ToolbarConfig;
}

export function DataGridToolbar<TData>({ columns, toolbar }: DataGridToolbarProps<TData>) {
  const { state, actions } = useDataGridContext<TData>();
  const [localSearch, setLocalSearch] = useState(state.globalFilter);

  const showSearch = toolbar?.showSearch !== false;
  const showColumnToggle = toolbar?.showColumnToggle !== false;
  const showPivotToggle = toolbar?.showPivotToggle === true;
  const filters = toolbar?.filters ?? [];

  // Debounced search handler
  const handleSearchChange = (value: string) => {
    setLocalSearch(value);
    // Debounce is handled by the context
    actions.setGlobalFilter(value);
  };

  // Get filter value from column filters
  const getFilterValue = (filterId: string): unknown => {
    const filter = state.columnFilters.find((f) => f.id === filterId);
    return filter?.value;
  };

  // Set filter value
  const setFilterValue = (filterId: string, value: unknown) => {
    const current = state.columnFilters.filter((f) => f.id !== filterId);
    if (value !== undefined && value !== "" && value !== "all") {
      current.push({ id: filterId, value });
    }
    actions.setColumnFilters(current);
  };

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex flex-1 flex-col gap-4 lg:flex-row lg:items-center">
        {toolbar?.titleBadge && <div className="shrink-0">{toolbar.titleBadge}</div>}

        {/* Global search */}
        {showSearch && (
          <div className="relative max-w-sm flex-1">
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search..."
              value={localSearch}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="pr-9 pl-9"
            />
            {localSearch && (
              <Button
                variant="ghost"
                size="icon"
                className="absolute top-1/2 right-1 size-6 -translate-y-1/2"
                onClick={() => handleSearchChange("")}
              >
                <X className="size-3.5" />
                <span className="sr-only">Clear search</span>
              </Button>
            )}
          </div>
        )}

        {/* Custom filters */}
        {filters.map((filter) => (
          <ToolbarFilter
            key={filter.id}
            filter={filter}
            value={getFilterValue(filter.id)}
            onChange={(value) => setFilterValue(filter.id, value)}
          />
        ))}
      </div>

      <div className="flex items-center gap-2">
        {/* Custom actions slot */}
        {toolbar?.customActions}

        {/* Column visibility toggle */}
        {showColumnToggle && (
          <ColumnVisibilityDropdown
            columns={columns}
            visibility={state.columnVisibility}
            onVisibilityChange={actions.setColumnVisibility}
          />
        )}

        {/* Pivot panel toggle */}
        {showPivotToggle && (
          <Button
            variant={state.pivotPanelOpen ? "secondary" : "outline"}
            size="icon"
            onClick={actions.togglePivotPanel}
            aria-label="Toggle pivot panel"
          >
            <PanelRight className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}

// Toolbar filter component
interface ToolbarFilterProps {
  filter: ToolbarFilterConfig;
  value: unknown;
  onChange: (value: unknown) => void;
}

function ToolbarFilter({ filter, value, onChange }: ToolbarFilterProps) {
  switch (filter.type) {
    case "select":
      return (
        <Select value={(value as string) || "all"} onValueChange={(v) => onChange(v === "all" ? undefined : v)}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder={filter.label} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All {filter.label}s</SelectItem>
            {filter.options?.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );

    case "multiselect":
      return <MultiSelectToolbarFilter filter={filter} value={(value as string[]) || []} onChange={onChange} />;

    case "daterange":
      return (
        <DateRangeToolbarFilter
          filter={filter}
          value={value as { from?: Date; to?: Date } | undefined}
          onChange={onChange}
        />
      );

    default:
      return null;
  }
}

// Multi-select toolbar filter
interface MultiSelectToolbarFilterProps {
  filter: ToolbarFilterConfig;
  value: string[];
  onChange: (value: unknown) => void;
}

function MultiSelectToolbarFilter({ filter, value, onChange }: MultiSelectToolbarFilterProps) {
  const selectedCount = value.length;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="w-[180px] justify-start">
          {selectedCount > 0 ? `${selectedCount} selected` : filter.label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-[200px]">
        <DropdownMenuLabel>{filter.label}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {filter.options?.map((opt) => (
          <DropdownMenuCheckboxItem
            key={opt.value}
            checked={value.includes(opt.value)}
            onCheckedChange={(checked) => {
              if (checked) {
                onChange([...value, opt.value]);
              } else {
                onChange(value.filter((v) => v !== opt.value));
              }
            }}
          >
            {opt.label}
          </DropdownMenuCheckboxItem>
        ))}
        {selectedCount > 0 && (
          <>
            <DropdownMenuSeparator />
            <Button variant="ghost" size="sm" className="w-full" onClick={() => onChange([])}>
              Clear all
            </Button>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Date range toolbar filter
interface DateRangeToolbarFilterProps {
  filter: ToolbarFilterConfig;
  value: { from?: Date; to?: Date } | undefined;
  onChange: (value: unknown) => void;
}

function DateRangeToolbarFilter({ filter, value, onChange }: DateRangeToolbarFilterProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" className="w-[200px] justify-start text-left font-normal">
          <Calendar className="mr-2 size-4" />
          {value?.from
            ? value.to
              ? `${format(value.from, "MMM d")} - ${format(value.to, "MMM d")}`
              : format(value.from, "MMM d, yyyy")
            : filter.label}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <CalendarComponent
          mode="range"
          selected={{ from: value?.from, to: value?.to }}
          onSelect={(range) => onChange({ from: range?.from, to: range?.to })}
          numberOfMonths={2}
        />
        {(value?.from ?? value?.to) && (
          <div className="border-t p-2">
            <Button variant="ghost" size="sm" className="w-full" onClick={() => onChange(undefined)}>
              Clear
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

// Column visibility dropdown
interface ColumnVisibilityDropdownProps<TData> {
  columns: ColumnConfig<TData>[];
  visibility: Record<string, boolean>;
  onVisibilityChange: (visibility: Record<string, boolean>) => void;
}

function ColumnVisibilityDropdown<TData>({
  columns,
  visibility,
  onVisibilityChange,
}: ColumnVisibilityDropdownProps<TData>) {
  const hidableColumns = columns.filter((col) => col.enableHiding !== false);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label="Toggle columns">
          <Columns3 className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[200px]">
        <DropdownMenuLabel>Toggle columns</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {hidableColumns.map((column) => {
          const isVisible = visibility[column.id] !== false;

          return (
            <DropdownMenuCheckboxItem
              key={column.id}
              checked={isVisible}
              onCheckedChange={(checked) => {
                onVisibilityChange({
                  ...visibility,
                  [column.id]: checked,
                });
              }}
            >
              {column.header}
            </DropdownMenuCheckboxItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
