# deep-form

A self-contained React component that turns **deeply nested JSON** into an
editable form. It renders objects as collapsible cards, flat fields as a
`Field / Value` table, arrays as repeatable sections, and reports every edit
through a single `onChange(nextValue, event)` callback that carries the changed
JSON pointer.

The folder is designed to be **copied into another project as a unit**
(`src/components/deep-form/`). It ships its own tests and Vitest config.

## Features

1. **Deep nested JSON input** — pass any JSON document as `value`.
2. **Collapsible cards** — every nested object renders as an expand/collapse
   card; arrays render as collapsible repeatable sections.
3. **Tabular fields** — the scalar fields of an object render as a two-column
   table (label + editor).
4. **Rich change events** — `onChange` receives the next document plus a
   `DeepFormChangeEvent` with the JSON pointer, previous/new value and mutation
   type (`update | add | remove | move`).
5. **JSON Schema aware** — an optional JSON Schema determines each field's type
   and default renderer (enum → select, `format: date` → date picker,
   `type: boolean` → switch, …).
6. **Layout schema** — an optional layout document controls ordering, grouping,
   static text/dividers, per-field renderer overrides and `visible_when`
   conditions.
7. **Renderer registry** — renderers are looked up by name, so hosts can add or
   replace editors without touching the component.

## Why a single folder

Everything the component needs lives here:

```
deep-form/
  index.ts            # public API (component, hooks, renderers, types, utils)
  deep-form.tsx       # <DeepForm> entry point
  context.tsx         # <DeepFormProvider> + useDeepForm()
  node.tsx            # auto mode: object cards, array sections
  layout-view.tsx     # layout mode: groups, text, dividers, fields
  field-row.tsx       # one editable field row
  fields-table.tsx    # object → Field/Value table
  renderers.tsx       # built-in renderer registry
  schema.ts           # JSON Schema resolution + renderer inference
  utils.ts            # JSON pointer + immutable value helpers
  types.ts            # types and zod schemas
  hooks/              # useDeepFormState (document + expansion state)
  tests/              # vitest + jsdom tests
  vitest.config.ts    # standalone test config
```

## Porting to another project

The component imports a small set of UI primitives and `cn`:

- `@/components/ui/{card,button,badge,input,textarea,select,switch,table,separator}`
- `@/lib/utils` (`cn`)

These follow the shadcn/ui convention used across this repository. To port:

1. Copy the `deep-form/` folder next to your components.
2. Make sure the imported primitives exist at those paths, or update the imports
   (they are all at the top of the files).
3. Adjust the `@` alias in `vitest.config.ts` if your `src` layout differs.
4. Styling uses semantic theme tokens, so it inherits light/dark and theme
   presets automatically.

## Usage

### Auto mode (value only)

```tsx
import { DeepForm } from "@/components/deep-form";

export function Economics() {
  const [value, setValue] = useState(draft);
  return <DeepForm value={value} onChange={(next) => setValue(next)} />;
}
```

### With JSON Schema (field types)

```tsx
<DeepForm value={value} schema={schema} onChange={handleChange} />
```

### With a layout (ordering / grouping / components)

```tsx
const layout = {
  children: [
    { kind: "text", text: "Contractual funding terms." },
    {
      kind: "group",
      title: "Funding",
      children: [
        { kind: "field", path: "/notional" },
        { kind: "field", path: "/payment_currency", renderer: "currency-code" },
      ],
    },
    { kind: "field", path: "/coupon_rate", renderer: "percentage-input" },
    { kind: "field", path: "/expiry", renderer: "date-input" },
  ],
};

<DeepForm value={value} schema={schema} layout={layout} onChange={handleChange} />;
```

### Handling changes

```tsx
function handleChange(next: DeepFormValue, event: DeepFormChangeEvent) {
  // event.path is a JSON pointer, e.g. "/protection/return_ratio"
  if (event.type === "update" && event.path === "/coupon_rate") {
    // react to a single field
  }
  setValue(next);
}
```

## Props

| Prop | Type | Description |
| --- | --- | --- |
| `value` | `DeepFormValue` | The document to render. |
| `onChange` | `(next, event) => void` | Called on every mutation. Providing it makes the component controlled. |
| `schema` | `DeepFormJsonSchema` | JSON Schema used to infer field types and defaults. |
| `layout` | `DeepFormLayout \| DeepFormLayoutNode` | Layout document controlling structure. |
| `fieldHints` | `DeepFormFieldHints` | Per-path overrides (label, renderer, options, validation), keyed by pointer or dotted path. |
| `renderers` | `DeepFormRenderers` | Extra/overriding renderers merged over the built-ins. |
| `readOnly` | `boolean` | Replaces editors with static values. |
| `validate` | `DeepFormFieldValidator` | Validator applied to every primitive leaf. |
| `defaultExpandedDepth` | `number` | Containers expanded on mount (default `1`). |
| `defaultExpandedPaths` | `string[]` | Explicit pointers expanded on mount. |
| `expandedPaths` / `onExpandedChange` | `string[]` / `(paths) => void` | Controlled expansion. |
| `title` / `description` / `headerActions` | `ReactNode` | Optional header. |

`onChange` is optional. Without it the component manages its own document state
(useful for demos); with it the parent owns the value.

## JSON pointer paths

Paths use [JSON Pointer](https://datatracker.ietf.org/doc/html/rfc6901) syntax:
`/underlyings/0/name`. Layout node paths may be absolute (`/notional`) or
relative to the enclosing group (`return_ratio`). `fieldHints` keys accept
either a pointer (`/notional`) or a dotted path (`notional`).

## Renderers

Built-in renderer keys: `text-input`, `textarea`, `number-input`,
`percentage-input`, `money-input`, `currency-code`, `date-input`, `switch`,
`select`, `readonly`, `json`.

Resolution order for a field: layout `renderer` → hint `renderer` →
schema `x-renderer` → schema `enum`/`format`/`type` → runtime value type.

Register a custom renderer:

```tsx
const renderers = {
  "my-editor": ({ value, onChange, id, invalid, describedBy }) => (
    <input id={id} aria-invalid={invalid} aria-describedby={describedBy}
      value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />
  ),
};

<DeepForm value={value} layout={layout} renderers={renderers} onChange={handleChange} />;
```

## Testing

The tests are self-contained (Vitest + jsdom + Testing Library):

```bash
npx vitest run --config src/components/deep-form/vitest.config.ts
```

They cover pointer/value helpers, schema resolution and renderer inference, the
auto-mode tree (expand/collapse, edits, array add/remove/move, read-only), and
layout mode (ordering, overrides, `visible_when`, custom renderers).
