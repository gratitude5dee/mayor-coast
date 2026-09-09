import { beforeEach, expect, it, vi } from "vitest";
import { Children, isValidElement, type ReactNode } from "react";
import DrawStudio from "../src/app/draw/[sessionId]/draw-studio";

const queue = vi.hoisted(() => ({ updates: [] as Array<() => void>, values: [] as unknown[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: () => undefined,
  useCallback: (callback: unknown) => callback,
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => {
    const index = queue.values.push(initial) - 1;
    return [initial, (update: unknown) => queue.updates.push(() => {
      queue.values[index] = typeof update === "function" ? update(queue.values[index]) : update;
    })];
  },
}));

function canvasProps(node: ReactNode): Record<string, unknown> | undefined {
  if (!isValidElement<Record<string, unknown>>(node)) return;
  if (node.props["aria-label"] === "COAST drawing canvas") return node.props;
  return Children.toArray(node.props.children as ReactNode).map(canvasProps).find(Boolean);
}

beforeEach(() => { queue.updates = []; queue.values = []; });

it("retains batched pointer moves after React clears the event target", async () => {
  // The test deliberately delays every state updater until dispatch ends.
  vi.stubGlobal("React", await import("react"));
  const props = canvasProps(DrawStudio({ sessionId: "test" }))!;
  const target = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1024, height: 1024 }),
    setPointerCapture: () => { throw new Error("capture unsupported"); },
  };
  const dispatch = (name: string, x: number, y: number) => {
    const event = { pointerId: 1, clientX: x, clientY: y, currentTarget: target as typeof target | null, preventDefault() {} };
    (props[name] as (event: unknown) => void)(event);
    event.currentTarget = null;
  };
  dispatch("onPointerDown", 10, 20);
  dispatch("onPointerMove", 30, 40);
  dispatch("onPointerMove", 50, 60);
  dispatch("onPointerUp", 50, 60);
  expect(() => queue.updates.forEach((update) => update())).not.toThrow();
  expect(queue.values).toContainEqual([{
    points: [{ x: 10, y: 20 }, { x: 30, y: 40 }, { x: 50, y: 60 }],
    color: "#17231d", width: 18, erase: false,
  }]);
  vi.unstubAllGlobals();
});
