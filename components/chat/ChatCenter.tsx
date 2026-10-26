"use client";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  MessageSquare,
  Users,
  PanelRightClose,
  PanelRightOpen,
  Send,
  Plus,
  Search,
  ArrowLeft,
} from "lucide-react";
import { runtimeRequest, useStudio } from "@/lib/store";
import { useVoice } from "@/lib/voice/VoiceProvider";
import {
  OFFICE_GROUP,
  seatSessions,
  mergeConversationMessages,
  taskFilters,
  matchesTaskFilter,
  taskIsActive,
  taskPresentation,
} from "@/lib/conversations";
import type { ChatMessage, SessionRecord, TaskItem } from "@/types/game";
import CharacterPortrait from "@/components/hud/CharacterPortrait";
import { WorkRedirectNotice } from "@/components/ui/WorkRedirectNotice";
import ConversationEmpty from "./ConversationEmpty";
import MessageStream from "./MessageStream";
import PendingReviews from "@/components/hud/PendingReviews";
import VoiceSection from "./VoiceSection";
import SeatManagerModal from "@/components/hud/SeatManagerModal";
import TaskInspector from "./TaskInspector";
import TaskStatus from "@/components/ui/TaskStatus";
import "./chat-center.css";
const subscribePins = (notify: () => void) => {
  window.addEventListener("storage", notify);
  window.addEventListener("agent-town:pins-changed", notify);
  return () => {
    window.removeEventListener("storage", notify);
    window.removeEventListener("agent-town:pins-changed", notify);
  };
};
const readPins = () => {
  try {
    return localStorage.getItem("agent-town:pinned-conversations") ?? "[]";
  } catch {
    return "[]";
  }
};
const emptyPins = () => "[]";
const noMessages: ChatMessage[] = [];

