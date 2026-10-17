"use client";

import { useState } from "react";

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { ChevronDown, GripVertical, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

import { usePivot } from "./hooks/use-pivot";
import type { AggregationFn, ColumnConfig } from "./types";

interface DataGridPivotPanelProps<TData> {
  columns: ColumnConfig<TData>[];
  onApply: (args: { pivotState: ReturnType<typeof usePivot>["pivotState"]; availableOrder: string[] }) => void;
  onClose: () => void;
}

export function DataGridPivotPanel<TData>({ columns, onApply, onClose }: DataGridPivotPanelProps<TData>) {
  const pivot = usePivot({
    columns,
    onApply,
  });

  const [activeId, setActiveId] = useState<string | null>(null);
  const [, setActiveZone] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragStart = (event: DragStartEvent) => {
    const data = event.active.data.current;
    setActiveId(data?.columnId || null);
    setActiveZone(data?.zone || "available");
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (!over) {
      setActiveId(null);
      setActiveZone(null);
      return;
    }

    const activeData = active.data.current;
    const overData = over.data.current;

    const sourceZone = activeData?.zone || "available";
    const targetZone = overData?.zone || over.id;
    const columnId = activeData?.columnId as string | undefined;
    const targetColumnId = overData?.columnId as string | undefined;

    if (!columnId || typeof targetZone !== "string") {
      setActiveId(null);
      setActiveZone(null);
      return;
    }

    if (sourceZone === targetZone && targetColumnId && columnId !== targetColumnId) {
      if (targetZone === "available") {
        pivot.reorderAvailable(columnId, targetColumnId);
      } else {
        pivot.reorderZone(targetZone as "rowGroups" | "columnGroups" | "values" | "filters", columnId, targetColumnId);
      }

      setActiveId(null);
      setActiveZone(null);
      return;
    }

    if (sourceZone !== targetZone) {
      pivot.moveField(
        columnId,
        sourceZone as "available" | "rowGroups" | "columnGroups" | "values" | "filters",
        targetZone as "available" | "rowGroups" | "columnGroups" | "values" | "filters",
      );
    }

    setActiveId(null);
    setActiveZone(null);
  };

  const activeColumn = activeId ? columns.find((c) => c.id === activeId) : null;

  return (
    <div className="flex h-full flex-col border-l bg-background">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h3 className="font-semibold text-sm">Pivot Configuration</h3>
        <Button variant="ghost" size="icon" className="size-7" onClick={onClose}>
          <X className="size-4" />
          <span className="sr-only">Close</span>
        </Button>
      </div>

      {/* Content */}
      <ScrollArea className="flex-1">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div className="space-y-4 p-4">
            {/* Available Fields */}
            <PivotSection title="Available Fields" zone="available" defaultOpen>
              <DroppableZone zone="available">
                <SortableContext
                  items={pivot.availableFields.map((col) => `available:${col.id}`)}
                  strategy={verticalListSortingStrategy}
                >
                  {pivot.availableFields.map((col) => (
                    <SortableField
                      key={col.id}
                      id={`available:${col.id}`}
                      columnId={col.id}
                      label={col.header}
                      zone="available"
                    />
                  ))}
                </SortableContext>
                {pivot.availableFields.length === 0 && (
                  <p className="py-2 text-muted-foreground text-xs">All fields are in use</p>
                )}
              </DroppableZone>
            </PivotSection>

            {/* Row Groups */}
            <PivotSection title="Row Groups" zone="rowGroups" count={pivot.draftState.rowGroups.length} defaultOpen>
              <DroppableZone zone="rowGroups" isEmpty={pivot.draftState.rowGroups.length === 0}>
                <SortableContext
                  items={pivot.draftState.rowGroups.map((rg) => `rowGroups:${rg.id}`)}
                  strategy={verticalListSortingStrategy}
                >
                  {pivot.draftState.rowGroups.map((rg) => (
                    <SortableField
                      key={rg.id}
                      id={`rowGroups:${rg.id}`}
                      columnId={rg.id}
                      label={rg.displayName}
                      zone="rowGroups"
                      onRemove={() => pivot.removeRowGroup(rg.id)}
                    />
                  ))}
                </SortableContext>
              </DroppableZone>
            </PivotSection>

            {/* Column Groups (Pivot) */}
            <PivotSection title="Column Groups" zone="columnGroups" count={pivot.draftState.columnGroups.length}>
              <DroppableZone zone="columnGroups" isEmpty={pivot.draftState.columnGroups.length === 0}>
                <SortableContext
                  items={pivot.draftState.columnGroups.map((cg) => `columnGroups:${cg.id}`)}
                  strategy={verticalListSortingStrategy}
                >
                  {pivot.draftState.columnGroups.map((cg) => {
                    const col = columns.find((c) => c.id === cg.id);
                    return (
                      <SortableField
                        key={cg.id}
                        id={`columnGroups:${cg.id}`}
                        columnId={cg.id}
                        label={col?.header || cg.id}
                        zone="columnGroups"
                        onRemove={() => pivot.removeColumnGroup(cg.id)}
                      />
                    );
                  })}
                </SortableContext>
              </DroppableZone>
            </PivotSection>

            {/* Values */}
            <PivotSection title="Values" zone="values" count={pivot.draftState.values.length} defaultOpen>
              <DroppableZone zone="values" isEmpty={pivot.draftState.values.length === 0}>
                <SortableContext
                  items={pivot.draftState.values.map((value) => `values:${value.id}`)}
                  strategy={verticalListSortingStrategy}
                >
                  {pivot.draftState.values.map((v) => {
                    const col = columns.find((c) => c.id === v.id);
                    return (
                      <ValueField
                        key={v.id}
                        id={`values:${v.id}`}
                        columnId={v.id}
                        label={col?.header || v.id}
                        aggFunc={v.aggFunc}
                        onAggFuncChange={(fn) => pivot.updateValueAggFunc(v.id, fn)}
                        onRemove={() => pivot.removeValue(v.id)}
                      />
                    );
                  })}
                </SortableContext>
              </DroppableZone>
            </PivotSection>

            {/* Filters */}
            <PivotSection title="Filters" zone="filters" count={pivot.draftState.filters.length}>
              <DroppableZone zone="filters" isEmpty={pivot.draftState.filters.length === 0}>
                <SortableContext
                  items={pivot.draftState.filters.map((filter) => `filters:${filter.id}`)}
                  strategy={verticalListSortingStrategy}
                >
                  {pivot.draftState.filters.map((f) => {
                    const col = columns.find((c) => c.id === f.id);
                    return (
                      <SortableField
                        key={f.id}
                        id={`filters:${f.id}`}
                        columnId={f.id}
                        label={col?.header || f.id}
                        zone="filters"
                        onRemove={() => pivot.removeFilter(f.id)}
                      />
                    );
                  })}
                </SortableContext>
              </DroppableZone>
            </PivotSection>
          </div>

          {/* Drag overlay */}
          <DragOverlay>
            {activeColumn && (
              <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm shadow-lg">
                <GripVertical className="size-3.5 text-muted-foreground" />
                {activeColumn.header}
              </div>
            )}
          </DragOverlay>
        </DndContext>
      </ScrollArea>

      {/* Footer */}
      <div className="flex items-center gap-2 border-t p-4">
        <Button variant="outline" size="sm" className="flex-1" onClick={pivot.reset}>
          Reset
        </Button>
        <Button size="sm" className="flex-1" onClick={pivot.apply} disabled={!pivot.isDirty}>
          Apply
        </Button>
      </div>
    </div>
  );
}

// Collapsible section
interface PivotSectionProps {
  title: string;
  zone: string;
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

function PivotSection({ title, count, defaultOpen = false, children }: PivotSectionProps) {
  return (
    <Collapsible defaultOpen={defaultOpen}>
      <CollapsibleTrigger className="flex w-full items-center justify-between py-2 font-medium text-sm hover:text-foreground/80">
        <span className="flex items-center gap-2">
          {title}
          {count !== undefined && count > 0 && <span className="text-muted-foreground text-xs">({count})</span>}
        </span>
        <ChevronDown className="size-4 transition-transform duration-200 [[data-state=open]>&]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}

// Droppable zone
interface DroppableZoneProps {
  zone: string;
  isEmpty?: boolean;
  children: React.ReactNode;
}

function DroppableZone({ zone, isEmpty, children }: DroppableZoneProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: zone,
    data: { zone },
  });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "min-h-[60px] space-y-1 rounded-md border border-dashed p-2 transition-colors",
        isOver && "border-primary bg-primary/5",
        isEmpty && "flex items-center justify-center",
      )}
    >
      {isEmpty ? <p className="text-muted-foreground text-xs">Drop fields here</p> : children}
    </div>
  );
}

