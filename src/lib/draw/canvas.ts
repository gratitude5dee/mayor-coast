export const DRAW_CANVAS_SIZE = 1024;
export const DRAW_UPLOAD_MAX_BYTES = 3 * 1024 * 1024;
export const DRAW_IMPORT_MAX_BYTES = 10 * 1024 * 1024;

export type DrawPoint = { x: number; y: number };
export type DrawStroke = {
  points: DrawPoint[];
  color: string;
  width: number;
  erase: boolean;
};

export function completedStroke(
  points: DrawPoint[],
  color: string,
  width: number,
  erase: boolean,
): DrawStroke | null {
  const finite = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  return finite.length === 0 ? null : { points: finite, color, width, erase };
}

/** Fit the whole source in a square, retaining its aspect ratio. */
export function containImage(width: number, height: number, size = DRAW_CANVAS_SIZE) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("Invalid image dimensions");
  }
  const scale = Math.min(size / width, size / height);
  const fittedWidth = width * scale;
  const fittedHeight = height * scale;
  return { x: (size - fittedWidth) / 2, y: (size - fittedHeight) / 2, width: fittedWidth, height: fittedHeight };
}

export function canvasPoint(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }): DrawPoint {
  return {
    x: Math.max(0, Math.min(DRAW_CANVAS_SIZE, (clientX - rect.left) * DRAW_CANVAS_SIZE / Math.max(1, rect.width))),
    y: Math.max(0, Math.min(DRAW_CANVAS_SIZE, (clientY - rect.top) * DRAW_CANVAS_SIZE / Math.max(1, rect.height))),
  };
}

/** Erasing always targets the transparent stroke layer, never the background. */
export function paintStroke(context: CanvasRenderingContext2D, stroke: DrawStroke) {
  const first = stroke.points[0];
  if (!first) return;
  context.save();
  context.globalCompositeOperation = stroke.erase ? "destination-out" : "source-over";
  context.strokeStyle = stroke.color;
  context.fillStyle = stroke.color;
  context.lineWidth = stroke.width;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  if (stroke.points.length === 1) {
    context.arc(first.x, first.y, stroke.width / 2, 0, Math.PI * 2);
    context.fill();
  } else {
    context.moveTo(first.x, first.y);
    for (const point of stroke.points.slice(1)) context.lineTo(point.x, point.y);
    context.stroke();
  }
  context.restore();
}

export function hasVisibleInk(data: Uint8ClampedArray): boolean {
  for (let i = 3; i < data.length; i += 4) {
    if ((data[i] ?? 0) > 16) return true;
  }
  return false;
}

export function isDrawJobActive(state: string | undefined): boolean {
  return state !== undefined && !new Set(["delivered", "terminal_failure", "refused", "cancelled", "expired"]).has(state);
}

export function drawJobLabel(state: string | undefined): string {
  switch (state) {
    case "awaiting_payment": return "Waiting for credit";
    case "submission_unknown":
    case "unknown_submission": return "Checking generation";
    case "submitting":
    case "submission_intent":
    case "submitted":
    case "queued":
    case "running": return "Generating";
    case "ready_for_delivery":
    case "ready":
    case "delivering": return "Sending to iMessage";
    case "delivered": return "Delivered to iMessage";
    case "cancelled": return "Cancelled";
    case "expired": return "Request expired";
    case "terminal_failure": return "Couldn’t finish this image";
    case "refused": return "Try a different idea";
    case undefined: return "Your next idea starts here";
    default: return "Preparing";
  }
}
