// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceView, useWorkspaceView } from "@/components/hud/WorkspaceView";
beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function Controls() {
  const v = useWorkspaceView()!;
  return (
    <>
      <button onClick={() => v.setOpenPanel("workers")}>Workers</button>
      <button onClick={() => v.setOpenPanel("chat")}>Chat</button>
      <button onClick={v.enter}>Enter</button>
      <button onClick={v.exit}>Exit</button>
      <button onClick={() => void v.fullscreen()}>Fullscreen</button>
      <output>
        {v.immersive ? "full" : "standard"}:{v.openPanel ?? "closed"}
      </output>
    </>
  );
}
it("restores the original panel after temporary immersive chat", () => {
  render(
    <WorkspaceView>
      <Controls />
    </WorkspaceView>,
  );
  fireEvent.click(screen.getByText("Workers"));
  fireEvent.click(screen.getByText("Enter"));
  expect(screen.getByRole("status").textContent).toBe("full:closed");
  fireEvent.click(screen.getByText("Chat"));
  fireEvent.click(screen.getByText("Enter"));
  fireEvent.click(screen.getByText("Exit"));
  expect(screen.getByRole("status").textContent).toBe("standard:workers");
});
it("keeps full view usable when browser fullscreen is unsupported", async () => {
  render(
    <WorkspaceView>
      <Controls />
    </WorkspaceView>,
  );
  fireEvent.click(screen.getByText("Fullscreen"));
  await waitFor(() => expect(screen.getByText(/Browser fullscreen is unavailable/)).toBeTruthy());
  expect(document.querySelector(".office-app--immersive")).toBeTruthy();
});
