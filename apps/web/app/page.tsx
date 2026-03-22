"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { AnalyzeEvent } from "@/lib/types";
import { renderMarkdown } from "@/lib/markdown";

// ── Types ──────────────────────────────────────────────────────────────────────

interface Source { id: string; name: string; type: string; description: string; status: string; }
interface Tool { id: string; name: string; category: string; description: string; comingSoon?: boolean; }
interface SubAgent { id: string; name: string; description: string; tools: string[]; systemPrompt: string; createdAt: string; }
interface RealHarness {
  id: string; name: string; description: string;
  schedule: { type: "once" | "cron"; cron?: string };
  steps: { id: string; kind: "subagent" | "tool" | "source"; ref: string; label?: string }[];
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

  const refreshAll = useCallback(async () => {
    await Promise.all([
      fetch("/api/registry").then(r => r.json()).then(setRegistry).catch(console.error),
      fetch("/api/harnesses").then(r => r.json()).then(setHarnesses).catch(console.error),
    ]);
  }, []);

  useEffect(() => { refreshAll(); }, [refreshAll]);

  const createSession = () => {
    const id = `sess_${Date.now()}`;
    const session: Session = { id, name: `세션 ${sessions.length + 1}`, createdAt: new Date().toISOString() };
    setSessions(prev => [...prev, session]);
    setActiveSessionId(id);
    setNavTab("chat");
  };

  const deleteSession = (id: string) => {
    setSessions(prev => prev.filter(s => s.id !== id));
    localStorage.removeItem(`hc_msgs_${id}`);
    setSessionMessages(prev => { const next = { ...prev }; delete next[id]; return next; });
    if (activeSessionId === id) setActiveSessionId(sessions.find(s => s.id !== id)?.id ?? null);
  };

