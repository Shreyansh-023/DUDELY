"use client";

/**
 * Client-only wrapper around Excalidraw. Everything that imports
 * `@excalidraw/excalidraw` (which touches `window` at import time) lives
 * behind this module, which Tutor loads with `dynamic(..., { ssr: false })`.
 */
import { Excalidraw, WelcomeScreen } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { BoardPlayer } from "@/lib/canvas/player";
import { isTutorElement, summarizeScene } from "@/lib/canvas/summary";

export type Board = {
  api: ExcalidrawImperativeAPI;
  player: BoardPlayer;
  isTutorElement: typeof isTutorElement;
  summarizeScene: typeof summarizeScene;
};

export default function Whiteboard({ onReady }: { onReady: (board: Board) => void }) {
  return (
    // View mode: the board is a display surface Guru draws on. The student asks by
    // voice or text, not by drawing, so Excalidraw's tool palette and the stroke/
    // background properties panel stay hidden and never cover the canvas. The
    // imperative API still works in view mode, so Guru draws normally.
    <Excalidraw
      viewModeEnabled
      excalidrawAPI={(api) => onReady({ api, player: new BoardPlayer(api), isTutorElement, summarizeScene })}
      initialData={{
        appState: {
          viewBackgroundColor: "#fffdf7",
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
            <span style={{ fontSize: 40 }}>🪔</span>
          </WelcomeScreen.Center.Logo>
          <WelcomeScreen.Center.Heading>Ask Guru anything — type or talk. Guru explains here on the board.</WelcomeScreen.Center.Heading>
        </WelcomeScreen.Center>
      </WelcomeScreen>
    </Excalidraw>
  );
}
