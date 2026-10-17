import { useState } from "react";

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DeepForm, type DeepFormProps } from "../deep-form";
import type { DeepFormChangeHandler, DeepFormLayout, DeepFormRenderer, DeepFormValue } from "../types";

const VALUE: DeepFormValue = {
  notional: 1_000_000,
  payment_currency: "USD",
  coupon_rate: 0.1,
  memory: true,
  protection: { return_ratio: 0.8 },
};

const LAYOUT: DeepFormLayout = {
  children: [
    { kind: "text", text: "Contractual funding terms." },
    {
      kind: "group",
      id: "funding",
      title: "Funding",
      children: [
        { kind: "field", path: "/notional", label: "Notional" },
        { kind: "field", path: "/payment_currency", renderer: "readonly" },
      ],
    },
    { kind: "divider" },
    { kind: "field", path: "/memory", renderer: "switch" },
    {
      kind: "field",
      path: "/protection/return_ratio",
      label: "Conditional ratio",
      visible_when: { path: "/memory", equals: true },
    },
  ],
};

function Harness({
  initial,
  onChange,
  ...rest
}: Omit<DeepFormProps, "value" | "onChange"> & { initial?: DeepFormValue; onChange?: DeepFormChangeHandler }) {
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

describe("DeepForm layout mode", () => {
  it("renders layout nodes in order with overrides", () => {
    render(<Harness layout={LAYOUT} defaultExpandedDepth={2} />);

    expect(screen.getByText("Contractual funding terms.")).toBeInTheDocument();
    expect(screen.getByText("Funding")).toBeInTheDocument();
    expect(screen.getByText("Notional")).toBeInTheDocument();
    // `readonly` renderer prints the value instead of an input.
    expect(screen.getByText("USD")).toBeInTheDocument();
    expect(screen.getByRole("switch")).toBeInTheDocument();
  });

  it("only renders fields listed in the layout", () => {
    render(<Harness layout={LAYOUT} defaultExpandedDepth={2} />);
    // `coupon_rate` exists in the value but is not part of the layout.
    expect(screen.queryByText("Coupon rate")).not.toBeInTheDocument();
  });

  it("honours visible_when conditions", async () => {
    const user = userEvent.setup();
    render(<Harness layout={LAYOUT} defaultExpandedDepth={2} />);

    expect(screen.getByText("Conditional ratio")).toBeInTheDocument();
    await user.click(screen.getByRole("switch"));
    expect(screen.queryByText("Conditional ratio")).not.toBeInTheDocument();
  });

  it("auto-renders a group bound to a subtree without children", () => {
    const layout: DeepFormLayout = {
      children: [{ kind: "group", title: "Protection", path: "/protection" }],
    };
    render(<Harness layout={layout} />);
    expect(screen.getByText("Return ratio")).toBeInTheDocument();
  });

  it("supports custom renderers registered by the host", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<DeepFormChangeHandler>();
    const upper: DeepFormRenderer = ({ value, onChange: emit }) => (
      <input
        aria-label="upper"
        value={String(value ?? "")}
        onChange={(event) => emit(event.target.value.toUpperCase())}
      />
    );
    const layout: DeepFormLayout = {
      children: [{ kind: "field", path: "/payment_currency", renderer: "upper-text" }],
    };
    render(<Harness layout={layout} renderers={{ "upper-text": upper }} onChange={onChange} />);

    const input = screen.getByLabelText("upper");
    await user.clear(input);
    await user.type(input, "eur");
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls[onChange.mock.calls.length - 1][1].value).toBe("EUR");
  });
});
