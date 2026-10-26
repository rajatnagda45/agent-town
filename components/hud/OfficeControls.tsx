"use client";

import { useEffect, useRef, useState } from "react";
import {
  Expand,
  Minimize,
  Maximize,
  Activity,
  Check,
  ChevronDown,
  Crosshair,
  Keyboard,
  Layers,
  Moon,
  Sun,
  X,
} from "lucide-react";
import type { AmbientIntensity } from "@/components/game/systems/AmbientRoutine";
import "./office-controls.css";
import { useWorkspaceView } from "./WorkspaceView";

type Props = {
  cinematic: boolean;
  available: boolean;
  loading: boolean;
  intensity: AmbientIntensity;
  daylight: string;
  onRecenter: () => void;
  onToggleView: () => void;
  onIntensity: (value: AmbientIntensity) => void;
  onDaylight: (value: string) => void;
};
const routines = [
  { value: "off", label: "Off", description: "Pause ambient routines" },
  { value: "calm", label: "Calm", description: "Occasional breaks and movement" },
  { value: "lively", label: "Lively", description: "More frequent office activity" },
] as const;

export default function OfficeControls(props: Props) {
  const workspace = useWorkspaceView();
  const [menu, setMenu] = useState<"life" | "light" | "help" | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setMenu(null);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [menu]);
  const close = () => {
    setMenu(null);
    trigger.current?.focus();
  };
  const toggle = (name: typeof menu, button: HTMLButtonElement) => {
    trigger.current = button;
    setMenu((old) => (old === name ? null : name));
  };
  return (
    <div
      ref={root}
      className="office-controlbar"
      aria-label="Office controls"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setMenu(null);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || menu) e.stopPropagation();
        if (e.key === "Escape" && menu) {
          e.preventDefault();
          close();
        }
        if (menu && ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
          e.preventDefault();
          const items = Array.from(
            root.current?.querySelectorAll<HTMLButtonElement>(".office-control-menu button") ?? [],
          );
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            e.key === "Home"
              ? 0
              : e.key === "End"
                ? items.length - 1
                : e.key === "ArrowDown"
                  ? (index + 1) % items.length
                  : index <= 0
                    ? items.length - 1
                    : index - 1;
          items[next]?.focus();
        }
      }}
    >
      <div className="office-controlbar__identity">
        <span />
        {props.cinematic ? "Office" : "Classic"}
      </div>
      <div className="office-controlbar__group">
        <button
          className="office-control"
          onClick={props.onRecenter}
          disabled={!props.cinematic}
          title="Recenter camera"
          aria-label="Recenter camera"
        >
          <Crosshair size={16} />
          <span>Recenter</span>
        </button>
        <button
          className="office-control"
          onClick={props.onToggleView}
          disabled={!props.available || props.loading}
          title="Switch office view"
        >
          <Layers size={16} />
          <span>{props.cinematic ? "2D view" : "3D view"}</span>
        </button>
      </div>
      <div className="office-controlbar__group">
        <button
          className="office-control office-control--setting"
          aria-label="Ambient office life"
          aria-expanded={menu === "life"}
          aria-controls="office-life-menu"
          onClick={(e) => toggle("life", e.currentTarget)}
        >
          <Activity size={16} />
          <span>{routines.find((r) => r.value === props.intensity)?.label}</span>
          <ChevronDown size={12} />
        </button>
        <button
          className="office-control office-control--setting"
          aria-label="Exterior lighting"
          aria-expanded={menu === "light"}
          aria-controls="office-light-menu"
          onClick={(e) => toggle("light", e.currentTarget)}
        >
          {props.daylight === "day" ? <Sun size={16} /> : <Moon size={16} />}
          <span>{props.daylight === "day" ? "Daylight" : "Dusk"}</span>
          <ChevronDown size={12} />
        </button>
      </div>
      {workspace && (
        <>
          <button
            className="office-control"
            aria-pressed={workspace.immersive}
            onClick={workspace.immersive ? workspace.exit : workspace.enter}
          >
            {workspace.immersive ? <Minimize size={16} /> : <Expand size={16} />}
            <span>{workspace.immersive ? "Exit Full View" : "Full View"}</span>
          </button>
          {workspace.immersive && (
            <button
              className="office-control"
              aria-label="Browser fullscreen"
              title="Browser fullscreen"
              onClick={() => void workspace.fullscreen()}
            >
              <Maximize size={16} />
            </button>
          )}
        </>
      )}
      <button
        className="office-control office-control--help"
        aria-label="Keyboard and camera controls"
        aria-expanded={menu === "help"}
        onClick={(e) => toggle("help", e.currentTarget)}
        title="Controls & shortcuts"
      >
        <Keyboard size={17} />
      </button>
      {menu && (
        <div
          className="office-control-menu"
          id={
            menu === "life"
              ? "office-life-menu"
              : menu === "light"
                ? "office-light-menu"
                : undefined
          }
        >
          <div className="office-control-menu__heading">
            <span>
              {menu === "life"
                ? "Office life"
                : menu === "light"
                  ? "Lighting"
                  : "Controls & shortcuts"}
            </span>
            <button onClick={close} aria-label="Close controls menu">
              <X size={14} />
            </button>
          </div>
          {menu === "life" ? (
            <>
              <p>Set the pace of ambient office activity.</p>
              {routines.map((item) => (
                <button
                  className="office-control-option"
                  key={item.value}
                  aria-pressed={props.intensity === item.value}
                  onClick={() => {
                    props.onIntensity(item.value);
                    close();
                  }}
                >
                  <span>
                    <strong>{item.label}</strong>
                    <small>{item.description}</small>
                  </span>
                  {props.intensity === item.value && <Check size={16} />}
                </button>
              ))}
            </>
          ) : menu === "light" ? (
            <>
              <p>Choose the atmosphere of your workspace.</p>
              {[
                { value: "day", label: "Daylight", Icon: Sun, detail: "Bright and focused" },
                { value: "dusk", label: "Dusk", Icon: Moon, detail: "Warm evening light" },
              ].map(({ value, label, Icon, detail }) => (
                <button
                  className="office-control-option"
                  key={value}
                  aria-pressed={props.daylight === value}
                  onClick={() => {
                    props.onDaylight(value);
                    close();
                  }}
                >
                  <Icon size={19} />
                  <span>
                    <strong>{label}</strong>
                    <small>{detail}</small>
                  </span>
                  {props.daylight === value && <Check size={16} />}
                </button>
              ))}
            </>
          ) : (
            <dl className="office-shortcuts">
              <div>
                <dt>Move</dt>
                <dd>
                  <kbd>W</kbd>
                  <kbd>A</kbd>
                  <kbd>S</kbd>
                  <kbd>D</kbd>
                </dd>
              </div>
              <div>
                <dt>Interact</dt>
                <dd>
                  <kbd>E</kbd>
                </dd>
              </div>
              <div>
                <dt>Pan camera</dt>
                <dd>Drag</dd>
              </div>
              <div>
                <dt>Orbit camera</dt>
                <dd>Right-drag</dd>
              </div>
            </dl>
          )}
        </div>
      )}
    </div>
  );
}
