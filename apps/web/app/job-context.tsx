"use client";

/**
 * JobContext — 루트 레이아웃에 마운트.
 * SSE /api/events 구독 → 전체 앱에 job 상태 공유.
 * navigation해도 레이아웃은 유지되므로 커넥션이 끊기지 않는다.
 */
import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";

export type JobStep =
  | "queued" | "nodes" | "validate_nodes"
  | "edges" | "validate_edges" | "meta"
  | "done" | "failed" | "cancelled";

export interface JobEvent {
  jobId: string;
  step: JobStep;
  error?: string;
  result?: { name: string; description: string; nodes: unknown[]; edges: unknown[] };
}

interface JobContextValue {
  jobs: Map<string, JobEvent>;
  getJob: (jobId: string) => JobEvent | undefined;
  clearJob: (jobId: string) => void;
}

const JobContext = createContext<JobContextValue>({
  jobs: new Map(),
  getJob: () => undefined,
  clearJob: () => {},
});

export function useJobs() { return useContext(JobContext); }
export function useJob(jobId: string | null) {
  const { jobs } = useJobs();
  return jobId ? jobs.get(jobId) : undefined;
}

// ── 진행 단계 한국어 레이블 ────────────────────────────────────────────────────

export const STEP_LABELS: Record<JobStep, string> = {
  queued:         "대기 중",
  nodes:          "노드 설계",
  validate_nodes: "노드 검증",
  edges:          "엣지 설계",
  validate_edges: "엣지 검증",
  meta:           "이름 생성",
  done:           "완료",
  failed:         "실패",
  cancelled:      "취소됨",
};

const ORDERED_STEPS: JobStep[] = ["nodes", "validate_nodes", "edges", "validate_edges", "meta", "done"];

export function getStepProgress(step: JobStep): { steps: JobStep[]; currentIndex: number } {
  const currentIndex = ORDERED_STEPS.indexOf(step);
  return { steps: ORDERED_STEPS, currentIndex };
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function JobProvider({ children }: { children: React.ReactNode }) {
  const [jobs, setJobs] = useState<Map<string, JobEvent>>(new Map());
  const [toast, setToast] = useState<JobEvent | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((event: JobEvent) => {
    setToast(event);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);

  useEffect(() => {
    const es = new EventSource("/api/events");

    es.onmessage = (e) => {
      if (!e.data || e.data === ":heartbeat") return;
      try {
        const event = JSON.parse(e.data) as JobEvent;
        setJobs(prev => new Map(prev).set(event.jobId, event));
        if (event.step === "done" || event.step === "failed") showToast(event);
      } catch { /* ignore */ }
    };

    es.onerror = () => {
      // 브라우저가 자동 재연결 시도하므로 별도 처리 불필요
    };

    return () => es.close();
  }, [showToast]);

  const getJob = useCallback((jobId: string) => jobs.get(jobId), [jobs]);
  const clearJob = useCallback((jobId: string) => {
    setJobs(prev => { const m = new Map(prev); m.delete(jobId); return m; });
  }, []);

  return (
    <JobContext.Provider value={{ jobs, getJob, clearJob }}>
      {children}
      {toast && <JobToast event={toast} onClose={() => setToast(null)} />}
    </JobContext.Provider>
  );
}

// ── Toast 알림 ────────────────────────────────────────────────────────────────

function JobToast({ event, onClose }: { event: JobEvent; onClose: () => void }) {
  const isDone = event.step === "done";
  return (
    <div
      style={{
        position: "fixed", bottom: 24, right: 24, zIndex: 9999,
        background: isDone ? "#f0fdf4" : "#fef2f2",
        border: `1px solid ${isDone ? "#86efac" : "#fca5a5"}`,
        borderRadius: 10, padding: "12px 16px", maxWidth: 320,
        boxShadow: "0 4px 16px rgba(0,0,0,0.10)",
        display: "flex", alignItems: "flex-start", gap: 10,
      }}
    >
      <span style={{ fontSize: 18 }}>{isDone ? "✓" : "✗"}</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: isDone ? "#15803d" : "#b91c1c", marginBottom: 2 }}>
          {isDone ? "하네스 생성 완료" : "하네스 생성 실패"}
        </div>
        <div style={{ fontSize: 11, color: isDone ? "#166534" : "#7f1d1d" }}>
          {isDone ? (event.result?.name ?? "하네스 빌더에서 확인하세요") : (event.error ?? "오류가 발생했습니다")}
        </div>
      </div>
      <button onClick={onClose} style={{ fontSize: 14, color: "#94a3b8", lineHeight: 1 }}>✕</button>
    </div>
  );
}
