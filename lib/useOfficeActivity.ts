"use client";
import { useEffect, useState } from "react";
import { gameEvents } from "./events";
export function useOfficeActivity() {
  const [activities, setActivities] = useState<
    Record<string, { activity: string; location: string }>
  >({});
  useEffect(() => {
    const off = gameEvents.on("office-activities", (rows) =>
      setActivities(Object.fromEntries(rows.map((row) => [row.seatId, row]))),
    );
    gameEvents.emit("office-activities-request");
    return off;
  }, []);
  return activities;
}
