import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { coerceEnumValue, normalizeSchemaType } from "./schema";
import type { DeepFormRenderer, DeepFormRendererProps, DeepFormRenderers } from "./types";
import { formatValue } from "./utils";

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

function ReadonlyValue({ value, className }: { value: unknown; className?: string }) {
  return (
    <span className={cn("block truncate text-sm tabular-nums", value === null && "text-muted-foreground", className)}>
      {formatValue(value)}
    </span>
  );
}

function toInputValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return String(value);
}

function commonInputProps({ id, invalid, describedBy, placeholder }: DeepFormRendererProps) {
  return {
    id,
    "aria-invalid": invalid || undefined,
    "aria-describedby": describedBy,
    placeholder,
  } as const;
}

/* -------------------------------------------------------------------------- */
/* Scalar renderers                                                           */
/* -------------------------------------------------------------------------- */

const TextRenderer: DeepFormRenderer = (props) => {
  const { value, readOnly, onChange } = props;
  if (readOnly) return <ReadonlyValue value={value} />;
  return (
    <Input
      type="text"
      value={toInputValue(value)}
      onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
      {...commonInputProps(props)}
    />
  );
};

const TextareaRenderer: DeepFormRenderer = (props) => {
  const { value, readOnly, onChange } = props;
  if (readOnly) return <ReadonlyValue value={value} className="whitespace-pre-wrap" />;
  return (
    <Textarea
      value={toInputValue(value)}
      rows={3}
      onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
      {...commonInputProps(props)}
    />
  );
};

const NumberRenderer: DeepFormRenderer = (props) => {
  const { value, readOnly, onChange, descriptor } = props;
  if (readOnly) return <ReadonlyValue value={value} className="text-right" />;
  const type = normalizeSchemaType(descriptor);
  const step = descriptor?.multipleOf ?? (type === "integer" ? 1 : "any");
  return (
    <Input
      type="number"
      className="text-right tabular-nums"
      value={toInputValue(value)}
      step={step}
      min={descriptor?.minimum}
      max={descriptor?.maximum}
      onChange={(event) => {
        const raw = event.target.value;
        if (raw === "") {
          onChange(null);
          return;
        }
        const parsed = Number(raw);
        onChange(Number.isNaN(parsed) ? raw : parsed);
      }}
      {...commonInputProps(props)}
    />
  );
};

const PercentageRenderer: DeepFormRenderer = (props) => {
  const { value, hint, descriptor, readOnly, onChange } = props;
  const scale = hint?.displayScale ?? descriptor?.["x-display-scale"] ?? 100;
  const numeric = typeof value === "number" ? value : Number(value);
  const display = Number.isFinite(numeric) ? String(numeric * scale) : "";
  if (readOnly) {
    return <ReadonlyValue value={Number.isFinite(numeric) ? `${numeric * scale}%` : value} className="text-right" />;
  }
  return (
    <div className="flex items-center gap-2">
      <Input
        type="number"
        className="text-right tabular-nums"
        value={display}
        step="any"
        onChange={(event) => {
          const raw = event.target.value;
          if (raw === "") {
            onChange(null);
            return;
          }
          const parsed = Number(raw);
          onChange(Number.isNaN(parsed) ? raw : parsed / scale);
        }}
        {...commonInputProps(props)}
      />
      <span className="text-muted-foreground text-xs">%</span>
    </div>
  );
};

const MoneyRenderer: DeepFormRenderer = (props) => {
  const { value, hint, descriptor, readOnly, onChange } = props;
  const unit = hint?.unit ?? descriptor?.["x-unit"];
  if (readOnly) {
    return <ReadonlyValue value={unit ? `${formatValue(value)} ${unit}` : value} className="text-right" />;
  }
  return (
    <div className="flex items-center gap-2">
      <Input
        type="number"
        className="text-right tabular-nums"
        value={toInputValue(value)}
        step="any"
        onChange={(event) => {
          const raw = event.target.value;
          if (raw === "") {
            onChange(null);
            return;
          }
          const parsed = Number(raw);
          onChange(Number.isNaN(parsed) ? raw : parsed);
        }}
        {...commonInputProps(props)}
      />
      {unit && <span className="text-muted-foreground text-xs">{unit}</span>}
    </div>
  );
};

