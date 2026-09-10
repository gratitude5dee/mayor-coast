"use client";

import "tldraw/tldraw.css";
import { DefaultColorStyle, DefaultSizeStyle, Tldraw, type Editor } from "tldraw";

/**
 * The staged alternative editor. It is only mounted when a production tldraw
 * license is configured. COAST's raster editor stays the default because its
 * fixed square and exported-image contract are intentionally optimized for
 * Photon Messages. Keeping this boundary explicit lets the editor be tested
 * without changing the production canvas or persisting strokes in browser
 * storage.
 */
export type RasterEditorAdapter = {
  clear(): void;
  undo(): void;
  redo(): void;
  setBrush(color: string, width: number): void;
  setEraser(enabled: boolean): void;
  exportJpeg(): Promise<Blob | null>;
};

type Props = {
  licenseKey: string;
  onReady(adapter: RasterEditorAdapter): void;
};

function asAdapter(editor: Editor): RasterEditorAdapter {
  const colorFor = (color: string) => ({
    "#070a12": "black",
    "#286dde": "blue",
    "#dc2626": "red",
    "#2563eb": "blue",
    "#ffffff": "white",
  }[color] ?? "black");
  const sizeFor = (width: number) => width <= 12 ? "s" : width <= 24 ? "m" : width <= 40 ? "l" : "xl";
  return {
    clear() { editor.deleteShapes([...editor.getCurrentPageShapeIds()]); },
    undo() { editor.undo(); },
    redo() { editor.redo(); },
    setBrush(color, width) {
      editor.setCurrentTool("draw");
      editor.setStyleForNextShapes(DefaultColorStyle, colorFor(color));
      editor.setStyleForNextShapes(DefaultSizeStyle, sizeFor(width));
    },
    setEraser(enabled) { editor.setCurrentTool(enabled ? "eraser" : "draw"); },
    async exportJpeg() {
      const shapes = [...editor.getCurrentPageShapeIds()];
      if (shapes.length === 0) return null;
      const image = await editor.toImage(shapes, { format: "jpeg", background: true, pixelRatio: 1 });
      return image.blob;
    },
  };
}

export default function TldrawAdapter({ licenseKey, onReady }: Props) {
  return <div className="tldraw-stage" aria-label="COAST drawing canvas">
    <Tldraw
      licenseKey={licenseKey}
      hideUi
      autoFocus={false}
      onMount={(editor) => {
        editor.setCurrentTool("draw");
        onReady(asAdapter(editor));
      }}
    />
  </div>;
}
