import { useState } from "react";

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DeepForm, type DeepFormProps } from "../deep-form";
import type { DeepFormChangeEvent, DeepFormChangeHandler, DeepFormJsonSchema, DeepFormValue } from "../types";

const VALUE: DeepFormValue = {
  notional: 1_000_000,
  payment_currency: "USD",
  memory: true,
  protection: { return_ratio: 0.8, barrier: 0.6 },
  underlyings: [
    { name: "AAPL", spot: 190 },
    { name: "MSFT", spot: 400 },
  ],
};

const SCHEMA: DeepFormJsonSchema = {
  type: "object",
  properties: {
    notional: { type: "number", title: "Notional" },
    payment_currency: { type: "string", enum: ["USD", "EUR", "GBP"] },
    memory: { type: "boolean" },
    protection: {
      type: "object",
      properties: { return_ratio: { type: "number" }, barrier: { type: "number" } },
    },
    underlyings: {
      type: "array",
      items: { type: "object", properties: { name: { type: "string" }, spot: { type: "number" } } },
    },
  },
};

type HarnessProps = Omit<DeepFormProps, "value" | "onChange"> & {
  initial?: DeepFormValue;
  onChange?: DeepFormChangeHandler;
};

function Harness({ initial, onChange, ...rest }: HarnessProps) {
  const [value, setValue] = useState<DeepFormValue>(initial ?? VALUE);
  return (
    <DeepForm
      value={value}
      onChange={(next, event) => {
        onChange?.(next, event);
        setValue(next);
      }}
      {...rest}
    />
  );
}

function lastEvent(spy: ReturnType<typeof vi.fn<DeepFormChangeHandler>>): DeepFormChangeEvent {
  return spy.mock.calls[spy.mock.calls.length - 1][1];
}

describe("DeepForm auto mode", () => {
  it("renders root scalar fields as a table and nested objects as collapsed cards", () => {
    render(<Harness />);

    expect(screen.getByText("Notional")).toBeInTheDocument();
    expect(screen.getByText("Payment currency")).toBeInTheDocument();
    // Root is expanded (depth 1) so its fields are visible.
    expect(screen.getByRole("spinbutton")).toBeInTheDocument();
    // Nested objects are collapsed by default, so their fields are not rendered.
    expect(screen.queryByText("Return ratio")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /protection/i })).toHaveAttribute("aria-expanded", "false");
  });

  it("expands a nested object card on click", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: /protection/i }));
    expect(screen.getByText("Return ratio")).toBeInTheDocument();
    expect(screen.getByText("Barrier")).toBeInTheDocument();
  });

  it("emits onChange with path, value and next root when a scalar changes", () => {
    const onChange = vi.fn<DeepFormChangeHandler>();
    render(<Harness onChange={onChange} />);

    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "2000000" } });

    const event = lastEvent(onChange);
    expect(event.type).toBe("update");
    expect(event.path).toBe("/notional");
    expect(event.value).toBe(2_000_000);
    expect(event.previousValue).toBe(1_000_000);
    expect((event.root as Record<string, unknown>).notional).toBe(2_000_000);
  });

  it("emits boolean updates from switch fields", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<DeepFormChangeHandler>();
    render(<Harness onChange={onChange} />);

    await user.click(screen.getByRole("switch"));
    const event = lastEvent(onChange);
    expect(event.path).toBe("/memory");
    expect(event.value).toBe(false);
  });

  it("adds and removes array items with add/remove events", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<DeepFormChangeHandler>();
    render(<Harness onChange={onChange} schema={SCHEMA} />);

    await user.click(screen.getByRole("button", { name: /underlyings/i }));
    await user.click(screen.getByRole("button", { name: /^add$/i }));

    const added = lastEvent(onChange);
    expect(added.type).toBe("add");
    expect(added.path).toBe("/underlyings/2");
    expect(added.index).toBe(2);
    expect((added.root as Record<string, unknown>).underlyings).toHaveLength(3);

    await user.click(screen.getByRole("button", { name: /remove item 1/i }));
    const removed = lastEvent(onChange);
    expect(removed.type).toBe("remove");
    expect(removed.path).toBe("/underlyings/0");
    expect((removed.root as Record<string, unknown>).underlyings).toHaveLength(2);
  });

  it("respects readOnly by replacing inputs with static values", () => {
    render(<Harness readOnly />);

    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    expect(screen.getByText("1000000")).toBeInTheDocument();
    expect(screen.getByRole("switch")).toBeDisabled();
  });

  it("applies field hints for labels", () => {
    render(<Harness fieldHints={{ "/notional": { label: "Notional amount" } }} />);
    expect(screen.getByText("Notional amount")).toBeInTheDocument();
  });

  it("uses schema enums to render a select", () => {
    render(<Harness schema={SCHEMA} />);
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("exposes expand/collapse controls", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: /underlyings/i }));
    expect(screen.getByText("Underlyings 1")).toBeInTheDocument();
  });
});
