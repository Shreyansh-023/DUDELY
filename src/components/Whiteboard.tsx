"use client";

/**
 * Client-only wrapper around Excalidraw. Everything that imports
 * `@excalidraw/excalidraw` (which touches `window` at import time) lives
 * behind this module, which Tutor loads with `dynamic(..., { ssr: false })`.
 */
import { Excalidraw, WelcomeScreen } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useEffect, useRef } from "react";
import { BoardPlayer } from "@/lib/canvas/player";
import { isTutorElement, summarizeScene } from "@/lib/canvas/summary";
import { LogoMark } from "./Logo";

export type Board = {
  api: ExcalidrawImperativeAPI;
  player: BoardPlayer;
  isTutorElement: typeof isTutorElement;
  summarizeScene: typeof summarizeScene;
};

export default function Whiteboard({
  onReady,
  /** The lesson is being designed: the planning card covers this canvas, so
   *  Excalidraw's "ask me anything" welcome screen must not show through it. */
  planning = false,
}: {
  onReady: (board: Board) => void;
  planning?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<BoardPlayer | null>(null);

  // The board frames exactly one page, so a container resize has to re-fit it.
  // Excalidraw's own ResizeObserver silently rewrites appState.width/height and
  // nothing re-frames; api.refresh() only updates offsetLeft/offsetTop. We run
  // after its observer has settled.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (t) clearTimeout(t);
      t = setTimeout(() => playerRef.current?.refit(), 140);
    });
    ro.observe(host);
    return () => {
      ro.disconnect();
      if (t) clearTimeout(t);
    };
  }, []);

  // View mode: the board is a display surface Guru draws on. The student asks by
  // voice or text, not by drawing, so Excalidraw's tool palette and the stroke/
  // background properties panel stay hidden and never cover the canvas. The
  // imperative API still works in view mode, so Guru draws normally.
  return (
    <div ref={hostRef} className="h-full w-full" data-planning={planning ? "true" : undefined}>
    <Excalidraw
      viewModeEnabled
      excalidrawAPI={(api) => {
        const player = new BoardPlayer(api);
        playerRef.current = player;
        onReady({ api, player, isTutorElement, summarizeScene });
      }}
      // Fires on viewport changes too, which is the only signal that the
      // student dragged the board themselves. The player compares it with what
      // it last wrote and, if they have moved away, stops following Indica and
      // offers the way back.
      onChange={() => playerRef.current?.notifyViewport()}
      initialData={{
        appState: {
          // Transparent so the decorative `.board-surface` behind the canvas
          // shows through; Guru's strokes are drawn on top of it.
          viewBackgroundColor: "transparent",
          currentItemStrokeColor: "#1971c2",
          currentItemStrokeWidth: 2,
          currentItemFontFamily: 5,
        },
      }}
      UIOptions={{
        canvasActions: {
          loadScene: false,
          saveToActiveFile: false,
          export: false,
          toggleTheme: false,
          changeViewBackgroundColor: false,
          clearCanvas: false,
          saveAsImage: true,
        },
        tools: { image: false },
      }}
    >
      <WelcomeScreen>
        <WelcomeScreen.Center>
          <WelcomeScreen.Center.Logo>
            <span style={{ color: "#f59e0b", opacity: 0.38, display: "inline-flex" }}>
              <LogoMark className="h-9 w-auto" />
            </span>
          </WelcomeScreen.Center.Logo>
          <WelcomeScreen.Center.Heading>Indica explains here on the board. Just talk — the microphone is already listening.</WelcomeScreen.Center.Heading>
        </WelcomeScreen.Center>
      </WelcomeScreen>
    </Excalidraw>
    </div>
  );
}
