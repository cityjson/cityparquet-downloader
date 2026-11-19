// The area tools over the map: draw a polygon or a rectangle, take the current view, or
// clear the area. While drawing, a line at the map's foot says how to finish.
import { Button } from "@/components/ui/button";
import { useMap } from "@/features/map/map";
import {
  areaFromView,
  cancelDrawing,
  clearArea,
  finishPolygon,
  startDrawing,
  useDraw,
} from "./draw";
import { useSelection } from "./store";

const HINTS = {
  polygon:
    "Click to add corners. Double-click or press Enter to finish. Backspace removes the last corner. Escape cancels.",
  rectangle: "Drag on the map to draw a rectangle. Escape cancels.",
} as const;

export function AreaTools() {
  const map = useMap((s) => s.map);
  const { mode, points } = useDraw();
  const hasArea = useSelection((s) => s.extent !== null);
  if (!map) return null;
  return (
    <>
      <div
        role="toolbar"
        aria-label="Area"
        className="absolute top-3 left-28 z-10 flex max-w-[calc(100%-8rem)] flex-wrap gap-1.5"
      >
        <Button
          size="xs"
          variant={mode === "polygon" ? "default" : "outline"}
          className="shadow-card"
          aria-pressed={mode === "polygon"}
          onClick={() => (mode === "polygon" ? cancelDrawing() : startDrawing("polygon"))}
        >
          Draw polygon
        </Button>
        <Button
          size="xs"
          variant={mode === "rectangle" ? "default" : "outline"}
          className="shadow-card"
          aria-pressed={mode === "rectangle"}
          onClick={() => (mode === "rectangle" ? cancelDrawing() : startDrawing("rectangle"))}
        >
          Draw rectangle
        </Button>
        <Button
          size="xs"
          variant="outline"
          className="shadow-card"
          onClick={() => areaFromView(map)}
        >
          Use current view
        </Button>
        <Button
          size="xs"
          variant="outline"
          className="shadow-card"
          disabled={!hasArea}
          onClick={clearArea}
        >
          Clear area
        </Button>
      </div>
      {mode !== "idle" && (
        <div className="absolute bottom-3 left-3 z-10 flex max-w-[calc(100%-6rem)] items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-xs text-card-foreground shadow-card">
          <p role="status">
            {HINTS[mode]}
            {mode === "polygon" &&
              ` ${points.length} ${points.length === 1 ? "corner" : "corners"}.`}
          </p>
          {mode === "polygon" && (
            <Button
              size="xs"
              variant="outline"
              disabled={points.length < 3}
              onClick={finishPolygon}
            >
              Finish
            </Button>
          )}
          <Button size="xs" variant="ghost" onClick={cancelDrawing}>
            Cancel
          </Button>
        </div>
      )}
    </>
  );
}