export default function ChatCenter() {
  const studio = useStudio();
  const { state, loadSessionChat } = studio;
  const voice = useVoice();
  const params = useSearchParams();
  const router = useRouter();
  useEffect(() => {
    const open = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (typeof id !== "string" || !/^inventory_[A-Za-z0-9_-]+$/.test(id)) return;
      try {
        sessionStorage.setItem("agent-town:inventory:selected", id);
      } catch {}
      router.push("/app?panel=operations");
    };
    window.addEventListener("agent-town:open-investigation", open);
    return () => window.removeEventListener("agent-town:open-investigation", open);
  }, [router]);
  const [seatId, setSeatId] = useState(params.get("seat") ?? "group");
  const [session, setSession] = useState(params.get("session") ?? "");
  const [query, setQuery] = useState("");
  const [messageQuery, setMessageQuery] = useState("");
  const [view, setView] = useState<"chat" | "tasks">("chat");
  const [mobile, setMobile] = useState("conversation");
  const [inspector, setInspector] = useState(true);
  const [taskId, setTaskId] = useState("");
  const [filter, setFilter] = useState("All Tasks");
  const [taskAgent, setTaskAgent] = useState("");
  const [sort, setSort] = useState("newest");
  const [archivedTasks, setArchivedTasks] = useState<TaskItem[]>([]);
  const [taskOffset, setTaskOffset] = useState(0);
  const [moreTasks, setMoreTasks] = useState(true);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [sessionQuery, setSessionQuery] = useState("");
  const allTasks = useMemo(() => {
    const rows = new Map(archivedTasks.map((t) => [t.taskId, t]));
    for (const t of state.tasks) rows.set(t.taskId, t);
    return [...rows.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [archivedTasks, state.tasks]);
  const [manager, setManager] = useState(false);
  const [historyResult, setHistoryResult] = useState<{
    request: string;
    rows: ChatMessage[];
    error: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [taskError, setTaskError] = useState("");
  const [sending, setSending] = useState(false);
  const [reload, setReload] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const storedPins = useSyncExternalStore(subscribePins, readPins, emptyPins);
  const pinned = useMemo<string[]>(() => {
    try {
      const saved = JSON.parse(storedPins);
      return Array.isArray(saved) ? saved.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  }, [storedPins]);
  const lock = useRef(false);
  const pending = useRef<{ message: string; id: string } | null>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const seat = state.seats.find((s) => s.seatId === seatId && s.assigned);
  const group = seatId === "group";
  const sessions = seatSessions(state.sessions, seatId, seat?.binding?.agentId);
  const legacy =
    !group &&
    !!session &&
    !sessions.some((s) => s.key === session) &&
    allTasks.some((t) => t.seatId === seatId && t.sessionKey === session);
  const key = group
    ? OFFICE_GROUP
    : legacy
      ? session
      : sessions.some((s) => s.key === session)
        ? session
        : (sessions[0]?.key ?? "");
  const draftKey = group ? OFFICE_GROUP : `${seatId}:${key}`;
  const input = drafts[draftKey] ?? "";
  const historyRequest = JSON.stringify([key, group, reload, state.connection]);
  const history = historyResult?.request === historyRequest ? historyResult.rows : noMessages;
  const historyError = historyResult?.request === historyRequest ? historyResult.error : "";
  const loading = Boolean(key) && historyResult?.request !== historyRequest;
  const messages = mergeConversationMessages(key, history, state.chatMessages).filter(
    (m) =>
      !legacy ||
      m.seatId === seatId ||
      allTasks.some(
        (t) => t.seatId === seatId && (t.taskId === m.taskId || (t.runId && t.runId === m.runId)),
      ),
  );
  const display = messages.filter(
    (m) => !messageQuery || m.content.toLowerCase().includes(messageQuery.toLowerCase()),
  );
  const linkedTasks = allTasks.filter((t) =>
    group
      ? t.taskId.startsWith("grp_") || messages.some((m) => m.taskId === t.taskId)
      : t.seatId === seatId && t.sessionKey === key,
  );
  const selectedTask = allTasks.find((t) => t.taskId === taskId);
  const canSend =
    !legacy &&
    state.connection === "connected" &&
    state.capabilities?.["chat.send"]?.available &&
    (group
      ? state.seats.some((s) => s.assigned && s.binding?.available)
      : seat?.binding?.available);
  const reason = legacy
    ? "Historical shared session: only messages attributed to this seat are shown. Start a new dedicated conversation to reply."
    : state.connection !== "connected"
      ? "Gateway is not connected."
      : !state.seats.some((s) => s.assigned && s.binding?.available)
        ? "No executable agent is assigned. Configure your team in Agents."
        : (state.capabilities?.["chat.send"]?.reason ?? "Backend capability is being checked.");
  const blocked = sending || voice.active;
  useEffect(() => {
    if (!key) return;
    let valid = true;
    const request = group
      ? runtimeRequest<{ messages: ChatMessage[] }>("office-group").then((r) => r.messages)
      : loadSessionChat(key);
    request
      .then((rows) => {
        if (valid) setHistoryResult({ request: historyRequest, rows, error: "" });
      })
      .catch((e) => {
        if (valid) setHistoryResult({ request: historyRequest, rows: [], error: e.message });
      });
    return () => {
      valid = false;
    };
  }, [key, group, loadSessionChat, historyRequest]);
  useEffect(() => {
    if (follow.current) historyRef.current?.scrollTo({ top: historyRef.current.scrollHeight });
  }, [messages]);
  const select = (id: string, sessionKey = "") => {
    if (blocked) return;
    setSeatId(id);
    setSession(sessionKey);
    setTaskId("");
    setError("");
    setMessageQuery("");
    setView("chat");
    setMobile("conversation");
    follow.current = true;
    window.history.pushState(
      null,
      "",
      `/app/chat?seat=${encodeURIComponent(id)}${sessionKey ? `&session=${encodeURIComponent(sessionKey)}` : ""}`,
    );
  };
  useEffect(() => {
    const restore = () => {
      if (voice.active || lock.current) return;
      const location = new URLSearchParams(window.location.search);
      setSeatId(location.get("seat") ?? "group");
      setSession(location.get("session") ?? "");
      setTaskId("");
      setError("");
      setMessageQuery("");
      setView("chat");
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [voice.active]);
  const create = async () => {
    if (!seat || lock.current || voice.active) return;
    lock.current = true;
    setSending(true);
    setError("");
    try {
      const { session: s } = await runtimeRequest<{ session: SessionRecord }>("sessions", {
        seatId,
      });
      await studio.reconcile();
      setSession(s.key);
      window.history.pushState(
        null,
        "",
        `/app/chat?seat=${encodeURIComponent(seatId)}&session=${encodeURIComponent(s.key)}`,
      );
      await studio.switchSession(s.key);
      return s.key;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Conversation could not be created");
    } finally {
      lock.current = false;
      setSending(false);
    }
  };
  const send = async () => {
    const text = input.trim();
    if (!text || !canSend || lock.current || voice.active) return;
    lock.current = true;
    setSending(true);
    setError("");
    try {
      if (group) {
        if (pending.current?.message !== text)
          pending.current = { message: text, id: crypto.randomUUID().replaceAll("-", "") };
        await runtimeRequest("office-group", { turnId: pending.current.id, message: text });
        pending.current = null;
      } else if (seat) {
        let target = key;
        if (!target) {
          const r = await runtimeRequest<{ session: SessionRecord }>("sessions", { seatId });
          target = r.session.key;
          await studio.reconcile();
          setSession(target);
          window.history.pushState(
            null,
            "",
            `/app/chat?seat=${encodeURIComponent(seatId)}&session=${encodeURIComponent(target)}`,
          );
          setDrafts((d) => ({ ...d, [`${seatId}:${target}`]: text }));
        }
        let redirected = false;
        const id = await studio.assignTask(text, seatId, {
          sessionKey: target,
          onRedirect: () => {
            redirected = true;
          },
        });
        if (!id && !redirected)
          throw Error(
            "Task was not confirmed. Your draft is preserved; check runtime diagnostics and retry.",
          );
        setDrafts((d) => ({ ...d, [`${seatId}:${target}`]: "" }));
      }
      setDrafts((d) => ({ ...d, [draftKey]: "" }));
      follow.current = true;
      setReload((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Message could not be sent");
    } finally {
      lock.current = false;
      setSending(false);
    }
  };
  const startVoice = async () => {
    if (!seat || voice.active || !key || lock.current) return;
    lock.current = true;
    setSending(true);
    setError("");
    try {
      await studio.switchSession(key);
      await voice.selectAgent(seatId);
      voice.setMode("voice");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Voice selection failed");
    } finally {
      lock.current = false;
      setSending(false);
    }
  };
  const openTask = (task: TaskItem) => {
    if (blocked) return;
    if (task.taskId.startsWith("grp_")) {
      if (!group) select("group");
    } else if (task.seatId && (seatId !== task.seatId || key !== task.sessionKey)) {
      select(task.seatId, task.sessionKey);
    }
    setTaskId(task.taskId);
    setInspector(true);
    setMobile("inspector");
  };
  const targetTask = selectedTask ?? linkedTasks.find(taskIsActive) ?? linkedTasks[0];
  const tasks = allTasks.filter(
    (t) =>
      matchesTaskFilter(t, filter) &&
      (!taskAgent || t.seatId === taskAgent) &&
      (!query ||
        `${t.message} ${t.actorName} ${t.status}`.toLowerCase().includes(query.toLowerCase())),
  );
  const loadOlderTasks = async () => {
    if (loadingTasks) return;
    setLoadingTasks(true);
    setTaskError("");
    try {
      const result = await runtimeRequest<{ tasks: TaskItem[]; nextOffset: number }>(
        `tasks?limit=100&offset=${taskOffset}`,
      );
      setArchivedTasks((old) => [...old, ...result.tasks]);
      setTaskOffset(result.nextOffset);
      setMoreTasks(result.tasks.length === 100);
    } catch (e) {
      setTaskError(e instanceof Error ? e.message : "Task history unavailable");
    } finally {
      setLoadingTasks(false);
    }
  };
  const pin = () => {
    const next = pinned.includes(draftKey)
      ? pinned.filter((p) => p !== draftKey)
      : [...pinned, draftKey];
    try {
      localStorage.setItem("agent-town:pinned-conversations", JSON.stringify(next));
      window.dispatchEvent(new Event("agent-town:pins-changed"));
    } catch {
      setError("Could not save pinned conversations in this browser.");
    }
  };
  return (
    <main
      className={`office-app chat-center ${inspector ? "" : "chat-center--wide"}`}
      data-mobile={mobile}
    >
      <header className="center-nav">
        <Link href={`/app?seat=${encodeURIComponent(seatId)}&session=${encodeURIComponent(key)}`}>
          <ArrowLeft size={16} /> Office
        </Link>
        <strong aria-current="page">
          <MessageSquare size={18} /> Chat & Tasks
        </strong>
        <nav>
          <button onClick={() => setManager(true)}>Agents</button>
          <Link href="/app?panel=operations">Operations</Link>
          <PendingReviews />
        </nav>
      </header>
      <div className="center-mobile-nav">
        {["directory", "conversation", "inspector"].map((tab) => (
          <button
            key={tab}
            aria-pressed={mobile === tab}
            onClick={() => {
              setMobile(tab);
              if (tab === "inspector") setInspector(true);
            }}
          >
            {tab}
          </button>
        ))}
      </div>
      <aside className="center-directory">
        <div className="center-eyebrow">Workspace</div>
        <label className="center-search">
          <Search size={15} />
          <input
            aria-label="Search conversations and tasks"
            placeholder="Search team or tasks"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button
          className={`center-conversation ${group ? "is-active" : ""}`}
          disabled={blocked}
          onClick={() => select("group")}
        >
          <Users size={20} />
          <span>
            <strong>Office Group</strong>
            <small>Shared team conversation</small>
          </span>
        </button>
        <div className="center-section-title">
          Your team <span>{state.seats.filter((s) => s.assigned).length}</span>
        </div>
        {state.seats
          .filter(
            (s) =>
              s.assigned && `${s.label} ${s.roleTitle}`.toLowerCase().includes(query.toLowerCase()),
          )
          .map((s) => (
            <button
              disabled={blocked}
              className={`center-conversation ${seatId === s.seatId ? "is-active" : ""}`}
              key={s.seatId}
              onClick={() => select(s.seatId)}
            >
              <div className="center-portrait">
                <CharacterPortrait spritePath={s.spritePath} name={s.label} />
              </div>
              <span>
                <strong>{s.label}</strong>
                <small>
                  {s.roleTitle ?? "Worker"} ·{" "}
                  {state.connection !== "connected"
                    ? "Offline"
                    : s.binding?.available
                      ? s.status === "running"
                        ? "Working"
                        : "Available"
                      : "Setup required"}
                </small>
              </span>
            </button>
          ))}
        {!group && (
          <>
            <button
              className="pixel-button center-new"
              disabled={blocked || !seat?.binding?.available}
              onClick={() => void create()}
            >
              <Plus size={15} /> New conversation
            </button>
            <div className="center-section-title">Conversation history</div>
            <label className="center-search">
              <Search size={14} />
              <input
                aria-label="Search conversations"
                placeholder="Search saved conversations"
                value={sessionQuery}
                onChange={(e) => setSessionQuery(e.target.value)}
              />
            </label>
            {[...sessions]
              .filter((s) =>
                `${s.label ?? ""} ${s.key} ${new Date(s.createdAt).toLocaleString()} ${allTasks
                  .filter((t) => t.sessionKey === s.key)
                  .map((t) => t.message)
                  .join(" ")}`
                  .toLowerCase()
                  .includes(sessionQuery.toLowerCase()),
              )
              .sort(
                (a, b) =>
                  Number(pinned.includes(`${seatId}:${b.key}`)) -
                  Number(pinned.includes(`${seatId}:${a.key}`)),
              )
              .map((s) => (
                <button
                  className={`center-history-item ${key === s.key ? "is-active" : ""}`}
                  key={s.key}
                  disabled={blocked}
                  onClick={() => select(seatId, s.key)}
                >
                  {pinned.includes(`${seatId}:${s.key}`) ? "★ " : ""}
                  {s.label ??
                    allTasks
                      .filter((t) => t.sessionKey === s.key && t.seatId === seatId)
                      .at(-1)
                      ?.message.slice(0, 64) ??
                    "New conversation"}
                  <small>{new Date(s.createdAt).toLocaleString()}</small>
                  <small>
                    {allTasks.filter((t) => t.sessionKey === s.key && t.seatId === seatId).length}{" "}
                    loaded tasks
                  </small>
                </button>
              ))}
            {!sessions.length && (
              <p>No dedicated conversation yet. Sending your first message creates one.</p>
            )}
          </>
        )}
        <div className="center-section-title">Recent tasks</div>
        {state.tasks.slice(0, 5).map((t) => (
          <button className="center-history-item" key={t.taskId} onClick={() => openTask(t)}>
            {taskPresentation(t).title}
            <small>
              {t.actorName} · {t.status.replaceAll("_", " ")}
            </small>
          </button>
        ))}
        <p className="center-muted">
          Rename, archive and attachments are not supported by the current runtime. Pins are saved
          on this device.
        </p>
      </aside>
      <section className="center-main">
        <header className="center-conversation-header">
          <div>
            <div className="center-eyebrow">
              {view === "tasks"
                ? "Execution overview"
                : group
                  ? "Team channel"
                  : `Individual · ${seat?.binding?.agentId ?? "unbound"}`}
            </div>
            <h1>
              {view === "tasks"
                ? "Task center"
                : group
                  ? "Office Group"
                  : (seat?.label ?? "Choose an agent")}
            </h1>
            <p>
              {group
                ? "Shared conversation · contributions are attributed to each teammate."
                : seat?.seatType === "worker"
                  ? legacy
                    ? "Saved history · start a dedicated conversation to reply."
                    : "Dedicated conversation with your team member."
                  : seat?.roleTitle}
            </p>
          </div>
          <button
            className="pixel-button"
            aria-label="Toggle task inspector"
            onClick={() => setInspector((v) => !v)}
          >
            {inspector ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
          </button>
        </header>
        <div className="center-tabs">
          <button aria-pressed={view === "chat"} onClick={() => setView("chat")}>
            Conversation
          </button>
          <button aria-pressed={view === "tasks"} onClick={() => setView("tasks")}>
            All tasks <span>{allTasks.length} loaded</span>
          </button>
          <button onClick={pin} disabled={!key}>
            {pinned.includes(draftKey) ? "Unpin" : "Pin"}
          </button>
        </div>
        {voice.active && (
          <div className="center-banner">
            Call with {voice.agent?.label} · {voice.status}. End the call before changing
            conversations.<button onClick={voice.stop}>End call</button>
          </div>
        )}
        {view === "tasks" ? (
          <div className="center-task-list">
            <div className="center-filters">
              <label>
                Status{" "}
                <select value={filter} onChange={(e) => setFilter(e.target.value)}>
                  {taskFilters.map((f) => (
                    <option key={f}>{f}</option>
                  ))}
                </select>
              </label>
              <label>
                {" "}
                Agent{" "}
                <select
                  aria-label="Filter tasks by agent"
                  value={taskAgent}
                  onChange={(e) => setTaskAgent(e.target.value)}
                >
                  <option value="">All agents</option>
                  {state.seats
                    .filter((s) => s.assigned)
                    .map((s) => (
                      <option key={s.seatId} value={s.seatId}>
                        {s.label}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Sort
                <select
                  aria-label="Sort tasks"
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                >
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                </select>
              </label>
            </div>
            {taskError && <p role="alert">{taskError}</p>}
            <p className="center-muted">
              Showing {tasks.length} of {allTasks.length} loaded tasks. Filters and sorting apply to
              loaded records.
            </p>
            {(sort === "oldest" ? [...tasks].reverse() : tasks).map((t) => (
              <button className="center-task-card" key={t.taskId} onClick={() => openTask(t)}>
                <TaskStatus status={t.status} />
                <strong>{taskPresentation(t).title}</strong>
                {t.result && <span className="task-preview">{t.result.slice(0, 220)}</span>}
                <small>
                  {t.actorName ?? t.agentId} · {new Date(t.createdAt).toLocaleString()}
                </small>
              </button>
            ))}
            {!tasks.length && <p>No matching tasks reported by the runtime.</p>}
            {moreTasks && (
              <button
                className="pixel-button center-new"
                disabled={loadingTasks}
                onClick={() => void loadOlderTasks()}
              >
                {loadingTasks ? "Loading…" : "Load more saved tasks"}
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="center-history-tools">
              <input
                aria-label="Search message history"
                placeholder="Search this conversation"
                value={messageQuery}
                onChange={(e) => setMessageQuery(e.target.value)}
              />
              {messageQuery && (
                <>
                  <span className="center-match-count" role="status">
                    {display.length} matches
                  </span>
                  <button onClick={() => setMessageQuery("")}>Clear</button>
                </>
              )}
              <button disabled={loading} onClick={() => setReload((n) => n + 1)}>
                {loading ? "Refreshing…" : "Refresh history"}
              </button>
            </div>
            <div
              className="center-messages"
              ref={historyRef}
              onScroll={(e) => {
                const el = e.currentTarget;
                follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
              }}
              aria-label="Conversation messages"
              aria-busy={loading}
            >
              {loading && <p role="status">Loading saved history…</p>}
              {!loading && !display.length && (
                <ConversationEmpty
                  name={group ? "Office Group" : (seat?.label ?? "Agent")}
                  spritePath={seat?.spritePath}
                  group={group}
                  query={messageQuery}
                  error={historyError}
                  onRetry={() => setReload((n) => n + 1)}
                  onClear={() => setMessageQuery("")}
                  onCompose={() => document.getElementById("center-draft")?.focus()}
                />
              )}
              {historyError && display.length > 0 && (
                <div role="alert" className="center-banner">
                  History refresh failed: {historyError}. Showing available messages.
                  <button onClick={() => setReload((n) => n + 1)}>Retry history</button>
                </div>
              )}
              <WorkRedirectNotice redirect={state.workRedirect} />
              <MessageStream
                messages={display}
                seats={state.seats}
                tasks={allTasks}
                onInspect={openTask}
              />
            </div>
            <footer className="center-composer">
              {(error || !canSend) && (
                <div role="status" className="center-banner">
                  {error || reason}
                </div>
              )}
              <label htmlFor="center-draft">
                {group ? "Message Office Group" : `Message ${seat?.label ?? "selected agent"}`}
              </label>
              <textarea
                id="center-draft"
                maxLength={32000}
                value={input}
                disabled={sending}
                placeholder={
                  group
                    ? "Share a brief with the office…"
                    : `Message ${seat?.label ?? "your agent"} or describe a task…`
                }
                onChange={(e) => setDrafts((d) => ({ ...d, [draftKey]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <div>
                <small>Enter to send · Shift + Enter for a new line</small>
                <button
                  className="pixel-button pixel-button--primary"
                  disabled={!canSend || blocked || !input.trim()}
                  onClick={() => void send()}
                >
                  <Send size={15} />
                  {sending ? "Sending…" : error ? "Retry message" : "Send message"}
                </button>
              </div>
            </footer>
          </>
        )}
      </section>
      {inspector && (
        <aside className="center-inspector">
          <div className="center-eyebrow">Context & execution</div>
          {group && (
            <div className="center-group-context">
              <h2>Office Group</h2>
              <p>
                {
                  new Set(
                    messages
                      .filter((m) => m.role === "assistant" && m.actorName)
                      .map((m) => m.actorName),
                  ).size
                }{" "}
                contributors in this history
              </p>
              <div>
                {[
                  ...new Set(
                    messages
                      .filter((m) => m.role === "assistant" && m.actorName)
                      .map((m) => m.actorName),
                  ),
                ].map((name) => (
                  <span key={name}>{name}</span>
                ))}
              </div>
            </div>
          )}
          {seat && (
            <div className="center-agent">
              <div className="center-portrait">
                <CharacterPortrait spritePath={seat.spritePath} name={seat.label} />
              </div>
              <div>
                <h2>{seat.label}</h2>
                <p>
                  {seat.roleTitle} ·{" "}
                  {state.connection !== "connected"
                    ? "Offline"
                    : seat.binding?.available
                      ? "Connected"
                      : "Setup required"}
                </p>
              </div>
            </div>
          )}
          <Link
            className="center-office-link"
            href={`/app?seat=${encodeURIComponent(seatId)}&session=${encodeURIComponent(key)}`}
          >
            Open in Office ↗
          </Link>
          <VoiceSection
            group={group}
            seat={seat}
            sessionKey={key}
            canSend={canSend}
            blocked={blocked}
            expanded={!targetTask}
            onPrepare={startVoice}
          />
          {targetTask ? (
            <TaskInspector
              key={targetTask.taskId}
              task={targetTask}
              onConversation={() => {
                if (blocked) return;
                if (targetTask.taskId.startsWith("grp_")) select("group");
                else if (targetTask.seatId) select(targetTask.seatId, targetTask.sessionKey);
              }}
              onRetry={() => {
                if (blocked || !targetTask.seatId) return;
                if (targetTask.taskId.startsWith("grp_")) {
                  select("group");
                  setDrafts((d) => ({
                    ...d,
                    [OFFICE_GROUP]: taskPresentation(targetTask).request,
                  }));
                  return;
                }
                const owner = state.seats.find((s) => s.seatId === targetTask.seatId);
                const owned = seatSessions(
                  state.sessions,
                  targetTask.seatId,
                  owner?.binding?.agentId,
                );
                const retrySession = owned.some((s) => s.key === targetTask.sessionKey)
                  ? targetTask.sessionKey
                  : (owned[0]?.key ?? "");
                select(targetTask.seatId, retrySession);
                setDrafts((d) => ({
                  ...d,
                  [`${targetTask.seatId}:${retrySession}`]: targetTask.message,
                }));
              }}
            />
          ) : (
            <div className="center-empty">
              <h3>No task selected</h3>
              <p>Select a task to inspect its actual lifecycle and result.</p>
            </div>
          )}
          {state.runtimeError && (
            <details>
              <summary>Runtime diagnostic</summary>
              <p>{state.runtimeError}</p>
            </details>
          )}
        </aside>
      )}
      <SeatManagerModal open={manager} seats={state.seats} onClose={() => setManager(false)} />
    </main>
  );
}