function dragStyle(transform: { x: number; y: number; scaleX: number; scaleY: number } | null, transition?: string) {
  return {
    transform: transform
      ? `translate3d(${transform.x}px, ${transform.y}px, 0) scaleX(${transform.scaleX}) scaleY(${transform.scaleY})`
      : undefined,
    transition,
  };
}

// Sortable field
interface SortableFieldProps {
  id: string;
  columnId: string;
  label: string;
  zone: string;
  onRemove?: () => void;
}

function SortableField({ id, columnId, label, zone, onRemove }: SortableFieldProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    data: { zone, columnId },
  });

  const style = dragStyle(transform, transition);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "group flex items-center gap-2 rounded-md bg-muted/50 px-2 py-1.5 text-sm",
        isDragging && "opacity-50",
      )}
    >
      <button className="cursor-grab touch-none active:cursor-grabbing" {...listeners} {...attributes}>
        <GripVertical className="size-3.5 text-muted-foreground" />
      </button>
      <span className="flex-1 truncate">{label}</span>
      {onRemove && (
        <Button variant="ghost" size="icon" className="size-5 opacity-0 group-hover:opacity-100" onClick={onRemove}>
          <X className="size-3" />
          <span className="sr-only">Remove</span>
        </Button>
      )}
    </div>
  );
}

