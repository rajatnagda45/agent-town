// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import OfficeControls from "@/components/hud/OfficeControls";
beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("changes office preferences through existing callbacks and restores trigger focus", () => {
  const life = vi.fn(),
    light = vi.fn();
  render(
    <OfficeControls
      cinematic
      available
      loading={false}
      intensity="calm"
      daylight="day"
      onIntensity={life}
      onDaylight={light}
      onRecenter={vi.fn()}
      onToggleView={vi.fn()}
    />,
  );
  const trigger = screen.getByLabelText("Ambient office life");
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("button", { name: /Lively.*More frequent/ }));
  expect(life).toHaveBeenCalledWith("lively");
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(screen.getByLabelText("Exterior lighting"));
  fireEvent.click(screen.getByRole("button", { name: /Dusk.*Warm evening/ }));
  expect(light).toHaveBeenCalledWith("dusk");
});
it("supports arrow navigation, Escape, click outside and unchanged camera actions", () => {
  const recenter = vi.fn(),
    toggle = vi.fn();
  render(
    <OfficeControls
      cinematic
      available
      loading={false}
      intensity="calm"
      daylight="day"
      onIntensity={vi.fn()}
      onDaylight={vi.fn()}
      onRecenter={recenter}
      onToggleView={toggle}
    />,
  );
  fireEvent.click(screen.getByLabelText("Recenter camera"));
  expect(recenter).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText("2D view"));
  expect(toggle).toHaveBeenCalledTimes(1);
  const trigger = screen.getByLabelText("Ambient office life");
  fireEvent.click(trigger);
  fireEvent.keyDown(trigger, { key: "End" });
  expect(document.activeElement?.textContent).toContain("Lively");
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByText("Set the pace of ambient office activity.")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByText("Set the pace of ambient office activity.")).toBeNull();
});
