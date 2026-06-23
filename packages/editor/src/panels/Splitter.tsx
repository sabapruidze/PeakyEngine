import { useEffect, useRef } from "react";

interface Props {
  /** Called with delta-x in pixels per mouse-move while the splitter is dragged. */
  onDrag: (delta: number) => void;
  /** "x" = vertical bar (col-resize, default). "y" = horizontal bar (row-resize). */
  axis?: "x" | "y";
}

/**
 * Resizable drag handle between two panels. Supports both vertical (col-resize)
 * and horizontal (row-resize) orientations via the `axis` prop.
 */
export function Splitter({ onDrag, axis = "x" }: Props) {
  const dragging = useRef(false);
  const cursor = axis === "y" ? "row-resize" : "col-resize";

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      onDrag(axis === "y" ? e.movementY : e.movementX);
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [onDrag, axis]);

  return (
    <div
      className="splitter"
      style={axis === "y" ? { width: "100%", height: 4, cursor } : undefined}
      onMouseDown={(e) => {
        e.preventDefault();
        dragging.current = true;
        document.body.style.cursor = cursor;
        document.body.style.userSelect = "none";
      }}
    />
  );
}