// Value field with aggregation selector
interface ValueFieldProps {
  id: string;
  columnId: string;
  label: string;
  aggFunc: AggregationFn;
  onAggFuncChange: (fn: AggregationFn) => void;
  onRemove: () => void;
}

function ValueField({ id, columnId, label, aggFunc, onAggFuncChange, onRemove }: ValueFieldProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    data: { zone: "values", columnId },
  });

  const style = dragStyle(transform, transition);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "group flex items-center gap-2 rounded-md bg-muted/50 px-2 py-1.5 text-sm",
        isDragging && "opacity-50",
      )}
    >
      <button className="cursor-grab touch-none active:cursor-grabbing" {...listeners} {...attributes}>
        <GripVertical className="size-3.5 text-muted-foreground" />
      </button>
      <span className="flex-1 truncate">{label}</span>
      <Select value={aggFunc} onValueChange={(v) => onAggFuncChange(v as AggregationFn)}>
        <SelectTrigger className="h-6 w-[70px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="sum">Sum</SelectItem>
          <SelectItem value="avg">Avg</SelectItem>
          <SelectItem value="count">Count</SelectItem>
          <SelectItem value="min">Min</SelectItem>
          <SelectItem value="max">Max</SelectItem>
        </SelectContent>
      </Select>
      <Button variant="ghost" size="icon" className="size-5 opacity-0 group-hover:opacity-100" onClick={onRemove}>
        <X className="size-3" />
        <span className="sr-only">Remove</span>
      </Button>
    </div>
  );
}
