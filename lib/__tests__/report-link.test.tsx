// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import Markdown from "@/components/ui/Markdown";
afterEach(cleanup);
it("opens persisted work reports while refusing unsafe or arbitrary relative links", () => {
  const path = `/work/compose_${"a".repeat(32)}`;
  render(
    <Markdown
      text={`[Open report](${path}) [unsafe](javascript:alert) [outside](//example.org) [admin](/admin)`}
    />,
  );
  expect(screen.getByRole("link", { name: "Open report" }).getAttribute("href")).toBe(path);
  expect(screen.getAllByRole("link")).toHaveLength(1);
});
