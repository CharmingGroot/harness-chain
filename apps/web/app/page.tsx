"use client";

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { ReactFlow, Handle, Position, MarkerType } from "@xyflow/react";
import type { Node as RFNode, Edge as RFEdge, NodeProps } from "@xyflow/react";
import type { AnalyzeEvent } from "@/lib/types";
import { renderMarkdown } from "@/lib/markdown";
import { useJob, STEP_LABELS, getStepProgress } from "./job-context";
import type { JobStep, JobEvent } from "./job-context";

// ── Types ──────────────────────────────────────────────────────────────────────

interface Source { id: string; name: string; type: string; description: string; status: string; }
interface Tool { id: string; name: string; category: string; description: string; comingSoon?: boolean; }
interface SubAgent { id: string; name: string; description: string; tools: string[]; systemPrompt: string; skills?: string; rules?: string; model: string; createdAt: string; }
interface HarnessNode {
  id: string; kind: "subagent" | "tool" | "source"; ref: string; label?: string;
}
type HarnessStep = HarnessNode;
interface HarnessEdge {
  id: string; from: string; to: string; label?: string; condition?: string;
}
interface RealHarness {
  id: string; name: string; description: string;
  schedule: { type: "once" | "cron"; cron?: string };
  nodes: HarnessNode[];
  edges: HarnessEdge[];
  createdAt: string; updatedAt: string;
  runs?: { id: string; status: string; startedAt: string; completedAt?: string; durationMs?: number }[];
}
interface Registry { sources: Source[]; tools: Tool[]; subAgents: SubAgent[]; }
interface Session { id: string; name: string; createdAt: string; }
type LogEntry =
  | { kind: "source_check"; message: string }
  | { kind: "source_selected"; sources: string[] }
  | { kind: "tool_call"; tool: string; input: string }
  | { kind: "tool_result"; tool: string; success: boolean; preview: string }
  | { kind: "thinking"; text: string }
  | { kind: "error"; message: string };
type PaletteItem =
  | { kind: "harness"; id: string; name: string; description: string }
  | { kind: "tool"; id: string; name: string; description: string }
  | { kind: "subagent"; id: string; name: string; description: string };
interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  logs?: LogEntry[];
  status?: "streaming" | "done" | "error";
  createdAt: string;
  attachedItems?: PaletteItem[];
}
type NavTab = "chat" | "sources" | "tools" | "subagents" | "harnesses" | "observability";

