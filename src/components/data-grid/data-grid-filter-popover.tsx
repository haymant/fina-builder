"use client";

import { useEffect, useState } from "react";

import { format } from "date-fns";
import { Calendar as CalendarIcon, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

import type { ColumnConfig } from "./types";

interface DataGridFilterPopoverProps<TData> {
  column: ColumnConfig<TData>;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onApply?: (value: unknown) => void;
  onClear?: () => void;
  currentValue?: unknown;
  children: React.ReactNode;
}

export function DataGridFilterPopover<TData>({
  column,
  isOpen,
  onOpenChange,
  onApply,
  onClear,
  currentValue,
  children,
}: DataGridFilterPopoverProps<TData>) {
  const filterConfig = column.filterConfig;
  const filterType = filterConfig?.type || "text";

  // Local state for filter value
  const [localValue, setLocalValue] = useState<unknown>(currentValue);

  // Sync local value when currentValue changes
  useEffect(() => {
    setLocalValue(currentValue);
  }, [currentValue]);

  const handleApply = () => {
    onApply?.(localValue);
    onOpenChange(false);
  };

  const handleClear = () => {
    setLocalValue(undefined);
    onClear?.();
    onOpenChange(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleApply();
    }
  };

  return (
    <Popover open={isOpen} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-72 p-4" align="start" sideOffset={4} onKeyDown={handleKeyDown}>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <Label className="font-medium text-sm">Filter: {column.header}</Label>
            {currentValue !== undefined && (
              <Button variant="ghost" size="icon" className="size-6" onClick={handleClear}>
                <X className="size-3.5" />
                <span className="sr-only">Clear filter</span>
              </Button>
            )}
          </div>

          {/* Filter input based on type */}
          <FilterInput
            type={filterType}
            options={filterConfig?.options}
            placeholder={filterConfig?.placeholder}
            value={localValue}
            onChange={setLocalValue}
          />

          <div className="flex items-center gap-2 pt-2">
            <Button variant="outline" size="sm" className="flex-1" onClick={handleClear}>
              Clear
            </Button>
            <Button size="sm" className="flex-1" onClick={handleApply}>
              Apply
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Filter input component based on filter type
interface FilterInputProps {
  type: string;
  options?: Array<{ label: string; value: string }>;
  placeholder?: string;
  value: unknown;
  onChange: (value: unknown) => void;
}

function FilterInput({ type, options, placeholder, value, onChange }: FilterInputProps) {
  switch (type) {
    case "text":
      return (
        <Input
          placeholder={placeholder ?? "Enter text..."}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
          autoFocus
        />
      );

    case "number":
      return (
        <div className="space-y-2">
          <Input
            type="number"
            placeholder={placeholder ?? "Enter number..."}
            value={(value as number) ?? ""}
            onChange={(e) => onChange(e.target.value ? parseFloat(e.target.value) : undefined)}
            autoFocus
          />
        </div>
      );

    case "select":
      return (
        <Select value={(value as string) || ""} onValueChange={onChange}>
          <SelectTrigger>
            <SelectValue placeholder={placeholder ?? "Select..."} />
          </SelectTrigger>
          <SelectContent>
            {options?.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );

    case "multiselect":
      return <MultiSelectFilter options={options ?? []} value={(value as string[]) || []} onChange={onChange} />;

    case "date":
      return <DateFilter value={value as string | undefined} onChange={onChange} />;

    case "daterange":
      return <DateRangeFilter value={value as { from?: Date; to?: Date } | undefined} onChange={onChange} />;

    case "boolean":
      return (
        <Select
          value={value === undefined ? "" : String(value)}
          onValueChange={(v) => onChange(v === "" ? undefined : v === "true")}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select..." />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="true">Yes</SelectItem>
            <SelectItem value="false">No</SelectItem>
          </SelectContent>
        </Select>
      );

    default:
      return (
        <Input
          placeholder={placeholder ?? "Enter value..."}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
          autoFocus
        />
      );
  }
}

// Multi-select filter with checkboxes
interface MultiSelectFilterProps {
  options: Array<{ label: string; value: string }>;
  value: string[];
  onChange: (value: string[]) => void;
}

function MultiSelectFilter({ options, value, onChange }: MultiSelectFilterProps) {
  const toggleOption = (optionValue: string) => {
    if (value.includes(optionValue)) {
      onChange(value.filter((v) => v !== optionValue));
    } else {
      onChange([...value, optionValue]);
    }
  };

  return (
    <div className="max-h-48 space-y-2 overflow-y-auto">
      {options.map((opt) => (
        <label
          key={opt.value}
          htmlFor={`filter-${opt.value}`}
          className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 hover:bg-muted"
        >
          <Checkbox
            id={`filter-${opt.value}`}
            checked={value.includes(opt.value)}
            onCheckedChange={() => toggleOption(opt.value)}
          />
          <span className="text-sm">{opt.label}</span>
        </label>
      ))}
    </div>
  );
}

// Single date filter
interface DateFilterProps {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
}

function DateFilter({ value, onChange }: DateFilterProps) {
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const date = value ? new Date(value) : undefined;

  return (
    <Popover open={isCalendarOpen} onOpenChange={setIsCalendarOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn("w-full justify-start text-left font-normal", !date && "text-muted-foreground")}
        >
          <CalendarIcon className="mr-2 size-4" />
          {date ? format(date, "PPP") : "Select date"}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={date}
          onSelect={(d) => {
            onChange(d?.toISOString().split("T")[0]);
            setIsCalendarOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

// Date range filter
interface DateRangeFilterProps {
  value: { from?: Date; to?: Date } | undefined;
  onChange: (value: { from?: Date; to?: Date } | undefined) => void;
}

function DateRangeFilter({ value, onChange }: DateRangeFilterProps) {
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);

  const label = () => {
    if (!value?.from) return "Select date range";
    if (value.to) return `${format(value.from, "MMM d")} - ${format(value.to, "MMM d")}`;
    return format(value.from, "PPP");
  };

  return (
    <Popover open={isCalendarOpen} onOpenChange={setIsCalendarOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn("w-full justify-start text-left font-normal", !value?.from && "text-muted-foreground")}
        >
          <CalendarIcon className="mr-2 size-4" />
          {label()}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="range"
          selected={{ from: value?.from, to: value?.to }}
          onSelect={(range) => {
            onChange({ from: range?.from, to: range?.to });
          }}
          numberOfMonths={2}
        />
        <div className="border-t p-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full"
            onClick={() => {
              onChange(undefined);
              setIsCalendarOpen(false);
            }}
          >
            Clear
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