const CurrencyCodeRenderer: DeepFormRenderer = (props) => {
  const { value, readOnly, onChange } = props;
  if (readOnly) return <ReadonlyValue value={value} />;
  return (
    <Input
      type="text"
      className="uppercase"
      maxLength={5}
      value={toInputValue(value)}
      onChange={(event) => onChange(event.target.value.toUpperCase())}
      {...commonInputProps(props)}
    />
  );
};

const DateRenderer: DeepFormRenderer = (props) => {
  const { value, readOnly, onChange } = props;
  const iso = typeof value === "string" ? value.slice(0, 10) : "";
  if (readOnly) return <ReadonlyValue value={value} />;
  return (
    <Input
      type="date"
      value={iso}
      onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
      {...commonInputProps(props)}
    />
  );
};

const SwitchRenderer: DeepFormRenderer = (props) => {
  const { id, value, readOnly, onChange, label, describedBy } = props;
  return (
    <div className="flex h-8 items-center">
      <Switch
        id={id}
        checked={value === true}
        disabled={readOnly}
        aria-label={label}
        aria-describedby={describedBy}
        onCheckedChange={(checked) => onChange(checked)}
      />
    </div>
  );
};

const SelectRenderer: DeepFormRenderer = (props) => {
  const { id, value, descriptor, hint, readOnly, invalid, describedBy, onChange } = props;
  const options =
    hint?.options ??
    descriptor?.["x-options"] ??
    (descriptor?.enum ?? []).map((option) => ({ label: String(option), value: String(option) }));
  if (readOnly) return <ReadonlyValue value={value} />;
  const current = value === null || value === undefined ? "" : String(value);
  return (
    <Select value={current} onValueChange={(next) => onChange(coerceEnumValue(next, descriptor))}>
      <SelectTrigger id={id} className="w-full" aria-invalid={invalid || undefined} aria-describedby={describedBy}>
        <SelectValue placeholder={props.placeholder ?? "Select…"} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

const ReadonlyRenderer: DeepFormRenderer = ({ value }) => <ReadonlyValue value={value} />;

const JsonRenderer: DeepFormRenderer = (props) => {
  const { value, readOnly, onChange } = props;
  if (readOnly) {
    return (
      <pre className="max-h-40 overflow-auto rounded border bg-muted/30 p-2 text-[11px]">{formatValue(value)}</pre>
    );
  }
  return (
    <Textarea
      className="font-mono text-xs"
      rows={4}
      value={toInputValue(value)}
      onChange={(event) => {
        const raw = event.target.value;
        try {
          onChange(raw === "" ? null : JSON.parse(raw));
        } catch {
          onChange(raw);
        }
      }}
      {...commonInputProps(props)}
    />
  );
};

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

export const builtInRenderers: DeepFormRenderers = {
  "text-input": TextRenderer,
  textarea: TextareaRenderer,
  "number-input": NumberRenderer,
  "percentage-input": PercentageRenderer,
  "money-input": MoneyRenderer,
  "currency-code": CurrencyCodeRenderer,
  "date-input": DateRenderer,
  switch: SwitchRenderer,
  select: SelectRenderer,
  readonly: ReadonlyRenderer,
  json: JsonRenderer,
};

/** Alias kept for readability at call sites. */
export const defaultRenderers = builtInRenderers;

export function resolveRenderer(renderers: DeepFormRenderers, name: string | undefined): DeepFormRenderer | undefined {
  if (!name) return undefined;
  return renderers[name] ?? builtInRenderers[name];
}