  const streamQuery = async (sessionId: string, userText: string, attachedItems?: PaletteItem[]) => {
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
        body: JSON.stringify({ query: userText }),
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

  const activeMessages = activeSessionId ? (sessionMessages[activeSessionId] ?? []) : [];
  const streamingCount = Object.values(sessionMessages).flat().filter(m => m.status === "streaming").length;

  // Render a blank shell on the server to avoid hydration mismatch
  if (!mounted) {
    return <div className="flex flex-col h-screen" style={{ background: "var(--content-bg)" }} />;
  }

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
            <button onClick={createSession}
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
                <button onClick={createSession}
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
                  onSend={(text, items) => streamQuery(activeSessionId, text, items)}
                />
              : <NoChatState onCreateSession={createSession} />
          )}
          {navTab === "sources" && <SourcesTab />}
          {navTab === "tools" && <ToolsTab />}
          {navTab === "subagents" && <SubAgentsTab subAgents={registry.subAgents} onSaved={refreshAll} />}
          {navTab === "harnesses" && (
            <HarnessesTab
              harnesses={harnesses}
              registry={registry}
              onSaved={async () => { await refreshAll(); setNavTab("chat"); }}
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

function ChatView({ sessionId, messages, harnesses, registry, onSend }: {
  sessionId: string;
  messages: ChatMessage[];
  harnesses: RealHarness[];
  registry: Registry;
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
            <div className="flex items-center justify-between px-3 pb-2 pt-1"
              style={{ borderTop: "1px solid var(--border)", background: "#fafaf9" }}>
              <span className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                <kbd className="px-1 rounded text-[10px]" style={{ border: "1px solid var(--border)" }}>/</kbd> 명령어 &nbsp;
                <kbd className="px-1 rounded text-[10px]" style={{ border: "1px solid var(--border)" }}>Enter</kbd> 전송
              </span>
              <button onClick={send} disabled={!input.trim() || isStreaming}
                className="px-4 py-1.5 rounded-lg text-[12.5px] font-medium flex items-center gap-1.5"
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

// ── Monitor Card (Right Panel) ────────────────────────────────────────────────

function MonitorCard({ message, sessionName, harnesses }: {
  message: ChatMessage;
  sessionName: string;
  harnesses: RealHarness[];
}) {
  const logs = message.logs ?? [];
  const isStreaming = message.status === "streaming";
  const statusColor = message.status === "done" ? "#22c55e" : message.status === "error" ? "#ef4444" : "var(--accent)";

  // 첨부된 하네스 찾기
  const attachedHarness = message.attachedItems?.find(a => a.kind === "harness");
  const harnessData = attachedHarness ? harnesses.find(h => h.id === attachedHarness.id) : null;

  // 현재 실행 중인 도구 이름 (마지막 tool_call 기준)
  const runningTools = new Set(
    logs.filter(l => l.kind === "tool_call").map(l => (l as { kind: "tool_call"; tool: string; input: string }).tool)
  );
  const completedTools = new Set(
    logs.filter(l => l.kind === "tool_result").map(l => (l as { kind: "tool_result"; tool: string; success: boolean; preview: string }).tool)
  );
  const lastToolCall = [...logs].reverse().find(l => l.kind === "tool_call") as { kind: "tool_call"; tool: string } | undefined;
  const lastTool = lastToolCall?.tool;

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
            {sessionName} · 도구 {runningTools.size}회
          </div>
        </div>
        {isStreaming && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full animate-pulse"
            style={{ background: "var(--accent-light)", color: "var(--accent)" }}>실행 중</span>
        )}
      </div>

      {/* Harness step graph */}
      {harnessData && harnessData.steps.length > 0 && (
        <div className="px-3 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
          <div className="text-[10px] font-medium uppercase tracking-wider mb-2" style={{ color: "var(--text-tertiary)" }}>
            실행 흐름
          </div>
          <div className="space-y-1.5">
            {harnessData.steps.map((step, i) => {
              const stepLabel = step.label ?? step.ref;
              const isActive = isStreaming && lastTool && (stepLabel.includes(lastTool) || lastTool.includes(step.ref));
              const isDone = completedTools.has(step.ref) || completedTools.has(stepLabel);
              const kindIcon = step.kind === "subagent" ? "🤖" : step.kind === "tool" ? "⚙" : "📦";
              const nodeColor = isDone ? "#22c55e" : isActive ? "var(--accent)" : "var(--text-tertiary)";
              const nodeBg = isDone ? "#f0fdf4" : isActive ? "var(--accent-light)" : "var(--sidebar-bg)";
              const nodeBorder = isDone ? "#86efac" : isActive ? "var(--accent)" : "var(--border)";

              return (
                <div key={step.id} className="flex items-center gap-2">
                  {/* Connector line */}
                  {i > 0 && (
                    <div className="flex flex-col items-center" style={{ marginLeft: 10, marginRight: 2 }}>
                      <div style={{ width: 1, height: 8, background: "var(--border)", marginBottom: 2 }} />
                    </div>
                  )}
                  <div className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg w-full ${isActive ? "animate-pulse" : ""}`}
                    style={{ background: nodeBg, border: `1px solid ${nodeBorder}` }}>
                    <span className="text-[12px]">{kindIcon}</span>
                    <span className="flex-1 text-[11.5px] font-medium truncate" style={{ color: nodeColor }}>
                      {stepLabel}
                    </span>
                    {isDone && <span className="text-[10px]" style={{ color: "#22c55e" }}>✓</span>}
                    {isActive && <span className="spinner flex-none" style={{ width: 8, height: 8 }} />}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Live log (last few lines) */}
      {logs.length > 0 && (
        <div className="max-h-32 overflow-y-auto">
          {logs.slice(-6).map((entry, i) => <MiniLogLine key={i} entry={entry} />)}
          {isStreaming && (
            <div className="px-3 py-1 text-[11px] font-mono" style={{ color: "var(--text-tertiary)" }}>
              {lastTool ? `→ ${lastTool}` : "분석 중..."}
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

function SourcesTab() {
  return (
    <div className="flex-1 overflow-y-auto px-10 py-8">
      <div className="max-w-xl">
        <h1 className="text-[20px] font-semibold mb-1" style={{ color: "var(--text-primary)" }}>소스 관리</h1>
        <p className="text-[13px] mb-6" style={{ color: "var(--text-secondary)" }}>에이전트가 데이터를 읽어올 소스를 등록합니다</p>
        <div className="grid grid-cols-2 gap-3 mb-6">
          {[
            { icon: "🐘", name: "PostgreSQL", desc: "pg 호환 데이터베이스" },
            { icon: "🔴", name: "Redis", desc: "캐시 / 큐", soon: true },
            { icon: "📄", name: "CSV / Excel", desc: "파일 업로드", soon: true },
            { icon: "🌐", name: "REST API", desc: "외부 HTTP 엔드포인트", soon: true },
          ].map(s => (
            <button key={s.name} disabled={s.soon}
              className="text-left rounded-xl p-4 flex flex-col gap-2"
              style={{ border: "1px solid var(--border)", background: s.soon ? "var(--sidebar-bg)" : "white", opacity: s.soon ? 0.5 : 1 }}>
              <span className="text-2xl">{s.icon}</span>
              <div>
                <div className="text-[13px] font-medium" style={{ color: "var(--text-primary)" }}>{s.name}</div>
                <div className="text-[11.5px]" style={{ color: "var(--text-secondary)" }}>{s.desc}</div>
              </div>
              {s.soon && <span className="text-[10px] px-1.5 py-0.5 rounded self-start" style={{ background: "var(--border)", color: "var(--text-tertiary)" }}>준비 중</span>}
            </button>
          ))}
        </div>
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
      </div>
    </div>
  );
}

// ── Tools Tab ─────────────────────────────────────────────────────────────────

function ToolsTab() {
  return (
    <div className="flex-1 overflow-y-auto px-10 py-8">
      <div className="max-w-xl">
        <h1 className="text-[20px] font-semibold mb-1" style={{ color: "var(--text-primary)" }}>도구 관리</h1>
        <p className="text-[13px] mb-6" style={{ color: "var(--text-secondary)" }}>에이전트가 사용할 도구를 등록합니다</p>
        <div className="grid grid-cols-2 gap-3">
          {[
            { icon: "🗄", name: "SQL 쿼리", desc: "execute_query, get_schema 등", builtin: true },
            { icon: "📧", name: "이메일 발송", desc: "SMTP / SendGrid", soon: true },
            { icon: "💬", name: "Slack 메시지", desc: "채널 / DM 발송", soon: true },
            { icon: "📊", name: "Notion 업데이트", desc: "페이지 / DB 작성", soon: true },
            { icon: "🔔", name: "웹훅 호출", desc: "임의 HTTP POST", soon: true },
            { icon: "📁", name: "파일 저장", desc: "로컬 / S3", soon: true },
          ].map(t => (
            <div key={t.name} className="rounded-xl p-4 flex flex-col gap-2"
              style={{ border: "1px solid var(--border)", background: "var(--sidebar-bg)", opacity: t.soon ? 0.55 : 1 }}>
              <span className="text-2xl">{t.icon}</span>
              <div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[13px] font-medium" style={{ color: "var(--text-primary)" }}>{t.name}</span>
                  {t.builtin && <span className="text-[10px] px-1 py-0.5 rounded" style={{ background: "var(--accent-light)", color: "var(--accent)" }}>내장</span>}
                </div>
                <div className="text-[11.5px]" style={{ color: "var(--text-secondary)" }}>{t.desc}</div>
              </div>
              {t.soon && <span className="text-[10px] self-start px-1.5 py-0.5 rounded" style={{ background: "var(--border)", color: "var(--text-tertiary)" }}>준비 중</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── SubAgents Tab ─────────────────────────────────────────────────────────────

function SubAgentsTab({ subAgents, onSaved }: { subAgents: SubAgent[]; onSaved: () => void }) {
  const [showForm, setShowForm] = useState(subAgents.length === 0);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [prompt, setPrompt] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!name.trim() || !prompt.trim()) return;
    setSaving(true);
    await fetch("/api/subagents", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description: desc, systemPrompt: prompt, tools: ["execute_query", "get_schema"], model: "claude-sonnet-4-6", maxIterations: 20 }),
    });
    setSaving(false);
    setName(""); setDesc(""); setPrompt("");
    setShowForm(false);
    onSaved();
  };

  return (
    <div className="flex-1 overflow-y-auto px-10 py-8">
      <div className="max-w-2xl">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-[20px] font-semibold" style={{ color: "var(--text-primary)" }}>서브에이전트</h1>
            <p className="text-[13px] mt-0.5" style={{ color: "var(--text-secondary)" }}>특정 업무에 특화된 에이전트를 관리합니다</p>
          </div>
          <button onClick={() => setShowForm(o => !o)}
            className="px-3 py-1.5 rounded-lg text-[12.5px] font-medium"
            style={{ background: showForm ? "var(--border)" : "var(--accent)", color: showForm ? "var(--text-secondary)" : "white" }}>
            {showForm ? "취소" : "+ 새로 만들기"}
          </button>
        </div>
        {showForm && (
          <div className="mb-8 rounded-xl p-5" style={{ border: "1px solid var(--accent)", background: "var(--accent-light)" }}>
            <div className="text-[13px] font-medium mb-4" style={{ color: "var(--text-primary)" }}>새 서브에이전트</div>
            <div className="space-y-3">
              <FormField label="이름" required>
                <input value={name} onChange={e => setName(e.target.value)} placeholder="예: VIP 이탈 분석기"
                  className="w-full px-3 py-2 rounded-lg text-[13px] outline-none"
                  style={{ border: "1px solid var(--border)", color: "var(--text-primary)", background: "white" }} />
              </FormField>
              <FormField label="설명">
                <input value={desc} onChange={e => setDesc(e.target.value)} placeholder="한 줄 설명"
                  className="w-full px-3 py-2 rounded-lg text-[13px] outline-none"
                  style={{ border: "1px solid var(--border)", color: "var(--text-primary)", background: "white" }} />
              </FormField>
              <FormField label="시스템 프롬프트" required>
                <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={5}
                  placeholder="이 에이전트의 역할과 행동 지침을 작성하세요..."
                  className="w-full px-3 py-2 rounded-lg text-[13px] outline-none resize-none"
                  style={{ border: "1px solid var(--border)", color: "var(--text-primary)", background: "white" }} />
              </FormField>
              <button onClick={handleSave} disabled={!name.trim() || !prompt.trim() || saving}
                className="w-full py-2 rounded-lg text-[13px] font-medium"
                style={{ background: name.trim() && prompt.trim() && !saving ? "var(--accent)" : "var(--border)", color: name.trim() && prompt.trim() && !saving ? "white" : "var(--text-tertiary)" }}>
                {saving ? "저장 중..." : "저장"}
              </button>
            </div>
          </div>
        )}
        {subAgents.length > 0 ? (
          <div className="space-y-3">
            {subAgents.map(a => (
              <div key={a.id} className="rounded-xl px-5 py-4" style={{ border: "1px solid var(--border)", background: "var(--sidebar-bg)" }}>
                <div className="flex items-start gap-3">
                  <span className="text-xl mt-0.5">🤖</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[14px] font-medium" style={{ color: "var(--text-primary)" }}>{a.name}</div>
                    {a.description && <div className="text-[12px] mt-0.5" style={{ color: "var(--text-secondary)" }}>{a.description}</div>}
                    <div className="text-[11px] mt-2 line-clamp-2 font-mono" style={{ color: "var(--text-tertiary)" }}>{a.systemPrompt}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : !showForm && (
          <div className="text-center py-10" style={{ color: "var(--text-tertiary)" }}>
            <p className="text-[13px]">서브에이전트가 없습니다</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Harnesses Tab ─────────────────────────────────────────────────────────────

function HarnessesTab({ harnesses, registry, onSaved }: {
  harnesses: RealHarness[]; registry: Registry; onSaved: () => void;
}) {
  const [mode, setMode] = useState<"list" | "build">(harnesses.length === 0 ? "build" : "list");
  const [processDesc, setProcessDesc] = useState("");
  const [isBuilding, setIsBuilding] = useState(false);
  const [buildLog, setBuildLog] = useState<LogEntry[]>([]);
  const [builtReport, setBuiltReport] = useState<string | null>(null);
  const [buildMeta, setBuildMeta] = useState<{ toolCallCount: number; iterations: number; elapsedMs: number } | null>(null);
  const [showLog, setShowLog] = useState(true);
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const startTimeRef = useRef(0);

  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [buildLog]);

  const handleRunHarness = async (harnessId: string) => {
    setRunningIds(prev => new Set(prev).add(harnessId));
    try {
      await fetch(`/api/harnesses/${harnessId}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    } finally {
      setRunningIds(prev => { const next = new Set(prev); next.delete(harnessId); return next; });
    }
  };

  const handleBuild = async () => {
    if (!processDesc.trim() || isBuilding) return;
    setIsBuilding(true); setBuildLog([]); setBuiltReport(null); setBuildMeta(null); setShowLog(true);
    startTimeRef.current = Date.now();
    try {
      const res = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: processDesc }) });
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
            if (event.type === "report") { setBuiltReport(event.report); setBuildMeta({ toolCallCount: event.meta.toolCallCount, iterations: event.meta.iterations, elapsedMs: Date.now() - startTimeRef.current }); setShowLog(false); }
            else { const entry = eventToLogEntry(event); if (entry) setBuildLog(p => [...p, entry]); }
          } catch { /* ignore */ }
        }
      }
      if (!builtReport) setBuildLog(p => [...p, { kind: "error", message: "응답을 받지 못했습니다." }]);
    } catch (err) {
      setBuildLog(p => [...p, { kind: "error", message: err instanceof Error ? err.message : String(err) }]);
    } finally { setIsBuilding(false); }
  };

  const handleSaveHarness = async () => {
    if (!builtReport || !processDesc) return;
    await fetch("/api/harnesses", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: processDesc.slice(0, 40), description: processDesc.slice(0, 100), schedule: { type: "once" }, steps: [] }),
    });
    onSaved();
  };

  const TEMPLATES = [
    { label: "📊 VIP 이탈 위험 일일 알림", desc: "매일 오전 9시에 VIP 등급 고객 중 최근 90일간 거래가 없는 이탈 위험 고객을 분석해서 리포트를 생성해줘." },
    { label: "🚨 이상 거래 실시간 탐지", desc: "매 시간마다 최근 1시간 내 이상 거래 패턴(고액, 연속, 심야)을 탐지하고 위험 거래 목록을 출력해줘." },
    { label: "📉 대출 부실 주간 보고", desc: "매주 월요일 오전에 대출 포트폴리오의 연체 현황과 부실 위험 고객을 분석한 주간 보고서를 작성해줘." },
  ];

  return (
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
              <div key={h.id} className="rounded-xl px-5 py-4 flex items-start gap-4"
                style={{ border: "1px solid var(--border)", background: "var(--sidebar-bg)" }}>
                <div className="text-xl mt-0.5">{h.schedule.type === "cron" ? "⏰" : "▷"}</div>
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] font-medium" style={{ color: "var(--text-primary)" }}>{h.name}</div>
                  {h.description && <div className="text-[12px] mt-0.5" style={{ color: "var(--text-secondary)" }}>{h.description}</div>}
                  <div className="text-[11px] mt-2" style={{ color: "var(--text-tertiary)" }}>
                    {h.schedule.type === "cron" ? `크론: ${h.schedule.cron}` : "즉시 실행"} · {h.steps.length}단계
                  </div>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <div className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                    {new Date(h.createdAt).toLocaleDateString("ko-KR")}
                  </div>
                  <button
                    onClick={() => handleRunHarness(h.id)}
                    disabled={runningIds.has(h.id)}
                    className="px-3 py-1 rounded-lg text-[12px] font-medium"
                    style={{ background: runningIds.has(h.id) ? "var(--border)" : "var(--accent)", color: runningIds.has(h.id) ? "var(--text-tertiary)" : "white" }}>
                    {runningIds.has(h.id) ? "실행 중..." : "▶ 실행"}
                  </button>
                </div>
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
              {!builtReport && buildLog.length === 0 && !isBuilding && (
                <div className="flex flex-col items-center text-center py-8">
                  <span className="text-3xl mb-3">⛓️</span>
                  <h2 className="text-[16px] font-semibold mb-1" style={{ color: "var(--text-primary)" }}>하네스 빌드</h2>
                  <p className="text-[13px] mb-6 max-w-sm leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                    자동화할 업무를 설명하면 AI가 하네스를 설계합니다
                  </p>
                  <div className="w-full max-w-sm text-left">
                    <p className="text-[11px] mb-2" style={{ color: "var(--text-tertiary)" }}>템플릿으로 빠르게 시작</p>
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
              {(isBuilding || (buildLog.length > 0 && showLog)) && (
                <div className="mt-4">
                  <div className="text-[11px] font-medium uppercase tracking-wider mb-3" style={{ color: "var(--text-tertiary)" }}>
                    {isBuilding ? <span className="flex items-center gap-1.5"><span className="spinner" />빌드 중...</span> : "실행 로그"}
                  </div>
                  <div className="rounded-lg overflow-hidden text-[12px] font-mono" style={{ background: "#f7f7f5", border: "1px solid var(--border)" }}>
                    {buildLog.map((entry, i) => <LogLine key={i} entry={entry} />)}
                    {isBuilding && <div className="px-4 py-2.5" style={{ color: "var(--text-tertiary)", borderTop: "1px solid var(--border)" }}><span className="animate-pulse">●</span> 분석 중...</div>}
                    <div ref={logEndRef} />
                  </div>
                </div>
              )}
              {builtReport && !showLog && (
                <div className="mt-4">
                  {buildMeta && (
                    <div className="flex items-center gap-4 mb-4 text-[11px] pb-3" style={{ color: "var(--text-tertiary)", borderBottom: "1px solid var(--border)" }}>
                      <span>툴 호출 {buildMeta.toolCallCount}회</span>
                      <span>반복 {buildMeta.iterations}회</span>
                      <span>{(buildMeta.elapsedMs / 1000).toFixed(1)}초</span>
                      <button onClick={() => setShowLog(true)} className="ml-auto" style={{ color: "var(--text-tertiary)" }}>로그 보기</button>
                    </div>
                  )}
                  <div className="report-content" dangerouslySetInnerHTML={{ __html: renderMarkdown(builtReport) }} />
                  <div className="mt-6 flex items-center gap-3">
                    <button onClick={handleSaveHarness}
                      className="px-5 py-2 rounded-lg text-[13px] font-medium"
                      style={{ background: "var(--accent)", color: "white" }}>
                      💾 하네스로 저장
                    </button>
                    <button onClick={() => { setBuiltReport(null); setBuildLog([]); setBuildMeta(null); setProcessDesc(""); }}
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
                  <span className="text-[11px]" style={{ color: "var(--text-tertiary)" }}>Enter로 빌드 · Shift+Enter 줄바꿈</span>
                  <button onClick={handleBuild} disabled={!processDesc.trim() || isBuilding}
                    className="px-3 py-1 rounded-md text-[12px] font-medium"
                    style={{ background: processDesc.trim() && !isBuilding ? "var(--accent)" : "var(--border)", color: processDesc.trim() && !isBuilding ? "white" : "var(--text-tertiary)" }}>
                    {isBuilding ? "빌드 중..." : "하네스 빌드"}
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

// ── Observability Tab ─────────────────────────────────────────────────────────

function ObservabilityTab() {
  const [queue, setQueue] = useState<{ jobs: unknown[]; metrics: { totalJobs: number; pending: number; running: number; completed: number; failed: number } } | null>(null);
  useEffect(() => { fetch("/api/queue").then(r => r.json()).then(setQueue).catch(console.error); }, []);
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
            return (
              <div key={job.id} className="grid px-4 py-3 text-[12.5px] items-center"
                style={{ gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr", borderTop: i > 0 ? "1px solid var(--border)" : "none" }}>
                <div className="font-medium" style={{ color: "var(--text-primary)" }}>{job.harnessName}</div>
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
