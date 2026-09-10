import { beforeEach, expect, it, vi } from "vitest";
import { Children, isValidElement, type ReactNode } from "react";
import DrawStudio from "../src/app/draw/[sessionId]/draw-studio";

const queue = vi.hoisted(() => ({ updates: [] as Array<() => void>, values: [] as unknown[], overrides: {} as Record<number, unknown> }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: () => undefined,
  useCallback: (callback: unknown) => callback,
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => {
    if (queue.values.length in queue.overrides) initial = queue.overrides[queue.values.length];
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

beforeEach(() => { queue.updates = []; queue.values = []; queue.overrides = {}; });

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
    color: "#070a12", width: 18, erase: false,
  }]);
  vi.unstubAllGlobals();
});

it.each(["fast", "turbo"])("Generate uploads a sketch and admits exactly once in %s mode", async (mode) => {
  vi.stubGlobal("React", await import("react"));
  // Set the selected mode and an authorized session; effects are excluded here.
  queue.overrides = { 7: mode, 12: true };
  const root = DrawStudio({ sessionId: "test" });
  let click: (() => void) | undefined;
  const context = { getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }), fillRect() {}, drawImage() {} };
  function visit(node: ReactNode) {
    if (!isValidElement<Record<string, unknown>>(node)) return;
    if (node.type === "canvas") (node.props.ref as { current: unknown }).current = { getContext: () => context };
    if (node.props.className === "generate") click = node.props.onClick as () => void;
    Children.forEach(node.props.children as ReactNode, visit);
  }
  visit(root);
  vi.stubGlobal("document", { createElement: () => ({ getContext: () => context, toBlob: (callback: (blob: Blob) => void) => callback(new Blob(["sketch"], { type: "image/png" })) }) });
  const requests: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, body: init.body });
    return Response.json(url.endsWith("/media") ? { mediaId: "opaque-media" } : { jobId: "job", state: "admitted" });
  }));
  click!(); click!();
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[0]?.url).toMatch(/\/media$/);
  expect(JSON.parse(requests[1]?.body as string)).toMatchObject({ mediaId: "opaque-media", mode });
  vi.unstubAllGlobals();
});

it("keeps a completed image in Preview until the user explicitly saves it to iMessage", async () => {
  vi.stubGlobal("React", await import("react"));
  queue.overrides = {
    8: { id: "job", state: "ready_for_save", outputUrl: "/private/final.jpg" },
    9: "preview",
    12: true,
  };
  const root = DrawStudio({ sessionId: "test" });
  const buttons: string[] = [];
  let previewSource: unknown;
  let saveClick: (() => void) | undefined;
  function visit(node: ReactNode) {
    if (!isValidElement<Record<string, unknown>>(node)) return;
    if (node.type === "button") {
      const text = String(node.props.children);
      buttons.push(text);
      if (text === "Save to iMessage") saveClick = node.props.onClick as () => void;
    }
    if (node.type === "img" && node.props.alt === "COAST generated preview") previewSource = node.props.src;
    Children.forEach(node.props.children as ReactNode, visit);
  }
  visit(root);
  expect(previewSource).toBe("/private/final.jpg");
  expect(buttons).toContain("Save to iMessage");
  expect(buttons).not.toContain("Cancel");
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    requests.push(url);
    return Response.json({ ok: true, state: "ready_for_delivery" });
  }));
  saveClick!();
  await vi.waitFor(() => expect(requests).toEqual(["/api/draw/sessions/test/jobs/job/save"]));
  vi.unstubAllGlobals();
});
