import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import "./avail.css";
import { LIBRARY_WIDTH_DEFAULT, clampLibraryWidth, loadLibraryWidth, saveLibraryWidth } from "./libraryWidth";

/**
 * AVAIL build: the library panel's width and the drag handle on its right edge.
 * Drag to resize, double-click to reset; the width is saved when the drag ends.
 */
export function useLibraryWidth(): { width: number; handle: ReactNode } {
  const [width, setWidth] = useState(() => clampLibraryWidth(loadLibraryWidth(), window.innerWidth));
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startX: number; startWidth: number; lastWidth: number } | null>(null);

  // Keep the panel within half the window when the window shrinks.
  useEffect(() => {
    const onResize = () => setWidth((w) => clampLibraryWidth(w, window.innerWidth));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startWidth: width, lastWidth: width };
    setDragging(true);
  }, [width]);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.lastWidth = clampLibraryWidth(d.startWidth + e.clientX - d.startX, window.innerWidth);
    setWidth(d.lastWidth);
  }, []);

  const endDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    saveLibraryWidth(d.lastWidth);
  }, []);

  const reset = useCallback(() => {
    const w = clampLibraryWidth(LIBRARY_WIDTH_DEFAULT, window.innerWidth);
    setWidth(w);
    saveLibraryWidth(w);
  }, []);

  const handle = (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize device library"
      title="Drag to resize. Double-click to reset."
      data-testid="avail-library-resize"
      data-dragging={dragging ? "true" : "false"}
      className="avail-library-resize"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={reset}
    />
  );
  return { width, handle };
}