function eventToLogEntry(event: AnalyzeEvent): LogEntry | null {
  if (event.type === "source_check") return { kind: "source_check", message: event.message };
  if (event.type === "source_selected") return { kind: "source_selected", sources: event.sources };
  if (event.type === "tool_call") return { kind: "tool_call", tool: event.tool, input: event.input };
  if (event.type === "tool_result") return { kind: "tool_result", tool: event.tool, success: event.success, preview: event.preview };
  if (event.type === "thinking") return { kind: "thinking", text: event.text };
  if (event.type === "error") return { kind: "error", message: event.message };
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function Home() {
  const [mounted, setMounted] = useState(false);
  const [registry, setRegistry] = useState<Registry>({ sources: [], tools: [], subAgents: [] });
  const [harnesses, setHarnesses] = useState<RealHarness[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  // messages keyed by sessionId
  const [sessionMessages, setSessionMessages] = useState<Record<string, ChatMessage[]>>({});
  const [navTab, setNavTab] = useState<NavTab>("chat");
  const [rightOpen, setRightOpen] = useState(false);
  const [globalModel, setGlobalModel] = useState("gpt-4.1-mini");
  // aggregated running tool/log state for right panel (across all sessions)
  const [runningLogs, setRunningLogs] = useState<{ sessionId: string; msgId: string; logs: LogEntry[] }[]>([]);

  // Load sessions & messages from localStorage — runs only on client after hydration
  useEffect(() => {
    setMounted(true);
    try {
      const savedSessions = localStorage.getItem("hc_sessions");
      if (savedSessions) {
        const parsed: Session[] = JSON.parse(savedSessions);
        if (parsed.length > 0) {
          setSessions(parsed);
          setActiveSessionId(parsed[0].id);
          // Load messages for each session
          // Reset any "streaming" messages to "error" — the SSE stream is gone after reload
          const msgs: Record<string, ChatMessage[]> = {};
          for (const s of parsed) {
            const saved = localStorage.getItem(`hc_msgs_${s.id}`);
            if (saved) {
              const parsed2: ChatMessage[] = JSON.parse(saved);
              msgs[s.id] = parsed2.map(m =>
                m.status === "streaming" ? { ...m, status: "error", content: m.content || "연결이 끊겼습니다." } : m
              );
            }
          }
          setSessionMessages(msgs);
        }
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (sessions.length > 0) localStorage.setItem("hc_sessions", JSON.stringify(sessions));
  }, [sessions]);

  const saveMessages = useCallback((sessionId: string, messages: ChatMessage[]) => {
    localStorage.setItem(`hc_msgs_${sessionId}`, JSON.stringify(messages));
    setSessionMessages(prev => ({ ...prev, [sessionId]: messages }));
  }, []);

  const refreshAll = useCallback(async (signal?: AbortSignal) => {
    if (signal?.aborted) return;
    const opts = signal ? { signal } : undefined;
    try {
      const [reg, hns] = await Promise.all([
        fetch("/api/registry", opts).then(r => r.json()),
        fetch("/api/harnesses", opts).then(r => r.json()),
      ]);
      if (!signal?.aborted) {
        setRegistry(reg);
        setHarnesses(hns);
      }
    } catch {
      // silently ignore: aborted on unmount or temporary unavailability during HMR
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    refreshAll(controller.signal);
    return () => controller.abort();
  }, [refreshAll]);

  const createSession = (name?: string): string => {
    const id = `sess_${Date.now()}`;
    const session: Session = { id, name: name ?? `세션 ${sessions.length + 1}`, createdAt: new Date().toISOString() };
    setSessions(prev => [...prev, session]);
    setActiveSessionId(id);
    setNavTab("chat");
    return id;
  };

  const deleteSession = (id: string) => {
    setSessions(prev => prev.filter(s => s.id !== id));
    localStorage.removeItem(`hc_msgs_${id}`);
    setSessionMessages(prev => { const next = { ...prev }; delete next[id]; return next; });
    if (activeSessionId === id) setActiveSessionId(sessions.find(s => s.id !== id)?.id ?? null);
  };

  const streamQuery = async (sessionId: string, userText: string, attachedItems?: PaletteItem[], model?: string) => {
    const userMsgId = `msg_${Date.now()}`;
    const asstMsgId = `msg_${Date.now() + 1}`;
    const userMsg: ChatMessage = { id: userMsgId, role: "user", content: userText, attachedItems, createdAt: new Date().toISOString() };
    const asstMsg: ChatMessage = { id: asstMsgId, role: "assistant", content: "", logs: [], status: "streaming", attachedItems, createdAt: new Date().toISOString() };

    const prevMsgs = sessionMessages[sessionId] ?? [];
    const withUser = [...prevMsgs, userMsg, asstMsg];
    saveMessages(sessionId, withUser);
    setRightOpen(true);

    const update = (updater: (msg: ChatMessage) => ChatMessage) => {
      setSessionMessages(prev => {
        const msgs = prev[sessionId] ?? [];
        const updated = msgs.map(m => m.id === asstMsgId ? updater(m) : m);
        localStorage.setItem(`hc_msgs_${sessionId}`, JSON.stringify(updated));
        return { ...prev, [sessionId]: updated };
      });
    };

    try {
      const res = await fetch("/api/analyze", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: userText, model: model ?? globalModel }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: `서버 오류 (${res.status})` }));
        throw new Error(errBody.error ?? `서버 오류 (${res.status})`);
      }
      if (!res.body) throw new Error("No response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6)) as AnalyzeEvent;
            if (event.type === "report") {
              update(m => ({ ...m, content: event.report, status: "done" }));
            } else {
              const entry = eventToLogEntry(event);
              if (entry) update(m => ({ ...m, logs: [...(m.logs ?? []), entry] }));
            }
          } catch { /* ignore */ }
        }
      }
      // If stream ended without a report event, finalize
      update(m => m.status === "streaming" ? { ...m, status: "error", content: "응답을 받지 못했습니다." } : m);
    } catch (err) {
      update(m => ({ ...m, status: "error", content: err instanceof Error ? err.message : String(err) }));
    }
  };

  const runHarnessInSession = useCallback((harness: RealHarness) => {
    const sid = activeSessionId ?? createSession(harness.name);
    if (activeSessionId) {
      setActiveSessionId(sid);
      setNavTab("chat");
    }
    const prompt = `하네스 '${harness.name}'를 실행해줘.\n목표: ${harness.description}`;
    const attached: PaletteItem[] = [{ kind: "harness", id: harness.id, name: harness.name, description: harness.description }];
    setTimeout(() => streamQuery(sid, prompt, attached, globalModel), 0);
  }, [activeSessionId, globalModel]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeMessages = activeSessionId ? (sessionMessages[activeSessionId] ?? []) : [];
  const streamingCount = Object.values(sessionMessages).flat().filter(m => m.status === "streaming").length;

  // Render a blank shell on the server to avoid hydration mismatch
  if (!mounted) {
    return <div className="flex flex-col h-screen" style={{ background: "var(--content-bg)" }} />;
  };

  return (
    <div className="flex flex-col h-screen" style={{ background: "var(--content-bg)" }}>

      {/* ── Top Header ── */}
      <header className="flex-none flex items-center gap-0 px-4 h-11 z-10"
        style={{ background: "var(--sidebar-bg)", borderBottom: "1px solid var(--sidebar-border)" }}>
        <div className="flex items-center gap-2 pr-5 mr-2" style={{ borderRight: "1px solid var(--border)" }}>
          <span className="text-base">⛓️</span>
          <span className="font-semibold text-[13px]" style={{ color: "var(--text-primary)" }}>HarnessChain</span>
        </div>
        <div className="flex items-center gap-0.5">
          {(["chat", "sources", "tools", "subagents", "harnesses", "observability"] as NavTab[]).map(tab => {
            const labels: Record<NavTab, string> = {
              chat: "대화", sources: "소스", tools: "도구",
              subagents: "서브에이전트", harnesses: "하네스", observability: "실행 현황",
            };
            return (
              <button key={tab} onClick={() => setNavTab(tab)}
                className="px-3 py-1 rounded text-[12.5px]"
                style={{
                  background: navTab === tab ? "var(--active-bg)" : "transparent",
                  color: navTab === tab ? "var(--accent)" : "var(--text-secondary)",
                  fontWeight: navTab === tab ? 500 : 400,
                }}>
                {labels[tab]}
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <select
            value={globalModel}
            onChange={e => setGlobalModel(e.target.value)}
            className="text-[12px] px-2 py-1 rounded outline-none"
            style={{ border: "1px solid var(--border)", background: "var(--sidebar-bg)", color: "var(--text-primary)", maxWidth: 160 }}>
            {CHAT_MODELS.map(m => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
          <button onClick={() => setRightOpen(o => !o)}
            className="px-2.5 py-1 rounded text-[12px] flex items-center gap-1"
            style={{ border: "1px solid var(--border)", color: streamingCount > 0 ? "var(--accent)" : "var(--text-tertiary)", background: rightOpen ? "var(--active-bg)" : "transparent" }}>
            ▣
            {streamingCount > 0 && <span className="text-[11px] font-medium" style={{ color: "var(--accent)" }}>{streamingCount}</span>}
          </button>
        </div>
      </header>

      {/* ── Body ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Left Sidebar: Sessions ── */}
        <aside className="flex-none w-52 flex flex-col overflow-hidden"
          style={{ background: "var(--sidebar-bg)", borderRight: "1px solid var(--sidebar-border)" }}>
          <div className="px-3 pt-3 pb-2 flex items-center justify-between">
            <span className="text-[10.5px] font-medium uppercase tracking-wider" style={{ color: "var(--text-tertiary)" }}>세션</span>
            <button onClick={() => createSession()}
              className="text-[11px] px-2 py-0.5 rounded"
              style={{ background: "var(--active-bg)", color: "var(--accent)" }}>
              + 새 세션
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-2 pb-4 space-y-0.5">
            {sessions.length === 0 ? (
              <div className="px-2 py-6 text-center">
                <p className="text-[11.5px] leading-relaxed" style={{ color: "var(--text-tertiary)" }}>
                  세션을 만들어<br />대화를 시작하세요
                </p>
                <button onClick={() => createSession()}
                  className="mt-3 px-3 py-1.5 rounded-lg text-[12px] font-medium"
                  style={{ background: "var(--accent)", color: "white" }}>
                  세션 만들기
                </button>
              </div>
            ) : sessions.map(s => {
              const msgs = sessionMessages[s.id] ?? [];
              const isStreaming = msgs.some(m => m.status === "streaming");
              const lastMsg = msgs.filter(m => m.role === "user").at(-1);
              return (
                <SessionItem
                  key={s.id}
                  session={s}
                  active={activeSessionId === s.id}
                  isStreaming={isStreaming}
                  preview={lastMsg?.content.slice(0, 28)}
                  onClick={() => { setActiveSessionId(s.id); setNavTab("chat"); }}
                  onDelete={() => deleteSession(s.id)}
                />
              );
            })}
          </div>
        </aside>

        {/* ── Main Content ── */}
        <main className="flex-1 flex flex-col overflow-hidden">
          {navTab === "chat" && (
            activeSessionId
              ? <ChatView
                  key={activeSessionId}
                  sessionId={activeSessionId}
                  messages={activeMessages}
                  harnesses={harnesses}
                  registry={registry}
                  model={globalModel}
                  onModelChange={setGlobalModel}
                  onSend={(text, items) => streamQuery(activeSessionId, text, items)}
                />
              : <NoChatState onCreateSession={createSession} />
          )}
          {navTab === "sources" && <SourcesTab />}
          {navTab === "tools" && <ToolsTab />}
          {navTab === "subagents" && <SubAgentsTab subAgents={registry.subAgents} tools={registry.tools} onSaved={refreshAll} />}
          {navTab === "harnesses" && (
            <HarnessesTab
              harnesses={harnesses}
              registry={registry}
              model={globalModel}
              onSaved={async () => { await refreshAll(); setNavTab("chat"); }}
              onNavigate={setNavTab}
              onRunInSession={runHarnessInSession}
            />
          )}
          {navTab === "observability" && <ObservabilityTab />}
        </main>

        {/* ── Right Panel: Runtime Monitor ── */}
        {rightOpen && (
          <aside className="flex-none w-72 flex flex-col overflow-hidden"
            style={{ background: "var(--sidebar-bg)", borderLeft: "1px solid var(--sidebar-border)" }}>
            <div className="px-4 pt-3 pb-2 flex items-center justify-between flex-none"
              style={{ borderBottom: "1px solid var(--border)" }}>
              <span className="text-[11px] font-medium uppercase tracking-wider" style={{ color: "var(--text-tertiary)" }}>실행 모니터</span>
              <div className="flex items-center gap-2">
                {streamingCount > 0 && (
                  <span className="text-[11px] px-1.5 py-0.5 rounded-full font-medium"
                    style={{ background: "var(--accent-light)", color: "var(--accent)" }}>
                    {streamingCount} 진행 중
                  </span>
                )}
                <button onClick={() => setRightOpen(false)} className="text-[12px]" style={{ color: "var(--text-tertiary)" }}>✕</button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-3">
              {/* Show all assistant messages that are streaming or have logs */}
              {Object.entries(sessionMessages).flatMap(([sessId, msgs]) =>
                msgs
                  .filter(m => m.role === "assistant" && ((m.logs?.length ?? 0) > 0 || m.status === "streaming"))
                  .map(m => (
                    <MonitorCard
                      key={m.id}
                      message={m}
                      sessionName={sessions.find(s => s.id === sessId)?.name ?? sessId}
                      harnesses={harnesses}
                    />
                  ))
              ).reverse().slice(0, 10)}
              {Object.values(sessionMessages).flat().filter(m => m.role === "assistant" && (m.logs?.length ?? 0) > 0).length === 0 && (
                <div className="py-10 text-center text-[12px]" style={{ color: "var(--text-tertiary)" }}>
                  실행 중인 작업이 없습니다
                </div>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

// ── Session Item ───────────────────────────────────────────────────────────────

function SessionItem({ session, active, isStreaming, preview, onClick, onDelete }: {
  session: Session; active: boolean; isStreaming: boolean;
  preview?: string; onClick: () => void; onDelete: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      className="flex items-start gap-2 px-2 py-2 rounded cursor-pointer"
      style={{ background: active ? "var(--active-bg)" : hover ? "var(--hover-bg)" : "transparent" }}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}>
      <span className="text-[10px] mt-0.5 flex-none" style={{ color: isStreaming ? "var(--accent)" : "var(--text-tertiary)" }}>
        {isStreaming ? "●" : "○"}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] truncate" style={{ color: active ? "var(--accent)" : "var(--text-primary)", fontWeight: active ? 500 : 400 }}>
          {session.name}
        </div>
        {preview && (
          <div className="text-[11px] truncate mt-0.5" style={{ color: "var(--text-tertiary)" }}>{preview}</div>
        )}
      </div>
      {hover && !isStreaming && (
        <button onClick={e => { e.stopPropagation(); onDelete(); }}
          className="flex-none text-[11px] opacity-50 hover:opacity-100"
          style={{ color: "var(--text-tertiary)" }}>✕</button>
      )}
    </div>
  );
}

// ── Chat View ─────────────────────────────────────────────────────────────────

const CHAT_MODELS = [
  // Claude 4.x
  { id: "claude-opus-4-6",              label: "Claude Opus 4.6",       provider: "Anthropic" },
  { id: "claude-sonnet-4-6",            label: "Claude Sonnet 4.6",     provider: "Anthropic" },
  { id: "claude-haiku-4-5-20251001",    label: "Claude Haiku 4.5",      provider: "Anthropic" },
  // Claude 3.x
  { id: "claude-3-5-sonnet-20241022",   label: "Claude 3.5 Sonnet",     provider: "Anthropic" },
  { id: "claude-3-5-haiku-20241022",    label: "Claude 3.5 Haiku",      provider: "Anthropic" },
  { id: "claude-3-opus-20240229",       label: "Claude 3 Opus",         provider: "Anthropic" },
  { id: "claude-3-sonnet-20240229",     label: "Claude 3 Sonnet",       provider: "Anthropic" },
  { id: "claude-3-haiku-20240307",      label: "Claude 3 Haiku",        provider: "Anthropic" },
  // OpenAI
  { id: "gpt-4.1-mini",                 label: "GPT-4.1 mini",           provider: "OpenAI" },
  { id: "gpt-4o",                       label: "GPT-4o",                 provider: "OpenAI" },
  { id: "gpt-4o-mini",                   label: "GPT-4o mini",            provider: "OpenAI" },
  { id: "gpt-4-turbo",                  label: "GPT-4 Turbo",            provider: "OpenAI" },
  { id: "o3-mini",                      label: "o3-mini",                provider: "OpenAI" },
  { id: "o1",                           label: "o1",                     provider: "OpenAI" },
  { id: "o1-mini",                      label: "o1-mini",                provider: "OpenAI" },
];

function ChatView({ sessionId, messages, harnesses, registry, model, onModelChange, onSend }: {
  sessionId: string;
  messages: ChatMessage[];
  harnesses: RealHarness[];
  registry: Registry;
  model: string;
  onModelChange: (m: string) => void;
  onSend: (text: string, attachedItems?: PaletteItem[]) => void;
}) {
  const [input, setInput] = useState("");
  const [attached, setAttached] = useState<PaletteItem[]>([]);
  const [showPalette, setShowPalette] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteIdx, setPaletteIdx] = useState(0);
  const [showPlus, setShowPlus] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const paletteListRef = useRef<HTMLDivElement>(null);
  const isStreaming = messages.some(m => m.status === "streaming");

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  // 키보드 탐색 시 선택 항목 스크롤
  useEffect(() => {
    if (!showPalette || !paletteListRef.current) return;
    const selected = paletteListRef.current.children[paletteIdx] as HTMLElement | undefined;
    selected?.scrollIntoView({ block: "nearest" });
  }, [paletteIdx, showPalette]);

  // Build palette items
  const allItems: PaletteItem[] = [
    ...harnesses.map(h => ({ kind: "harness" as const, id: h.id, name: h.name, description: h.description })),
    ...registry.tools.filter(t => !t.comingSoon).map(t => ({ kind: "tool" as const, id: t.id, name: t.name, description: t.description })),
    ...registry.subAgents.map(a => ({ kind: "subagent" as const, id: a.id, name: a.name, description: a.description })),
  ];

  const filteredItems = paletteQuery
    ? allItems.filter(i => i.name.toLowerCase().includes(paletteQuery.toLowerCase()) || i.description.toLowerCase().includes(paletteQuery.toLowerCase()))
    : allItems;

  const handleInputChange = (val: string) => {
    setInput(val);
    const slashIdx = val.lastIndexOf("/");
    if (slashIdx !== -1 && slashIdx === val.length - 1 - (val.length - 1 - slashIdx)) {
      // detect "/" at any position
    }
    if (val.includes("/")) {
      const afterSlash = val.slice(val.lastIndexOf("/") + 1);
      setShowPalette(true);
      setPaletteQuery(afterSlash);
      setPaletteIdx(0);
    } else {
      setShowPalette(false);
    }
  };

  const attachItem = (item: PaletteItem) => {
    setAttached(prev => prev.find(a => a.id === item.id && a.kind === item.kind) ? prev : [...prev, item]);
    // / 입력한 부분 제거
    setInput(prev => prev.slice(0, prev.lastIndexOf("/")).trimEnd());
    setShowPalette(false);
    setShowPlus(false);
    textareaRef.current?.focus();
  };

  const selectPaletteItem = (item: PaletteItem) => attachItem(item);
  const insertFromPlus = (item: PaletteItem) => attachItem(item);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showPalette) {
      if (e.key === "ArrowDown") { e.preventDefault(); setPaletteIdx(i => Math.min(i + 1, filteredItems.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setPaletteIdx(i => Math.max(i - 1, 0)); return; }
      if (e.key === "Enter" && filteredItems[paletteIdx]) { e.preventDefault(); selectPaletteItem(filteredItems[paletteIdx]); return; }
      if (e.key === "Escape") { setShowPalette(false); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const send = () => {
    if ((!input.trim() && attached.length === 0) || isStreaming) return;
    const attachedPrefix = attached.map(a =>
      a.kind === "harness" ? `[하네스: ${a.name}]` :
      a.kind === "tool" ? `[도구: ${a.name}]` :
      `[에이전트: ${a.name}]`
    ).join(" ");
    const fullQuery = [attachedPrefix, input.trim()].filter(Boolean).join("\n");
    onSend(fullQuery, attached.length > 0 ? [...attached] : undefined);
    setInput("");
    setAttached([]);
    setShowPalette(false);
  };

  const SUGGESTIONS = harnesses.slice(0, 3).map(h => ({
    text: h.name,
    prompt: `${h.name} 하네스를 실행해줘. ${h.description}`,
  }));

  const kindIcon = (kind: PaletteItem["kind"]) =>
    kind === "harness" ? "⛓" : kind === "tool" ? "⚙" : "🤖";

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-6 space-y-5">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <span className="text-3xl mb-3">💬</span>
            <h2 className="text-[16px] font-semibold mb-1" style={{ color: "var(--text-primary)" }}>무엇을 도와드릴까요?</h2>
            <p className="text-[13px] mb-6 max-w-sm leading-relaxed" style={{ color: "var(--text-secondary)" }}>
              데이터 분석, 하네스 실행, 보고서 생성 등 자유롭게 요청하세요<br />
              <span style={{ color: "var(--text-tertiary)" }}>입력창에서 <strong>/</strong> 를 눌러 하네스·도구·에이전트를 선택할 수 있어요</span>
            </p>
            {SUGGESTIONS.length > 0 && (
              <div className="flex flex-col gap-2 w-full max-w-sm">
                {SUGGESTIONS.map(s => (
                  <button key={s.text} onClick={() => onSend(s.prompt)}
                    className="text-left px-4 py-3 rounded-xl text-[13px]"
                    style={{ border: "1px solid var(--border)", background: "var(--sidebar-bg)", color: "var(--text-primary)" }}>
                    ⛓ {s.text}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : messages.map(msg => (
          <ChatBubble key={msg.id} message={msg} />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="flex-none px-6 py-4 relative" style={{ borderTop: "1px solid var(--border)" }}>

        {/* / Command Palette */}
        {showPalette && filteredItems.length > 0 && (
          <div className="absolute bottom-full left-6 right-6 mb-2 rounded-xl overflow-hidden shadow-lg z-20"
            style={{ border: "1px solid var(--border)", background: "white", maxHeight: 280 }}>
            <div className="px-3 py-2 text-[11px] font-medium uppercase tracking-wider"
              style={{ background: "var(--sidebar-bg)", color: "var(--text-tertiary)", borderBottom: "1px solid var(--border)" }}>
              하네스 · 도구 · 서브에이전트 선택
            </div>
            <div ref={paletteListRef} className="overflow-y-auto" style={{ maxHeight: 240 }}>
              {filteredItems.map((item, i) => (
                <button key={`${item.kind}_${item.id}`}
                  onClick={() => selectPaletteItem(item)}
                  className="w-full text-left px-4 py-2.5 flex items-center gap-3"
                  style={{ background: i === paletteIdx ? "var(--active-bg)" : "transparent", borderBottom: "1px solid var(--border)" }}>
                  <span className="text-[14px] flex-none">{kindIcon(item.kind)}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium truncate" style={{ color: "var(--text-primary)" }}>{item.name}</div>
                    <div className="text-[11px] truncate" style={{ color: "var(--text-tertiary)" }}>{item.description}</div>
                  </div>
                  <span className="text-[10px] px-1.5 py-0.5 rounded flex-none"
                    style={{ background: "var(--border)", color: "var(--text-tertiary)" }}>
                    {item.kind === "harness" ? "하네스" : item.kind === "tool" ? "도구" : "에이전트"}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* + Picker popup */}
        {showPlus && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setShowPlus(false)} />
            <div className="absolute bottom-full left-6 mb-2 rounded-xl overflow-hidden shadow-lg z-20 w-72"
              style={{ border: "1px solid var(--border)", background: "white" }}>
              {[
                { label: "하네스", icon: "⛓", items: harnesses.map(h => ({ kind: "harness" as const, id: h.id, name: h.name, description: h.description })) },
                { label: "도구", icon: "⚙", items: registry.tools.filter(t => !t.comingSoon).map(t => ({ kind: "tool" as const, id: t.id, name: t.name, description: t.description })) },
                { label: "서브에이전트", icon: "🤖", items: registry.subAgents.map(a => ({ kind: "subagent" as const, id: a.id, name: a.name, description: a.description })) },
              ].map(group => group.items.length > 0 && (
                <div key={group.label}>
                  <div className="px-3 py-1.5 text-[10.5px] font-medium uppercase tracking-wider"
                    style={{ background: "var(--sidebar-bg)", color: "var(--text-tertiary)", borderBottom: "1px solid var(--border)" }}>
                    {group.icon} {group.label}
                  </div>
                  {group.items.map(item => (
                    <button key={`${item.kind}_${item.id}`} onClick={() => insertFromPlus(item)}
                      className="w-full text-left px-4 py-2 flex items-center gap-2"
                      style={{ borderBottom: "1px solid var(--border)" }}
                      onMouseEnter={e => (e.currentTarget.style.background = "var(--active-bg)")}
                      onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                      <div className="flex-1 min-w-0">
                        <div className="text-[12.5px] font-medium truncate" style={{ color: "var(--text-primary)" }}>{item.name}</div>
                        <div className="text-[11px] truncate" style={{ color: "var(--text-tertiary)" }}>{item.description}</div>
                      </div>
                    </button>
                  ))}
                </div>
              ))}
              {allItems.length === 0 && (
                <div className="px-4 py-6 text-center text-[12px]" style={{ color: "var(--text-tertiary)" }}>
                  등록된 하네스·도구·에이전트가 없습니다
                </div>
              )}
            </div>
          </>
        )}

        {/* Attached chips */}
        {attached.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {attached.map(item => {
              const icon = item.kind === "harness" ? "⛓" : item.kind === "tool" ? "⚙" : "🤖";
              return (
                <span key={`${item.kind}_${item.id}`}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[12px] font-medium"
                  style={{ background: "var(--accent-light)", color: "var(--accent)", border: "1px solid var(--accent)" }}>
                  <span>{icon}</span>
                  <span>{item.name}</span>
                  <button onClick={() => setAttached(prev => prev.filter(a => !(a.id === item.id && a.kind === item.kind)))}
                    className="ml-0.5 opacity-60 hover:opacity-100 text-[11px]">✕</button>
                </span>
              );
            })}
          </div>
        )}

        <div className="flex gap-2 items-end">
          {/* + button */}
          <button onClick={() => setShowPlus(o => !o)}
            className="flex-none w-9 h-9 rounded-xl flex items-center justify-center text-lg font-light mb-0.5"
            style={{ border: "1px solid var(--border)", background: showPlus ? "var(--active-bg)" : "transparent", color: showPlus ? "var(--accent)" : "var(--text-tertiary)" }}>
            +
          </button>

          {/* Textarea */}
          <div className="flex-1 rounded-xl overflow-hidden"
            style={{ border: "1px solid var(--border)", boxShadow: "0 1px 4px rgba(0,0,0,0.06)" }}>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={e => handleInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="메시지 입력... (/ 로 하네스·도구·에이전트 선택)"
              rows={2}
              disabled={isStreaming}
              className="w-full resize-none px-4 pt-3 pb-2 outline-none text-[13.5px] leading-relaxed"
              style={{ background: "transparent", color: "var(--text-primary)", fontFamily: "inherit" }}
            />
            <div className="flex items-center justify-between px-3 pb-2 pt-1 gap-2"
              style={{ borderTop: "1px solid var(--border)", background: "#fafaf9" }}>
              <span className="text-[11px] flex-none" style={{ color: "var(--text-tertiary)" }}>
                <kbd className="px-1 rounded text-[10px]" style={{ border: "1px solid var(--border)" }}>/</kbd> 명령어 &nbsp;
                <kbd className="px-1 rounded text-[10px]" style={{ border: "1px solid var(--border)" }}>Enter</kbd> 전송
              </span>
              <select
                value={model}
                onChange={e => onModelChange(e.target.value)}
                disabled={isStreaming}
                className="text-[11.5px] px-2 py-1 rounded-lg outline-none"
                style={{ border: "1px solid var(--border)", background: "white", color: "var(--text-secondary)", maxWidth: 160 }}>
                {CHAT_MODELS.map(m => (
                  <option key={m.id} value={m.id}>{m.provider} · {m.label}</option>
                ))}
              </select>
              <button onClick={send} disabled={!input.trim() || isStreaming}
                className="flex-none px-4 py-1.5 rounded-lg text-[12.5px] font-medium flex items-center gap-1.5"
                style={{
                  background: input.trim() && !isStreaming ? "var(--accent)" : "var(--border)",
                  color: input.trim() && !isStreaming ? "white" : "var(--text-tertiary)",
                }}>
                {isStreaming ? <><span className="spinner" style={{ width: 11, height: 11 }} /> 처리 중</> : "전송 ↵"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChatBubble({ message }: { message: ChatMessage }) {
  const [showLogs, setShowLogs] = useState(false);
  const toolCallCount = (message.logs ?? []).filter(l => l.kind === "tool_call").length;
  const isStreaming = message.status === "streaming";

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[70%] px-4 py-2.5 rounded-2xl rounded-tr-sm text-[13.5px] leading-relaxed"
          style={{ background: "var(--accent)", color: "white" }}>
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-[80%] space-y-2">
        {/* Tool activity indicator */}
        {(isStreaming || toolCallCount > 0) && (
          <button onClick={() => setShowLogs(o => !o)}
            className="flex items-center gap-1.5 text-[11.5px] px-2.5 py-1 rounded-lg"
            style={{ background: "var(--active-bg)", color: "var(--accent)", border: "1px solid var(--accent)" }}>
            {isStreaming ? (
              <><span className="spinner" style={{ width: 9, height: 9 }} /> 도구 실행 중...</>
            ) : (
              <><span>⚙</span> 도구 {toolCallCount}회 호출됨 {showLogs ? "▲" : "▼"}</>
            )}
          </button>
        )}
        {/* Tool logs (expandable) */}
        {showLogs && (message.logs ?? []).length > 0 && (
          <div className="rounded-lg overflow-hidden text-[11.5px] font-mono"
            style={{ background: "#f7f7f5", border: "1px solid var(--border)" }}>
            {(message.logs ?? []).map((entry, i) => <LogLine key={i} entry={entry} />)}
          </div>
        )}
        {/* Streaming logs inline (while streaming, show last activity) */}
        {isStreaming && !showLogs && (message.logs ?? []).length > 0 && (() => {
          const last = (message.logs ?? []).at(-1)!;
          return (
            <div className="text-[11px] font-mono px-2" style={{ color: "var(--text-tertiary)" }}>
              {last.kind === "tool_call" ? `→ ${last.tool}` : last.kind === "tool_result" ? `${last.success ? "✓" : "✗"} ${last.tool}` : "..."}
            </div>
          );
        })()}
        {/* Message content */}
        {message.content && (
          <div className="px-4 py-3 rounded-2xl rounded-tl-sm"
            style={{ background: "var(--sidebar-bg)", border: "1px solid var(--border)" }}>
            {message.status === "error" ? (
              <p className="text-[13px]" style={{ color: "#ef4444" }}>{message.content}</p>
            ) : (
              <div className="report-content text-[13.5px] leading-relaxed"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }} />
            )}
          </div>
        )}
        {isStreaming && !message.content && (
          <div className="px-4 py-3 rounded-2xl rounded-tl-sm"
            style={{ background: "var(--sidebar-bg)", border: "1px solid var(--border)" }}>
            <span className="animate-pulse text-[13px]" style={{ color: "var(--text-tertiary)" }}>●●●</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── No Session State ──────────────────────────────────────────────────────────

function NoChatState({ onCreateSession }: { onCreateSession: () => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
      <span className="text-4xl mb-3">⛓️</span>
      <h2 className="text-[18px] font-semibold mb-2" style={{ color: "var(--text-primary)" }}>HarnessChain</h2>
      <p className="text-[13px] mb-6 max-w-sm leading-relaxed" style={{ color: "var(--text-secondary)" }}>
        세션을 만들어 AI와 대화하며 하네스를 실행하고<br />데이터를 분석하세요
      </p>
      <button onClick={onCreateSession}
        className="px-5 py-2.5 rounded-xl text-[13.5px] font-medium"
        style={{ background: "var(--accent)", color: "white" }}>
        + 새 세션 시작
      </button>
    </div>
  );
}

// ── Harness Flow Graph (ReactFlow HTML/CSS 노드) ───────────────────────────────

const RF_NODE_W = 160;
const RF_NODE_H = 44;
const RF_LAYER_GAP = 80;
const RF_NODE_GAP = 30;
const RF_TOP_PAD = 32;

type HFGKind = "start" | "end" | HarnessNode["kind"];
interface HFGData {
  label: string;
  kind: HFGKind;
  isActive: boolean;
  isError: boolean;
  isDone: boolean;
  [key: string]: unknown; // ReactFlow requires index signature
}

/** BFS topological layer assignment — same algorithm as before, now returns ReactFlow positions. */
function computeFlowLayout(
  nodes: HarnessNode[],
  edges: HarnessEdge[],
  containerW: number,
): { rfNodes: RFNode<HFGData>[]; rfEdges: RFEdge[]; totalHeight: number } {
  const allIds = ["__start__", ...nodes.map(n => n.id), "__end__"];

  const depth = new Map<string, number>();
  depth.set("__start__", 0);
  const queue = ["__start__"];
  while (queue.length) {
    const cur = queue.shift()!;
    const d = depth.get(cur) ?? 0;
    edges.filter(e => e.from === cur).forEach(e => {
      if ((depth.get(e.to) ?? -1) < d + 1) { depth.set(e.to, d + 1); queue.push(e.to); }
    });
  }
  allIds.forEach(id => { if (!depth.has(id)) depth.set(id, 1); });

  const byLayer = new Map<number, string[]>();
  allIds.forEach(id => {
    const d = depth.get(id) ?? 0;
    if (!byLayer.has(d)) byLayer.set(d, []);
    byLayer.get(d)!.push(id);
  });

  const sortedLayers = [...byLayer.entries()].sort(([a], [b]) => a - b);

  const kindOf = (id: string): HFGKind =>
    id === "__start__" ? "start" : id === "__end__" ? "end" : (nodes.find(n => n.id === id)?.kind ?? "tool");
  const labelOf = (id: string) => {
    if (id === "__start__" || id === "__end__") return id;
    const n = nodes.find(x => x.id === id);
    return n?.label ?? n?.ref ?? id;
  };

  const rfNodes: RFNode<HFGData>[] = [];
  sortedLayers.forEach(([, ids], li) => {
    const totalW = ids.length * RF_NODE_W + (ids.length - 1) * RF_NODE_GAP;
    const ox = (containerW - totalW) / 2;
    const y = RF_TOP_PAD + li * (RF_NODE_H + RF_LAYER_GAP);
    ids.forEach((id, ni) => {
      rfNodes.push({
        id,
        position: { x: ox + ni * (RF_NODE_W + RF_NODE_GAP), y },
        type: "hfgNode",
        data: { label: labelOf(id), kind: kindOf(id), isActive: false, isError: false, isDone: false },
        draggable: false,
        selectable: false,
        connectable: false,
      });
    });
  });

  const rfEdges: RFEdge[] = edges.map(e => ({
    id: e.id,
    source: e.from,
    target: e.to,
    label: e.label,
    type: "smoothstep",
    style: {
      stroke: "#94a3b8", strokeWidth: 1.5,
      ...(e.condition ? { strokeDasharray: "5 3" } : {}),
    },
    labelStyle: { fontSize: 10, fill: "#64748b", fontStyle: "italic" },
    markerEnd: { type: MarkerType.ArrowClosed, color: "#94a3b8", width: 14, height: 14 },
  }));

  const totalHeight = RF_TOP_PAD + sortedLayers.length * (RF_NODE_H + RF_LAYER_GAP) - RF_LAYER_GAP + RF_TOP_PAD;
  return { rfNodes, rfEdges, totalHeight };
}

function HFGNodeComponent({ data }: NodeProps) {
  const d = data as HFGData;
  const isTerminal = d.kind === "start" || d.kind === "end";
  const icon = d.kind === "subagent" ? "🤖" : d.kind === "tool" ? "⚙" : d.kind === "source" ? "📦" : "";
  const truncLabel = d.label.length > 18 ? d.label.slice(0, 17) + "…" : d.label;

  let bg = "#f0fdfa", border = "#2dd4bf", color = "#134e4a";
  if (d.kind === "end") { bg = "#0d9488"; border = "#0d9488"; color = "#ffffff"; }
  if (d.isError)        { bg = "#fef2f2"; border = "#f87171"; color = "#b91c1c"; }
  else if (d.isDone)    { bg = "#dcfce7"; border = "#4ade80"; color = "#15803d"; }
  else if (d.isActive)  { bg = "#ccfbf1"; border = "#14b8a6"; color = "#0f766e"; }

  return (
    <>
      <Handle type="target" position={Position.Top}
        style={{ background: "transparent", border: "none", width: 1, height: 1 }} />
      <div style={{
        width: RF_NODE_W, height: RF_NODE_H,
        background: bg, border: `1.5px solid ${border}`,
        borderRadius: isTerminal ? RF_NODE_H / 2 : 8,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 12, fontWeight: isTerminal ? 600 : 500,
        fontFamily: isTerminal ? "monospace" : "inherit",
        color, gap: 5, padding: "0 12px", boxSizing: "border-box",
        userSelect: "none",
      }}>
        {icon && <span style={{ fontSize: 13, lineHeight: 1 }}>{icon}</span>}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {truncLabel}
        </span>
        {(d.isError || d.isDone || d.isActive) && (
          <span style={{
            flexShrink: 0, width: 6, height: 6, borderRadius: "50%",
            background: d.isError ? "#f87171" : d.isDone ? "#4ade80" : "#14b8a6",
          }} />
        )}
      </div>
      <Handle type="source" position={Position.Bottom}
        style={{ background: "transparent", border: "none", width: 1, height: 1 }} />
    </>
  );
}

const HFG_NODE_TYPES = { hfgNode: HFGNodeComponent };

function HarnessFlowGraph({
  nodes,
  edges,
  activeNodeId,
  errorNodeIds = [],
  doneNodeIds = [],
  isStreaming = false,
  width = 480,
  height,
}: {
  nodes: HarnessNode[];
  edges: HarnessEdge[];
  activeNodeId?: string;
  errorNodeIds?: string[];
  doneNodeIds?: string[];
  isStreaming?: boolean;
  width?: number;
  height?: number;
}) {
  const { rfNodes, rfEdges, totalHeight } = useMemo(
    () => computeFlowLayout(nodes, edges, width),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(nodes), JSON.stringify(edges), width],
  );

  // 고정 height 지정 시: 컨텐츠가 더 크면 fitView, 아니면 자연스럽게
  // height 미지정 시: 컨텐츠 높이 그대로 (모달이 스크롤 처리)
  // height prop 지정 시 최대 높이 제한 (넘치면 스크롤)
  const containerH = height ?? totalHeight;

  // Patch node data with live status (active/error/done) without recalculating layout
  const patchedNodes = useMemo(
    () => rfNodes.map(n => ({
      ...n,
      data: {
        ...n.data,
        isActive: n.id === activeNodeId && isStreaming,
        isError: errorNodeIds.includes(n.id),
        isDone:  doneNodeIds.includes(n.id),
      },
    })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rfNodes, activeNodeId, isStreaming, JSON.stringify(errorNodeIds), JSON.stringify(doneNodeIds)],
  );

  return (
    <div style={{ width, height: containerH, overflowY: height ? "auto" : "visible", borderRadius: 8 }}>
      <div style={{ width, height: totalHeight }}>
        <ReactFlow
          nodes={patchedNodes}
          edges={rfEdges}
          nodeTypes={HFG_NODE_TYPES}
          defaultViewport={{ x: 0, y: 0, zoom: 1 }}
          panOnDrag={false}
          zoomOnScroll={false}
          zoomOnDoubleClick={false}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: true }}
          style={{ background: "transparent" }}
        />
      </div>
    </div>
  );
}

// ── Harness Detail Modal ───────────────────────────────────────────────────────

// ── BuildStepList — 하네스 생성 진행 단계 UI ──────────────────────────────────

const BUILD_STEPS: { step: JobStep; label: string }[] = [
  { step: "nodes",          label: "노드 설계" },
  { step: "validate_nodes", label: "노드 검증" },
  { step: "edges",          label: "엣지 설계" },
  { step: "validate_edges", label: "엣지 검증" },
  { step: "meta",           label: "이름 생성" },
];

function BuildStepList({ jobEvent }: { jobEvent: JobEvent | null }) {
  const currentStep = jobEvent?.step ?? "queued";
  const { steps: orderedSteps, currentIndex } = getStepProgress(currentStep as JobStep);

  return (
    <div className="space-y-2">
      {BUILD_STEPS.map(({ step, label }) => {
        const stepIndex = orderedSteps.indexOf(step);
        const isDone = stepIndex < currentIndex;
        const isActive = step === currentStep;
        return (
          <div key={step} className="flex items-center gap-3 px-4 py-2.5 rounded-lg"
            style={{ background: "var(--sidebar-bg)", border: `1px solid ${isActive ? "var(--accent)" : "var(--border)"}` }}>
            <span className="w-5 text-center text-[14px]">
              {isDone ? "✓" : isActive ? <span className="spinner" style={{ width: 12, height: 12, display: "inline-block" }} /> : "○"}
            </span>
            <span className="text-[12.5px]" style={{
              color: isDone ? "#22c55e" : isActive ? "var(--accent)" : "var(--text-tertiary)",
              fontWeight: isActive ? 500 : 400,
            }}>
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function HarnessDetailModal({
  harness,
  onClose,
  onRun,
}: {
  harness: RealHarness;
  onClose: () => void;
  onRun: (h: RealHarness) => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rounded-2xl overflow-hidden flex flex-col"
        style={{ background: "var(--content-bg)", border: "1px solid var(--border)", width: 580, maxHeight: "88vh" }}>
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4"
          style={{ borderBottom: "1px solid var(--border)", background: "var(--sidebar-bg)" }}>
          <div className="text-xl">{harness.schedule.type === "cron" ? "⏰" : "▷"}</div>
          <div className="flex-1 min-w-0">
            <div className="text-[15px] font-semibold" style={{ color: "var(--text-primary)" }}>{harness.name}</div>
            {harness.description && (
              <div className="text-[12px] mt-0.5" style={{ color: "var(--text-secondary)" }}>{harness.description}</div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => onRun(harness)}
              className="px-4 py-1.5 rounded-lg text-[13px] font-medium"
              style={{ background: "var(--accent)", color: "white" }}>
              ▶ 실행
            </button>
            <button onClick={onClose}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-[13px]"
              style={{ background: "var(--sidebar-bg)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}>
              ✕
            </button>
          </div>
        </div>

        {/* Meta */}
        <div className="px-6 py-3 flex items-center gap-4 text-[11px]"
          style={{ borderBottom: "1px solid var(--border)", color: "var(--text-tertiary)" }}>
          <span>{harness.schedule.type === "cron" ? `크론: ${harness.schedule.cron}` : "즉시 실행"}</span>
          <span>·</span>
          <span>{harness.nodes.length}단계</span>
          <span>·</span>
          <span>생성: {new Date(harness.createdAt).toLocaleDateString("ko-KR")}</span>
        </div>

        {/* Flow graph */}
        <div className="flex-1 overflow-y-auto px-6 py-6 flex flex-col items-center"
          style={{ background: "var(--content-bg)" }}>
          {harness.nodes.length === 0 ? (
            <div className="text-[13px] py-12" style={{ color: "var(--text-tertiary)" }}>단계가 없습니다.</div>
          ) : (
            <HarnessFlowGraph nodes={harness.nodes} edges={harness.edges} width={520} />
          )}

          {/* Step list */}
          <div className="w-full mt-6">
            <div className="text-[11px] font-medium uppercase tracking-wider mb-3"
              style={{ color: "var(--text-tertiary)" }}>단계 상세</div>
            <div className="space-y-2">
              {harness.nodes.map((step, i) => (
                <div key={step.id} className="flex items-center gap-3 px-3 py-2 rounded-lg"
                  style={{ background: "var(--sidebar-bg)", border: "1px solid var(--border)" }}>
                  <span className="text-[11px] font-mono w-5 text-center flex-none"
                    style={{ color: "var(--text-tertiary)" }}>{i + 1}</span>
                  <span className="text-[13px]">
                    {step.kind === "subagent" ? "🤖" : step.kind === "tool" ? "⚙" : "📦"}
                  </span>
                  <span className="flex-1 text-[12.5px] font-medium" style={{ color: "var(--text-primary)" }}>
                    {step.label ?? step.ref}
                  </span>
                  <span className="text-[11px] px-2 py-0.5 rounded-full"
                    style={{ background: "var(--accent-light)", color: "var(--accent)" }}>
                    {step.kind}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Monitor Card — utilities & sub-components ─────────────────────────────────
type StepStatus = "pending" | "active" | "done" | "error";

/** Maps a harness step to the tool-call name the orchestrator will emit. */
function getStepToolName(step: HarnessStep): string {
  if (step.kind === "subagent") return `subagent_${step.ref}`;
  return step.ref; // tool and source steps: ref IS the tool name
}

/** Computes per-step status from the accumulated log entries. */
function useHarnessStepStates(
  steps: HarnessStep[],
  logs: LogEntry[],
  isStreaming: boolean
): { step: HarnessStep; status: StepStatus }[] {
  const calledTools = new Set(
    logs.filter(l => l.kind === "tool_call").map(l => (l as Extract<LogEntry, { kind: "tool_call" }>).tool)
  );
  const completedTools = new Set(
    logs.filter(l => l.kind === "tool_result").map(l => (l as Extract<LogEntry, { kind: "tool_result" }>).tool)
  );
  const erroredTools = new Set(
    logs
      .filter(l => l.kind === "tool_result" && !(l as Extract<LogEntry, { kind: "tool_result" }>).success)
      .map(l => (l as Extract<LogEntry, { kind: "tool_result" }>).tool)
  );
  const lastToolCall = [...logs].reverse().find(l => l.kind === "tool_call") as Extract<LogEntry, { kind: "tool_call" }> | undefined;

  return steps.map(step => {
    const toolName = getStepToolName(step);
    const label = step.label ?? step.ref;
    // Match by canonical tool name OR label/ref substring (fallback for source steps)
    const matches = (t: string) =>
      t === toolName || t === label || t.includes(step.ref) || step.ref.includes(t);

    if ([...erroredTools].some(matches)) return { step, status: "error" as StepStatus };
    if ([...completedTools].some(matches)) return { step, status: "done" as StepStatus };
    if (isStreaming && lastToolCall && matches(lastToolCall.tool)) return { step, status: "active" as StepStatus };
    if ([...calledTools].some(matches)) return { step, status: "active" as StepStatus };
    return { step, status: "pending" as StepStatus };
  });
}

/** Pure UI component: renders the node→arrow→node flow graph (vertical or horizontal). */
function HarnessStepGraph({
  steps,
  states,
  isStreaming,
  layout = "vertical",
}: {
  steps: HarnessStep[];
  states: { step: HarnessStep; status: StepStatus }[];
  isStreaming: boolean;
  layout?: "vertical" | "horizontal";
}) {
  const kindIcon = (kind: HarnessStep["kind"]) =>
    kind === "subagent" ? "🤖" : kind === "tool" ? "⚙" : "📦";

  const nodeStyle = (status: StepStatus): React.CSSProperties => {
    if (status === "done")   return { background: "#f0fdf4", border: "1px solid #86efac", color: "#22c55e" };
    if (status === "error")  return { background: "#fef2f2", border: "1px solid #fca5a5", color: "#ef4444" };
    if (status === "active") return { background: "var(--accent-light)", border: "1px solid var(--accent)", color: "var(--accent)" };
    return { background: "var(--sidebar-bg)", border: "1px solid var(--border)", color: "var(--text-tertiary)" };
  };

  if (layout === "horizontal") {
    return (
      <div className="flex items-center flex-wrap gap-y-2">
        {states.map(({ step, status }, i) => {
          const label = step.label ?? step.ref;
          const style = nodeStyle(status);
          return (
            <React.Fragment key={step.id}>
              {i > 0 && (
                <div className="flex items-center px-1.5" style={{ color: "var(--text-tertiary)", fontSize: 14 }}>→</div>
              )}
              <div
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg${status === "active" ? " animate-pulse" : ""}`}
                style={style}
              >
                <span className="text-[12px]">{kindIcon(step.kind)}</span>
                <span className="text-[11.5px] font-medium whitespace-nowrap">{label}</span>
                {status === "done"   && <span className="text-[10px]">✓</span>}
                {status === "error"  && <span className="text-[10px]">✗</span>}
                {status === "active" && isStreaming && <span className="spinner flex-none" style={{ width: 7, height: 7 }} />}
              </div>
            </React.Fragment>
          );
        })}
      </div>
    );
  }

  return (
    <div>
      {states.map(({ step, status }, i) => {
        const label = step.label ?? step.ref;
        const style = nodeStyle(status);
        return (
          <div key={step.id} className="flex flex-col items-stretch">
            {/* Connector arrow between nodes */}
            {i > 0 && (
              <div className="flex flex-col items-center py-0.5">
                <div style={{ width: 1, height: 10, background: "var(--border)" }} />
                <div style={{ width: 0, height: 0, borderLeft: "4px solid transparent", borderRight: "4px solid transparent", borderTop: "5px solid var(--border)" }} />
              </div>
            )}
            {/* Node */}
            <div
              className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg${status === "active" ? " animate-pulse" : ""}`}
              style={style}
            >
              <span className="text-[12px]">{kindIcon(step.kind)}</span>
              <span className="flex-1 text-[11.5px] font-medium truncate">{label}</span>
              {status === "done"   && <span className="text-[10px]">✓</span>}
              {status === "error"  && <span className="text-[10px]">✗</span>}
              {status === "active" && isStreaming && <span className="spinner flex-none" style={{ width: 8, height: 8 }} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Monitor Card (Right Panel) ────────────────────────────────────────────────

function MonitorCard({ message, sessionName, harnesses }: {
  message: ChatMessage;
  sessionName: string;
  harnesses: RealHarness[];
}) {
  const logs = message.logs ?? [];
  const isStreaming = message.status === "streaming";
  const statusColor = message.status === "done" ? "#22c55e" : message.status === "error" ? "#ef4444" : "var(--accent)";

  const attachedHarness = message.attachedItems?.find(a => a.kind === "harness");
  const harnessData = attachedHarness ? harnesses.find(h => h.id === attachedHarness.id) : null;

  const toolCallCount = logs.filter(l => l.kind === "tool_call").length;
  const lastToolCall = [...logs].reverse().find(l => l.kind === "tool_call") as Extract<LogEntry, { kind: "tool_call" }> | undefined;

  const stepStates = useHarnessStepStates(harnessData?.nodes ?? [], logs, isStreaming);

  return (
    <div className="rounded-lg overflow-hidden" style={{ border: "1px solid var(--border)", background: "var(--content-bg)" }}>
      {/* Header */}
      <div className="px-3 py-2 flex items-center gap-2"
        style={{ borderBottom: "1px solid var(--border)", background: "var(--sidebar-bg)" }}>
        <span className="text-[11px]" style={{ color: statusColor }}>
          {isStreaming
            ? <span className="spinner" style={{ width: 9, height: 9, display: "inline-block" }} />
            : message.status === "done" ? "✓" : "✗"}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-medium truncate" style={{ color: "var(--text-primary)" }}>
            {attachedHarness?.name ?? sessionName}
          </div>
          <div className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>
            {sessionName} · 도구 {toolCallCount}회
          </div>
        </div>
        {isStreaming && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full animate-pulse"
            style={{ background: "var(--accent-light)", color: "var(--accent)" }}>실행 중</span>
        )}
      </div>

      {/* Harness step flow graph */}
      {harnessData && harnessData.nodes.length > 0 && (
        <div className="px-3 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
          <div className="text-[10px] font-medium uppercase tracking-wider mb-2" style={{ color: "var(--text-tertiary)" }}>
            실행 흐름
          </div>
          <HarnessStepGraph steps={harnessData.nodes} states={stepStates} isStreaming={isStreaming} />
        </div>
      )}

      {/* Live log (last few lines) */}
      {logs.length > 0 && (
        <div className="max-h-32 overflow-y-auto">
          {logs.slice(-6).map((entry, i) => <MiniLogLine key={i} entry={entry} />)}
          {isStreaming && (
            <div className="px-3 py-1 text-[11px] font-mono" style={{ color: "var(--text-tertiary)" }}>
              {lastToolCall ? `→ ${lastToolCall.tool}` : "분석 중..."}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MiniLogLine({ entry }: { entry: LogEntry }) {
  const base = "px-3 py-1 text-[11px] font-mono border-t border-[var(--border)]";
  if (entry.kind === "source_check") return <div className={base} style={{ color: "var(--text-tertiary)" }}>{entry.message}</div>;
  if (entry.kind === "source_selected") return <div className={base} style={{ color: "#22c55e" }}>✓ {entry.sources.join(", ")}</div>;
  if (entry.kind === "tool_call") return <div className={base}><span style={{ color: "var(--accent)" }}>→ {entry.tool}</span></div>;
  if (entry.kind === "tool_result") return <div className={base} style={{ color: entry.success ? "#22c55e" : "#ef4444" }}>{entry.success ? "✓" : "✗"} {entry.tool}</div>;
  if (entry.kind === "thinking") return <div className={base} style={{ color: "var(--text-tertiary)" }}>💭 ...</div>;
  if (entry.kind === "error") return <div className={base} style={{ color: "#ef4444" }}>✗ {entry.message}</div>;
  return null;
}

// ── Sources Tab ───────────────────────────────────────────────────────────────

const SOURCE_TYPES = [
  { id: "postgresql", icon: "🐘", name: "PostgreSQL", desc: "pg 호환 데이터베이스" },
  { id: "notion",     icon: "📓", name: "Notion",     desc: "페이지 / 데이터베이스 읽기" },
  { id: "gdrive",     icon: "📁", name: "Google Drive", desc: "문서 / 스프레드시트 읽기" },
  { id: "redis",      icon: "🔴", name: "Redis",      desc: "캐시 / 큐", soon: true },
  { id: "csv",        icon: "📄", name: "CSV / Excel", desc: "파일 업로드", soon: true },
  { id: "rest",       icon: "🌐", name: "REST API",   desc: "외부 HTTP 엔드포인트", soon: true },
] as const;

function SourcesTab() {
  const [selected, setSelected] = useState<string>("postgresql");

  return (
    <div className="flex-1 overflow-y-auto px-10 py-8">
      <div className="max-w-xl">
        <h1 className="text-[20px] font-semibold mb-1" style={{ color: "var(--text-primary)" }}>소스 관리</h1>
        <p className="text-[13px] mb-6" style={{ color: "var(--text-secondary)" }}>에이전트가 데이터를 읽어올 소스를 등록합니다</p>
        <div className="grid grid-cols-3 gap-3 mb-6">
          {SOURCE_TYPES.map(s => (
            <button key={s.id} disabled={"soon" in s && s.soon}
              onClick={() => !("soon" in s && s.soon) && setSelected(s.id)}
              className="text-left rounded-xl p-4 flex flex-col gap-2 transition-all"
              style={{
                border: `1px solid ${selected === s.id ? "var(--accent)" : "var(--border)"}`,
                background: selected === s.id ? "var(--accent-light)" : ("soon" in s && s.soon) ? "var(--sidebar-bg)" : "white",
                opacity: ("soon" in s && s.soon) ? 0.5 : 1,
              }}>
              <span className="text-2xl">{s.icon}</span>
              <div>
                <div className="text-[13px] font-medium" style={{ color: "var(--text-primary)" }}>{s.name}</div>
                <div className="text-[11.5px]" style={{ color: "var(--text-secondary)" }}>{s.desc}</div>
              </div>
              {"soon" in s && s.soon && <span className="text-[10px] px-1.5 py-0.5 rounded self-start" style={{ background: "var(--border)", color: "var(--text-tertiary)" }}>준비 중</span>}
            </button>
          ))}
        </div>

        {selected === "postgresql" && (
          <div className="rounded-xl p-4" style={{ border: "1px solid var(--border)" }}>
            <div className="text-[12px] font-medium mb-3" style={{ color: "var(--text-primary)" }}>PostgreSQL 연결</div>
            {["Host", "Port", "Database", "Username", "Password"].map(f => (
              <div key={f} className="mb-2">
                <label className="text-[11px] block mb-1" style={{ color: "var(--text-tertiary)" }}>{f}</label>
                <input type={f === "Password" ? "password" : "text"} placeholder={f === "Port" ? "5432" : ""}
                  className="w-full px-3 py-1.5 rounded-lg text-[13px] outline-none"
                  style={{ border: "1px solid var(--border)", background: "white", color: "var(--text-primary)" }} />
              </div>
            ))}
            <button className="mt-3 w-full py-2 rounded-lg text-[13px] font-medium" style={{ background: "var(--accent)", color: "white" }}>
              연결 테스트 후 저장
            </button>
          </div>
        )}

        {selected === "notion" && (
          <div className="rounded-xl p-5" style={{ border: "1px solid var(--border)" }}>
            <div className="text-[13px] font-semibold mb-1" style={{ color: "var(--text-primary)" }}>Notion 연결</div>
            <p className="text-[12px] mb-5 leading-relaxed" style={{ color: "var(--text-secondary)" }}>
              Notion 워크스페이스에 OAuth로 연결합니다. 연결하면 에이전트가 허용된 페이지와 데이터베이스를 읽고 쓸 수 있습니다.
            </p>
            <button className="w-full py-2.5 rounded-lg text-[13px] font-medium flex items-center justify-center gap-2"
              style={{ background: "#000", color: "white" }}>
              <span>📓</span> Notion으로 로그인
            </button>
            <p className="text-[11px] mt-3 text-center" style={{ color: "var(--text-tertiary)" }}>
              연결 후 접근을 허용할 페이지/DB를 Notion에서 직접 지정합니다
            </p>
          </div>
        )}

        {selected === "gdrive" && (
          <div className="rounded-xl p-5" style={{ border: "1px solid var(--border)" }}>
            <div className="text-[13px] font-semibold mb-1" style={{ color: "var(--text-primary)" }}>Google Drive 연결</div>
            <p className="text-[12px] mb-5 leading-relaxed" style={{ color: "var(--text-secondary)" }}>
              Google 계정으로 OAuth 연결합니다. 에이전트가 Drive 파일과 Sheets 데이터를 읽고 쓸 수 있습니다.
            </p>
            <button className="w-full py-2.5 rounded-lg text-[13px] font-medium flex items-center justify-center gap-2"
              style={{ background: "#4285F4", color: "white" }}>
              <span>🔑</span> Google 계정으로 로그인
            </button>
            <p className="text-[11px] mt-3 text-center" style={{ color: "var(--text-tertiary)" }}>
              Drive, Sheets 접근 권한을 요청합니다
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Tools Tab ─────────────────────────────────────────────────────────────────

const TOOL_GROUPS = [
  {
    group: "내장 (Built-in)",
    tools: [
      { icon: "🗄", name: "SQL 쿼리", desc: "execute_query, get_schema, explain_query 등", builtin: true },
    ],
  },
  {
    group: "Notion",
    source: "Notion 소스 연결 필요",
    tools: [
      { icon: "📓", name: "Notion 페이지 읽기", desc: "페이지 본문 및 속성 조회", soon: true },
      { icon: "🔍", name: "Notion DB 검색", desc: "데이터베이스 필터/정렬 조회", soon: true },
      { icon: "✏️", name: "Notion 페이지 업데이트", desc: "페이지 속성 및 내용 수정", soon: true },
      { icon: "📊", name: "Notion DB 레코드 추가", desc: "데이터베이스에 새 행 추가", soon: true },
    ],
  },
  {
    group: "Google",
    source: "Google Drive 소스 연결 필요",
    tools: [
      { icon: "📁", name: "Drive 파일 읽기", desc: "Google Docs / PDF 본문 추출", soon: true },
      { icon: "📋", name: "Sheets 데이터 읽기", desc: "스프레드시트 범위 조회", soon: true },
      { icon: "📝", name: "Sheets 데이터 쓰기", desc: "셀 값 업데이트 / 행 추가", soon: true },
    ],
  },
  {
    group: "알림 / 연동",
    tools: [
      { icon: "📧", name: "이메일 발송", desc: "SMTP / SendGrid", soon: true },
      { icon: "💬", name: "Slack 메시지", desc: "채널 / DM 발송", soon: true },
      { icon: "🔔", name: "웹훅 호출", desc: "임의 HTTP POST", soon: true },
    ],
  },
];

function ToolsTab() {
  return (
    <div className="flex-1 overflow-y-auto px-10 py-8">
      <div className="max-w-2xl">
        <h1 className="text-[20px] font-semibold mb-1" style={{ color: "var(--text-primary)" }}>도구 관리</h1>
        <p className="text-[13px] mb-6" style={{ color: "var(--text-secondary)" }}>에이전트가 사용할 도구를 등록합니다</p>
        <div className="flex flex-col gap-6">
          {TOOL_GROUPS.map(g => (
            <div key={g.group}>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-tertiary)" }}>{g.group}</span>
                {"source" in g && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "var(--border)", color: "var(--text-tertiary)" }}>
                    {g.source}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                {g.tools.map(t => (
                  <div key={t.name} className="rounded-xl p-4 flex flex-col gap-2"
                    style={{ border: "1px solid var(--border)", background: "var(--sidebar-bg)", opacity: "soon" in t && t.soon ? 0.6 : 1 }}>
                    <span className="text-xl">{t.icon}</span>
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[13px] font-medium" style={{ color: "var(--text-primary)" }}>{t.name}</span>
                        {"builtin" in t && t.builtin && <span className="text-[10px] px-1 py-0.5 rounded" style={{ background: "var(--accent-light)", color: "var(--accent)" }}>내장</span>}
                      </div>
                      <div className="text-[11.5px]" style={{ color: "var(--text-secondary)" }}>{t.desc}</div>
                    </div>
                    {"soon" in t && t.soon && <span className="text-[10px] self-start px-1.5 py-0.5 rounded" style={{ background: "var(--border)", color: "var(--text-tertiary)" }}>준비 중</span>}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── SubAgents Tab ─────────────────────────────────────────────────────────────

const SA_TEMPLATES = [
  { label: "🔍 VIP 이탈 분석기", desc: "VIP 등급 고객의 거래 패턴을 분석해서 이탈 위험을 예측하고 위험 고객 목록을 추출하는 에이전트" },
  { label: "🚨 이상 거래 탐지기", desc: "금융 거래 데이터에서 비정상적인 패턴(고액, 심야, 연속)을 감지하고 위험 트랜잭션을 식별하는 에이전트" },
  { label: "📊 데이터 리포터", desc: "데이터베이스를 조회해서 현황과 트렌드를 요약한 경영진용 리포트를 자동으로 작성하는 에이전트" },
];

function SubAgentsTab({ subAgents, tools, onSaved }: { subAgents: SubAgent[]; tools: Tool[]; onSaved: () => void }) {
  const [mode, setMode] = useState<"list" | "build">(subAgents.length === 0 ? "build" : "list");
  const [processDesc, setProcessDesc] = useState("");
  const [isBuilding, setIsBuilding] = useState(false);
  const [buildLog, setBuildLog] = useState<LogEntry[]>([]);

  // Editable built result
  const [builtResult, setBuiltResult] = useState(false);
  const [builtName, setBuiltName] = useState("");
  const [builtDesc, setBuiltDesc] = useState("");
  const [builtSystemPrompt, setBuiltSystemPrompt] = useState("");
  const [builtSkills, setBuiltSkills] = useState("");
  const [builtRules, setBuiltRules] = useState("");
  const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set());
  const [selectedModel, setSelectedModel] = useState("gpt-4.1-mini");
  const [saving, setSaving] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [buildLog]);

  const handleBuild = async () => {
    if (!processDesc.trim() || isBuilding) return;
    setIsBuilding(true); setBuildLog([]); setBuiltResult(false);
    try {
      const res = await fetch("/api/subagents/build", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: processDesc,
          availableTools: tools.filter(t => !t.comingSoon).map(t => ({ id: t.id, name: t.name, description: t.description })),
        }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: `서버 오류 (${res.status})` }));
        throw new Error(errBody.error ?? `서버 오류 (${res.status})`);
      }
      if (!res.body) throw new Error("No response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === "thinking") {
              setBuildLog(p => [...p, { kind: "thinking", text: event.text }]);
            } else if (event.type === "result") {
              const d = event.data;
              setBuiltName(d.name ?? "");
              setBuiltDesc(d.description ?? "");
              setBuiltSystemPrompt(d.systemPrompt ?? "");
              setBuiltSkills(d.skills ?? "");
              setBuiltRules(d.rules ?? "");
              if (Array.isArray(d.tools)) setSelectedTools(new Set(d.tools as string[]));
              setBuiltResult(true);
              setBuildLog([]);
            } else if (event.type === "error") {
              setBuildLog(p => [...p, { kind: "error", message: event.message }]);
            }
          } catch { /* ignore */ }
        }
      }
    } catch (err) {
      setBuildLog(p => [...p, { kind: "error", message: err instanceof Error ? err.message : String(err) }]);
    } finally { setIsBuilding(false); }
  };

  const toggleTool = (toolId: string) => {
    setSelectedTools(prev => {
      const next = new Set(prev);
      next.has(toolId) ? next.delete(toolId) : next.add(toolId);
      return next;
    });
  };

  const handleSave = async () => {
    if (!builtName.trim() || !builtSystemPrompt.trim()) return;
    setSaving(true);
    await fetch("/api/subagents", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: builtName, description: builtDesc,
        systemPrompt: builtSystemPrompt, skills: builtSkills, rules: builtRules,
        tools: Array.from(selectedTools), model: selectedModel, maxIterations: 20,
      }),
    });
    setSaving(false);
    setBuiltResult(false); setBuildLog([]); setProcessDesc("");
    setMode("list");
    onSaved();
  };

  const availableTools = tools.filter(t => !t.comingSoon);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex-none flex items-center gap-1 px-8 pt-5 pb-0">
        {(["list", "build"] as const).map(m => (
          <button key={m} onClick={() => setMode(m)}
            className="px-3 py-1.5 text-[13px]"
            style={{ borderBottom: mode === m ? "2px solid var(--accent)" : "2px solid transparent", color: mode === m ? "var(--accent)" : "var(--text-secondary)", fontWeight: mode === m ? 500 : 400 }}>
            {m === "list" ? `에이전트 목록 (${subAgents.length})` : "+ 새로 만들기"}
          </button>
        ))}
      </div>
      <div className="flex-none" style={{ borderBottom: "1px solid var(--border)" }} />

      {mode === "list" && (
        <div className="flex-1 overflow-y-auto px-8 py-6">
          <div className="max-w-2xl space-y-3">
            {subAgents.length === 0 ? (
              <div className="text-center py-12" style={{ color: "var(--text-tertiary)" }}>
                <p>서브에이전트가 없습니다. 빌드 탭에서 만들어보세요.</p>
              </div>
            ) : subAgents.map(a => (
              <div key={a.id} className="rounded-xl px-5 py-4" style={{ border: "1px solid var(--border)", background: "var(--sidebar-bg)" }}>
                <div className="flex items-start gap-3">
                  <span className="text-xl mt-0.5">🤖</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[14px] font-medium" style={{ color: "var(--text-primary)" }}>{a.name}</div>
                    {a.description && <div className="text-[12px] mt-0.5" style={{ color: "var(--text-secondary)" }}>{a.description}</div>}
                    <div className="text-[11px] mt-2 line-clamp-2" style={{ color: "var(--text-tertiary)" }}>{a.systemPrompt}</div>
                    <div className="flex flex-wrap gap-1 mt-2">
                      <span className="px-1.5 py-0.5 rounded text-[10px]" style={{ background: "var(--accent-light)", color: "var(--accent)" }}>{
                        (() => {
                          const m = a.model ?? "claude-sonnet-4-6";
                          if (m.startsWith("gpt-") || m.startsWith("o1") || m.startsWith("o3")) return m;
                          return m.replace("claude-", "").replace("-20251001", "");
                        })()
                      }</span>
                      {a.tools.map(t => (
                        <span key={t} className="px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ background: "var(--border)", color: "var(--text-secondary)" }}>{t}</span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {mode === "build" && (
        <>
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-2xl mx-auto px-8 py-6">
              {!builtResult && buildLog.length === 0 && !isBuilding && (
                <div className="flex flex-col items-center text-center py-8">
                  <span className="text-3xl mb-3">🤖</span>
                  <h2 className="text-[16px] font-semibold mb-1" style={{ color: "var(--text-primary)" }}>서브에이전트 빌드</h2>
                  <p className="text-[13px] mb-6 max-w-sm leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                    어떤 업무를 맡길지 설명하면 AI가 에이전트를 설계합니다
                  </p>
                  <div className="w-full max-w-sm text-left">
                    <p className="text-[11px] mb-2" style={{ color: "var(--text-tertiary)" }}>템플릿으로 빠르게 시작</p>
                    <div className="flex flex-col gap-2">
                      {SA_TEMPLATES.map(t => (
                        <button key={t.label} onClick={() => { setProcessDesc(t.desc); setTimeout(() => textareaRef.current?.focus(), 50); }}
                          className="text-left px-3 py-2.5 rounded-lg text-[13px]"
                          style={{ border: "1px solid var(--border)", background: "var(--sidebar-bg)", color: "var(--text-primary)" }}>
                          {t.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {(isBuilding || buildLog.length > 0) && (
                <div className="mt-4">
                  <div className="text-[11px] font-medium uppercase tracking-wider mb-3" style={{ color: "var(--text-tertiary)" }}>
                    {isBuilding ? <span className="flex items-center gap-1.5"><span className="spinner" />생성 중...</span> : "실행 로그"}
                  </div>
                  <div className="rounded-lg overflow-hidden text-[12px] font-mono" style={{ background: "#f7f7f5", border: "1px solid var(--border)" }}>
                    {buildLog.map((entry, i) => <LogLine key={i} entry={entry} />)}
                    {isBuilding && <div className="px-4 py-2.5" style={{ color: "var(--text-tertiary)", borderTop: "1px solid var(--border)" }}><span className="animate-pulse">●</span> 설계 중...</div>}
                    <div ref={logEndRef} />
                  </div>
                </div>
              )}

              {builtResult && (
                <div className="mt-2 space-y-5">
                  {/* 기본 정보 */}
                  <div className="space-y-3">
                    <FormField label="이름" required>
                      <input value={builtName} onChange={e => setBuiltName(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg text-[13px] outline-none"
                        style={{ border: "1px solid var(--border)", color: "var(--text-primary)", background: "white" }} />
                    </FormField>
                    <FormField label="설명">
                      <input value={builtDesc} onChange={e => setBuiltDesc(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg text-[13px] outline-none"
                        style={{ border: "1px solid var(--border)", color: "var(--text-primary)", background: "white" }} />
                    </FormField>
                  </div>

                  {/* 시스템 프롬프트 */}
                  <div>
                    <div className="text-[12px] font-semibold mb-1.5 uppercase tracking-wide" style={{ color: "var(--text-secondary)" }}>시스템 프롬프트</div>
                    <textarea value={builtSystemPrompt} onChange={e => setBuiltSystemPrompt(e.target.value)} rows={5}
                      className="w-full px-3 py-2 rounded-lg text-[13px] outline-none resize-none"
                      style={{ border: "1px solid var(--border)", color: "var(--text-primary)", background: "white" }} />
                  </div>

                  {/* Skills */}
                  <div>
                    <div className="text-[12px] font-semibold mb-1.5 uppercase tracking-wide" style={{ color: "var(--text-secondary)" }}>Skills 지침</div>
                    <textarea value={builtSkills} onChange={e => setBuiltSkills(e.target.value)} rows={4}
                      placeholder="이 에이전트가 할 수 있는 것들 (마크다운 불릿)"
                      className="w-full px-3 py-2 rounded-lg text-[13px] outline-none resize-none font-mono"
                      style={{ border: "1px solid var(--border)", color: "var(--text-primary)", background: "white" }} />
                  </div>

                  {/* Rules */}
                  <div>
                    <div className="text-[12px] font-semibold mb-1.5 uppercase tracking-wide" style={{ color: "var(--text-secondary)" }}>Rules (제약)</div>
                    <textarea value={builtRules} onChange={e => setBuiltRules(e.target.value)} rows={4}
                      placeholder="반드시 지켜야 할 제약과 금지사항 (마크다운 불릿)"
                      className="w-full px-3 py-2 rounded-lg text-[13px] outline-none resize-none font-mono"
                      style={{ border: "1px solid var(--border)", color: "var(--text-primary)", background: "white" }} />
                  </div>

                  {/* 소스 & 도구 선택 */}
                  <div>
                    <div className="text-[12px] font-semibold mb-2 uppercase tracking-wide" style={{ color: "var(--text-secondary)" }}>소스 & 도구</div>
                    <div className="flex flex-wrap gap-2">
                      {availableTools.map(t => (
                        <button key={t.id} onClick={() => toggleTool(t.id)}
                          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] transition-colors"
                          style={{
                            border: `1px solid ${selectedTools.has(t.id) ? "var(--accent)" : "var(--border)"}`,
                            background: selectedTools.has(t.id) ? "var(--accent-light)" : "var(--sidebar-bg)",
                            color: selectedTools.has(t.id) ? "var(--accent)" : "var(--text-secondary)",
                          }}>
                          <span>{selectedTools.has(t.id) ? "✓" : "○"}</span>
                          <span>{t.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 모델 선택 */}
                  <div>
                    <div className="text-[12px] font-semibold mb-2 uppercase tracking-wide" style={{ color: "var(--text-secondary)" }}>모델</div>
                    {(["Anthropic", "OpenAI"] as const).map(provider => {
                      const models = CHAT_MODELS.filter(m => m.provider === provider);
                      return (
                        <div key={provider} className="mb-3">
                          <div className="text-[10px] mb-1.5 uppercase tracking-wider" style={{ color: "var(--text-tertiary)" }}>{provider}</div>
                          <div className="flex flex-wrap gap-2">
                            {models.map(m => (
                              <button key={m.id} onClick={() => setSelectedModel(m.id)}
                                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] transition-colors"
                                style={{
                                  border: `1px solid ${selectedModel === m.id ? "var(--accent)" : "var(--border)"}`,
                                  background: selectedModel === m.id ? "var(--accent-light)" : "var(--sidebar-bg)",
                                  color: selectedModel === m.id ? "var(--accent)" : "var(--text-secondary)",
                                }}>
                                <span>{selectedModel === m.id ? "✓" : "○"}</span>
                                <span>{m.label}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* 액션 */}
                  <div className="flex items-center gap-3 pt-2">
                    <button onClick={handleSave} disabled={!builtName.trim() || !builtSystemPrompt.trim() || saving}
                      className="px-5 py-2 rounded-lg text-[13px] font-medium"
                      style={{ background: builtName.trim() && builtSystemPrompt.trim() && !saving ? "var(--accent)" : "var(--border)", color: builtName.trim() && builtSystemPrompt.trim() && !saving ? "white" : "var(--text-tertiary)" }}>
                      {saving ? "저장 중..." : "💾 에이전트 저장"}
                    </button>
                    <button onClick={() => { setBuiltResult(false); setBuildLog([]); setProcessDesc(""); }}
                      className="px-4 py-2 rounded-lg text-[13px]"
                      style={{ border: "1px solid var(--border)", color: "var(--text-secondary)" }}>
                      다시 빌드
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="flex-none px-8 py-4" style={{ borderTop: "1px solid var(--border)" }}>
            <div className="max-w-2xl mx-auto">
              <div className="rounded-xl overflow-hidden" style={{ border: "1px solid var(--border)", boxShadow: "0 1px 4px rgba(0,0,0,0.06)" }}>
                <textarea ref={textareaRef} value={processDesc} onChange={e => setProcessDesc(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleBuild(); } }}
                  placeholder="어떤 업무를 담당할 에이전트인지 설명하세요..."
                  className="w-full px-4 py-3 text-[13.5px] outline-none resize-none"
                  style={{ background: "var(--bg)", color: "var(--text-primary)", minHeight: 60 }} rows={2} />
                <div className="flex items-center justify-between px-4 py-2" style={{ borderTop: "1px solid var(--border)", background: "var(--sidebar-bg)" }}>
                  <span className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>Enter로 빌드 · Shift+Enter 줄바꿈</span>
                  <button onClick={handleBuild} disabled={!processDesc.trim() || isBuilding}
                    className="px-4 py-1.5 rounded-lg text-[12.5px] font-medium"
                    style={{ background: processDesc.trim() && !isBuilding ? "var(--accent)" : "var(--border)", color: processDesc.trim() && !isBuilding ? "white" : "var(--text-tertiary)" }}>
                    {isBuilding ? "생성 중..." : "에이전트 빌드"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Harnesses Tab ─────────────────────────────────────────────────────────────

function HarnessesTab({ harnesses, registry, model, onSaved, onNavigate, onRunInSession }: {
  harnesses: RealHarness[]; registry: Registry; model: string; onSaved: () => void; onNavigate: (tab: NavTab) => void; onRunInSession: (h: RealHarness) => void;
}) {
  const [mode, setMode] = useState<"list" | "build">(harnesses.length === 0 ? "build" : "list");
  const [processDesc, setProcessDesc] = useState("");
  const [isBuilding, setIsBuilding] = useState(false);
  const [buildLog, setBuildLog] = useState<LogEntry[]>([]);
  const [builtReport, setBuiltReport] = useState<string | null>(null);
  const [buildMeta, setBuildMeta] = useState<{ toolCallCount: number; iterations: number; elapsedMs: number } | null>(null);
  const [showLog, setShowLog] = useState(true);
  const [selectedHarness, setSelectedHarness] = useState<RealHarness | null>(null);
  const [generatedDraft, setGeneratedDraft] = useState<{ name: string; description: string; nodes: HarnessNode[]; edges: HarnessEdge[] } | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [currentJobId, setCurrentJobId] = useState<string | null>(() =>
    typeof window !== "undefined" ? localStorage.getItem("hc:currentJobId") : null
  );
  const jobEvent = useJob(currentJobId);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const startTimeRef = useRef(0);

  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [buildLog]);

  const handleRunHarness = (h: RealHarness) => {
    setSelectedHarness(null);
    onRunInSession(h);
  };

  // job 이벤트 → draft/error 자동 반영
  useEffect(() => {
    if (!jobEvent) return;
    if (jobEvent.step === "done" && jobEvent.result) {
      const r = jobEvent.result as { name: string; description: string; nodes: HarnessNode[]; edges: HarnessEdge[] };
      setGeneratedDraft(r);
      setIsBuilding(false);
      localStorage.removeItem("hc:currentJobId");
      setCurrentJobId(null);
    } else if (jobEvent.step === "failed" || jobEvent.step === "cancelled") {
      setBuildError(jobEvent.error ?? "생성 실패");
      setIsBuilding(false);
      localStorage.removeItem("hc:currentJobId");
      setCurrentJobId(null);
    }
  }, [jobEvent]);

  const handleBuild = async () => {
    if (!processDesc.trim() || isBuilding) return;
    setIsBuilding(true);
    setGeneratedDraft(null);
    setBuildError(null);
    try {
      const res = await fetch("/api/harnesses/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: processDesc }),
      });
      const data = await res.json() as { jobId?: string; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `서버 오류 (${res.status})`);
      const jobId = data.jobId!;
      setCurrentJobId(jobId);
      localStorage.setItem("hc:currentJobId", jobId);
    } catch (err) {
      setBuildError(err instanceof Error ? err.message : String(err));
      setIsBuilding(false);
    }
  };

  const handleCancelBuild = async () => {
    if (!currentJobId) return;
    await fetch(`/api/harnesses/generate?jobId=${currentJobId}`, { method: "DELETE" });
    setIsBuilding(false);
    setCurrentJobId(null);
    localStorage.removeItem("hc:currentJobId");
  };

  const handleSaveHarness = async () => {
    if (!generatedDraft) return;
    await fetch("/api/harnesses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...generatedDraft, schedule: { type: "once" } }),
    });
    setGeneratedDraft(null);
    setProcessDesc("");
    setBuildError(null);
    onSaved();
  };

  const TEMPLATES = [
    { label: "📊 VIP 이탈 위험 일일 알림", desc: "매일 오전 9시에 VIP 등급 고객 중 최근 90일간 거래가 없는 이탈 위험 고객을 분석해서 리포트를 생성해줘." },
    { label: "🚨 이상 거래 실시간 탐지", desc: "매 시간마다 최근 1시간 내 이상 거래 패턴(고액, 연속, 심야)을 탐지하고 위험 거래 목록을 출력해줘." },
    { label: "📉 대출 부실 주간 보고", desc: "매주 월요일 오전에 대출 포트폴리오의 연체 현황과 부실 위험 고객을 분석한 주간 보고서를 작성해줘." },
  ];

  return (
    <>
    {selectedHarness && (
      <HarnessDetailModal
        harness={selectedHarness}
        onClose={() => setSelectedHarness(null)}
        onRun={handleRunHarness}
      />
    )}
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex-none flex items-center gap-1 px-8 pt-5 pb-0">
        {(["list", "build"] as const).map(m => (
          <button key={m} onClick={() => setMode(m)}
            className="px-3 py-1.5 text-[13px]"
            style={{ borderBottom: mode === m ? "2px solid var(--accent)" : "2px solid transparent", color: mode === m ? "var(--accent)" : "var(--text-secondary)", fontWeight: mode === m ? 500 : 400 }}>
            {m === "list" ? `하네스 목록 (${harnesses.length})` : "+ 새로 빌드"}
          </button>
        ))}
      </div>
      <div className="flex-none" style={{ borderBottom: "1px solid var(--border)" }} />

      {mode === "list" && (
        <div className="flex-1 overflow-y-auto px-8 py-6">
          <div className="max-w-3xl space-y-3">
            {harnesses.length === 0 ? (
              <div className="text-center py-12" style={{ color: "var(--text-tertiary)" }}>
                <p>하네스가 없습니다. 빌드 탭에서 만들어보세요.</p>
              </div>
            ) : harnesses.map(h => (
              <div key={h.id} className="rounded-xl px-5 py-4 cursor-pointer transition-all"
                style={{ border: "1px solid var(--border)", background: "var(--sidebar-bg)" }}
                onClick={() => setSelectedHarness(h)}>
                {/* Header row */}
                <div className="flex items-start gap-4">
                  <div className="text-xl mt-0.5">{h.schedule.type === "cron" ? "⏰" : "▷"}</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[14px] font-medium" style={{ color: "var(--text-primary)" }}>{h.name}</div>
                    {h.description && <div className="text-[12px] mt-0.5" style={{ color: "var(--text-secondary)" }}>{h.description}</div>}
                    <div className="text-[11px] mt-1" style={{ color: "var(--text-tertiary)" }}>
                      {h.schedule.type === "cron" ? `크론: ${h.schedule.cron}` : "즉시 실행"}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-2 flex-none">
                    <div className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                      {new Date(h.createdAt).toLocaleDateString("ko-KR")}
                    </div>
                    <button
                      onClick={e => { e.stopPropagation(); handleRunHarness(h); }}
                      className="px-3 py-1 rounded-lg text-[12px] font-medium"
                      style={{ background: "var(--accent)", color: "white" }}>
                      ▶ 실행
                    </button>
                  </div>
                </div>
                {/* Mini flow preview */}
                {h.nodes.length > 0 && (
                  <div className="mt-3 pt-3" style={{ borderTop: "1px solid var(--border)" }}>
                    <HarnessStepGraph
                      steps={h.nodes}
                      states={h.nodes.map(step => ({ step, status: "pending" as StepStatus }))}
                      isStreaming={false}
                      layout="horizontal"
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {mode === "build" && (
        <>
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-3xl mx-auto px-8 py-6">
              <div className="flex items-center gap-4 mb-5 text-[12px]" style={{ color: "var(--text-tertiary)" }}>
                <span>📦 소스 {registry.sources.length}개</span>
                <span>⚙ 도구 {registry.tools.filter(t => !t.comingSoon).length}개</span>
                <span>🤖 서브에이전트 {registry.subAgents.length}개</span>
              </div>
              {/* Empty state — template suggestions */}
              {!generatedDraft && !isBuilding && !buildError && (
                <div className="flex flex-col items-center text-center py-8">
                  <span className="text-3xl mb-3">⛓️</span>
                  <h2 className="text-[16px] font-semibold mb-1" style={{ color: "var(--text-primary)" }}>AI 하네스 빌더</h2>
                  <p className="text-[13px] mb-6 max-w-sm leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                    자동화할 업무를 설명하면 AI가 노드 · 엣지 설계와 검증을 자동으로 완료합니다
                  </p>
                  <div className="w-full max-w-sm text-left">
                    <p className="text-[11px] mb-2" style={{ color: "var(--text-tertiary)" }}>예시로 빠르게 시작</p>
                    <div className="flex flex-col gap-2">
                      {TEMPLATES.map(t => (
                        <button key={t.label} onClick={() => { setProcessDesc(t.desc); setTimeout(() => textareaRef.current?.focus(), 50); }}
                          className="text-left px-3 py-2.5 rounded-lg text-[13px]"
                          style={{ border: "1px solid var(--border)", background: "var(--sidebar-bg)", color: "var(--text-primary)" }}>
                          {t.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Loading state — 단계별 진행 체크리스트 */}
              {isBuilding && (
                <div className="mt-4">
                  <div className="flex items-center justify-between mb-4">
                    <div className="text-[13px] font-medium" style={{ color: "var(--text-primary)" }}>
                      하네스 설계 중...
                    </div>
                    <button onClick={handleCancelBuild} className="text-[11px] px-2.5 py-1 rounded-md"
                      style={{ border: "1px solid var(--border)", color: "var(--text-tertiary)" }}>
                      취소
                    </button>
                  </div>
                  <BuildStepList jobEvent={jobEvent ?? null} />
                </div>
              )}

              {/* Error state */}
              {buildError && !isBuilding && (
                <div className="mt-4 rounded-lg px-4 py-3" style={{ background: "#fef2f2", border: "1px solid #fca5a5" }}>
                  <div className="text-[12px] font-medium mb-1" style={{ color: "#b91c1c" }}>생성 실패</div>
                  <div className="text-[12px]" style={{ color: "#7f1d1d" }}>{buildError}</div>
                  <button onClick={() => setBuildError(null)} className="mt-2 text-[11px]" style={{ color: "#b91c1c" }}>닫기</button>
                </div>
              )}

              {/* Generated draft preview */}
              {generatedDraft && !isBuilding && (
                <div className="mt-4">
                  {/* Header */}
                  <div className="flex items-start justify-between mb-4 pb-3" style={{ borderBottom: "1px solid var(--border)" }}>
                    <div>
                      <div className="text-[16px] font-semibold" style={{ color: "var(--text-primary)" }}>{generatedDraft.name}</div>
                      {generatedDraft.description && (
                        <div className="text-[12px] mt-0.5" style={{ color: "var(--text-secondary)" }}>{generatedDraft.description}</div>
                      )}
                      <div className="flex gap-3 mt-2 text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                        <span>노드 {generatedDraft.nodes.length}개</span>
                        <span>엣지 {generatedDraft.edges.length}개</span>
                      </div>
                    </div>
                  </div>

                  {/* Flow graph preview */}
                  <div className="flex justify-center mb-5">
                    <HarnessFlowGraph nodes={generatedDraft.nodes} edges={generatedDraft.edges} width={520} height={320} />
                  </div>

                  {/* Node list */}
                  <div className="space-y-1.5 mb-6">
                    {generatedDraft.nodes.map((n, i) => (
                      <div key={n.id} className="flex items-center gap-3 px-3 py-2 rounded-lg"
                        style={{ background: "var(--sidebar-bg)", border: "1px solid var(--border)" }}>
                        <span className="text-[11px] font-mono w-5 text-center flex-none" style={{ color: "var(--text-tertiary)" }}>{i + 1}</span>
                        <span className="text-[13px]">{n.kind === "subagent" ? "🤖" : n.kind === "tool" ? "⚙" : "📦"}</span>
                        <span className="flex-1 text-[12.5px] font-medium" style={{ color: "var(--text-primary)" }}>{n.label ?? n.ref}</span>
                        <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: "var(--accent-light)", color: "var(--accent)" }}>{n.kind}</span>
                        <span className="text-[10px] font-mono" style={{ color: "var(--text-tertiary)" }}>{n.ref}</span>
                      </div>
                    ))}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-3">
                    <button onClick={handleSaveHarness}
                      className="px-5 py-2 rounded-lg text-[13px] font-medium"
                      style={{ background: "var(--accent)", color: "white" }}>
                      💾 하네스 저장
                    </button>
                    <button onClick={() => { setGeneratedDraft(null); setBuildError(null); }}
                      className="px-4 py-2 rounded-lg text-[13px]"
                      style={{ border: "1px solid var(--border)", color: "var(--text-secondary)" }}>
                      다시 빌드
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="flex-none px-8 py-4" style={{ borderTop: "1px solid var(--border)" }}>
            <div className="max-w-3xl mx-auto">
              <div className="rounded-xl overflow-hidden" style={{ border: "1px solid var(--border)", boxShadow: "0 1px 4px rgba(0,0,0,0.06)" }}>
                <textarea ref={textareaRef} value={processDesc} onChange={e => setProcessDesc(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleBuild(); } }}
                  placeholder="자동화할 업무를 설명하세요..."
                  rows={3} disabled={isBuilding}
                  className="w-full resize-none px-4 pt-3 pb-2 outline-none text-[13.5px] leading-relaxed"
                  style={{ background: "transparent", color: "var(--text-primary)", fontFamily: "inherit" }} />
                <div className="flex items-center justify-between px-3 pb-2 pt-1.5"
                  style={{ borderTop: "1px solid var(--border)", background: "#fafaf9" }}>
                  <span className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>Enter로 생성 · Shift+Enter 줄바꿈</span>
                  <button onClick={handleBuild} disabled={!processDesc.trim() || isBuilding}
                    className="px-3 py-1 rounded-md text-[12px] font-medium"
                    style={{ background: processDesc.trim() && !isBuilding ? "var(--accent)" : "var(--border)", color: processDesc.trim() && !isBuilding ? "white" : "var(--text-tertiary)" }}>
                    {isBuilding ? "생성 중..." : "AI 하네스 생성"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
    </>
  );
}

// ── Observability Tab ─────────────────────────────────────────────────────────

function ObservabilityTab() {
  const [queue, setQueue] = useState<{ jobs: unknown[]; metrics: { totalJobs: number; pending: number; running: number; completed: number; failed: number } } | null>(null);
  const fetchQueue = useCallback(() => { fetch("/api/queue").then(r => r.json()).then(setQueue).catch(console.error); }, []);
  useEffect(() => {
    fetchQueue();
    const iv = setInterval(fetchQueue, 3000); // 3초마다 폴링
    return () => clearInterval(iv);
  }, [fetchQueue]);
  type Job = { id: string; harnessName: string; trigger: string; startedAt: string; durationMs: number | null; status: string; error: string | null };
  const jobs = (queue?.jobs ?? []) as Job[];
  const metrics = queue?.metrics;

  return (
    <div className="flex-1 overflow-y-auto px-10 py-8">
      <div className="max-w-3xl">
        <h1 className="text-[20px] font-semibold mb-1" style={{ color: "var(--text-primary)" }}>실행 현황</h1>
        <p className="text-[13px] mb-6" style={{ color: "var(--text-secondary)" }}>스케줄된 하네스 실행 현황 및 이력</p>
        {metrics && (
          <div className="grid grid-cols-4 gap-3 mb-6">
            {[
              { label: "전체", value: metrics.totalJobs, color: "var(--text-primary)" },
              { label: "대기 중", value: metrics.pending, color: "var(--accent)" },
              { label: "실행 중", value: metrics.running, color: "#22c55e" },
              { label: "완료", value: metrics.completed, color: "var(--text-tertiary)" },
            ].map(m => (
              <div key={m.label} className="rounded-lg px-4 py-3 text-center"
                style={{ background: "var(--sidebar-bg)", border: "1px solid var(--border)" }}>
                <div className="text-[22px] font-semibold" style={{ color: m.color }}>{m.value}</div>
                <div className="text-[11px] mt-0.5" style={{ color: "var(--text-tertiary)" }}>{m.label}</div>
              </div>
            ))}
          </div>
        )}
        <div className="rounded-lg overflow-hidden" style={{ border: "1px solid var(--border)" }}>
          <div className="grid text-[11px] font-medium uppercase tracking-wider px-4 py-2"
            style={{ background: "var(--sidebar-bg)", color: "var(--text-tertiary)", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr" }}>
            <span>하네스</span><span>트리거</span><span>예약 시각</span><span>소요 시간</span><span>상태</span>
          </div>
          {jobs.length === 0 ? (
            <div className="px-4 py-8 text-center text-[13px]" style={{ color: "var(--text-tertiary)" }}>작업이 없습니다</div>
          ) : jobs.map((job, i) => {
            const statusMap: Record<string, { color: string; label: string }> = {
              scheduled: { color: "var(--accent)", label: "예약됨" }, running: { color: "#22c55e", label: "실행 중" },
              completed: { color: "var(--text-tertiary)", label: "완료" }, failed: { color: "#ef4444", label: "실패" },
            };
            const s = statusMap[job.status] ?? statusMap.scheduled;
            const isRunning = job.status === "running";
            return (
              <div key={job.id} className="grid px-4 py-3 text-[12.5px] items-center"
                style={{ gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr", borderTop: i > 0 ? "1px solid var(--border)" : "none", background: isRunning ? "var(--accent-light)" : "transparent" }}>
                <div className="font-medium flex items-center gap-2" style={{ color: "var(--text-primary)" }}>
                  {isRunning && <span className="spinner" style={{ width: 10, height: 10, flexShrink: 0 }} />}
                  {job.harnessName}
                </div>
                <span style={{ color: "var(--text-secondary)" }}>{job.trigger}</span>
                <span style={{ color: "var(--text-secondary)" }}>{job.startedAt ? new Date(job.startedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }) : "-"}</span>
                <span style={{ color: "var(--text-secondary)" }}>{job.durationMs != null ? `${(job.durationMs / 1000).toFixed(1)}s` : "-"}</span>
                <span className="text-[11px] font-medium" title={job.error ?? undefined} style={{ color: s.color }}>{s.label}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Shared Components ─────────────────────────────────────────────────────────

function FormField({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[12px] mb-1 font-medium" style={{ color: "var(--text-secondary)" }}>
        {label}{required && <span style={{ color: "#ef4444" }}> *</span>}
      </label>
      {children}
    </div>
  );
}

function LogLine({ entry }: { entry: LogEntry }) {
  const base = "px-4 py-2 border-t border-[var(--border)]";
  if (entry.kind === "source_check") return <div className={base} style={{ color: "var(--text-tertiary)" }}>🔍 {entry.message}</div>;
  if (entry.kind === "source_selected") return <div className={base} style={{ color: "#22c55e" }}>✓ 소스: {entry.sources.join(", ")}</div>;
  if (entry.kind === "tool_call") return (
    <div className={base}>
      <span style={{ color: "var(--accent)" }}>→ <strong>{entry.tool}</strong></span>
      <div className="ml-4 text-[11px] mt-0.5" style={{ color: "var(--text-tertiary)" }}>{entry.input.slice(0, 90)}</div>
    </div>
  );
  if (entry.kind === "tool_result") return (
    <div className={base}>
      <span style={{ color: entry.success ? "#22c55e" : "#ef4444" }}>{entry.success ? "✓" : "✗"} {entry.tool}</span>
      <div className="ml-4 text-[11px] mt-0.5" style={{ color: "var(--text-tertiary)", whiteSpace: "pre-wrap" }}>{entry.preview.slice(0, 120)}</div>
    </div>
  );
  if (entry.kind === "thinking") return <div className={base} style={{ color: "var(--text-tertiary)" }}>💭 {entry.text}</div>;
  if (entry.kind === "error") return <div className={base} style={{ color: "#ef4444" }}>✗ {entry.message}</div>;
  return null;
}
