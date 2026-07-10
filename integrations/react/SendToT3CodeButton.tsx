import { useRef, useState } from "react";

import "./send-to-t3-code-button.css";

// Optional integration example. The t3code CLI does not depend on React.

export type T3CodeHandoverRequest = {
  prompt: string;
  provider?: string;
  model?: string;
  speed?: "standard" | "fast";
  thinkingEffort?: string;
  permission?: "approval-required" | "auto-accept-edits" | "full-access";
  mode?: "build" | "plan";
  checkout?: "current" | "worktree";
};

export type T3CodeHandoverResult = {
  ok: true;
  data: {
    project: { id: string; title?: string };
    thread: { id: string; title?: string };
    opened?: {
      kind: "thread-deep-link" | "desktop-reveal" | "browser" | "none";
      exactThread: boolean;
      url: string | null;
    };
  };
};

export type T3CodeMenuAction = {
  label: string;
  overrides?: Partial<Omit<T3CodeHandoverRequest, "prompt">>;
};

const DEFAULT_ACTIONS: T3CodeMenuAction[] = [
  { label: "Send from current checkout", overrides: { checkout: "current" } },
  { label: "Send in a new worktree", overrides: { checkout: "worktree" } },
  { label: "Send in Plan mode", overrides: { mode: "plan" } },
];

async function postHandover(
  endpoint: string,
  request: T3CodeHandoverRequest,
): Promise<T3CodeHandoverResult> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // The error below includes the HTTP status without reflecting an HTML response.
  }
  if (!response.ok || (payload as { ok?: boolean } | null)?.ok !== true) {
    const message = (payload as { error?: { message?: string } | string } | null)?.error;
    throw new Error(
      typeof message === "string"
        ? message
        : message?.message ?? `T3 Code handover failed with HTTP ${response.status}.`,
    );
  }
  return payload as T3CodeHandoverResult;
}

export function SendToT3CodeButton({
  request,
  endpoint = "/api/t3code/handover",
  actions = DEFAULT_ACTIONS,
  disabled = false,
  className,
  onSuccess,
  onError,
}: {
  request: T3CodeHandoverRequest;
  endpoint?: string;
  actions?: T3CodeMenuAction[];
  disabled?: boolean;
  className?: string;
  onSuccess?: (result: T3CodeHandoverResult) => void;
  onError?: (error: Error) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const menuRef = useRef<HTMLDetailsElement>(null);

  const send = async (overrides?: T3CodeMenuAction["overrides"]) => {
    if (busy || disabled) return;
    menuRef.current?.removeAttribute("open");
    setBusy(true);
    setStatus("Creating T3 Code thread…");
    try {
      const result = await postHandover(endpoint, { ...request, ...overrides });
      setStatus("T3 Code thread created.");
      onSuccess?.(result);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      setStatus(error.message);
      onError?.(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={["t3code-send", className].filter(Boolean).join(" ")}>
      <div className="t3code-send__group" role="group" aria-label="Send work to T3 Code">
        <button
          className="t3code-send__primary"
          type="button"
          disabled={disabled || busy}
          onClick={() => void send()}
        >
          <span className="t3code-send__mark" aria-hidden="true">T3</span>
          <span>{busy ? "Sending…" : "Send to T3 Code"}</span>
        </button>
        {actions.length > 0 && (
          <details className="t3code-send__details" ref={menuRef}>
            <summary
              className="t3code-send__trigger"
              aria-label="T3 Code handover options"
              aria-disabled={disabled || busy}
              onClick={(event) => {
                if (disabled || busy) event.preventDefault();
              }}
            >
              <span aria-hidden="true">⌄</span>
            </summary>
            <div className="t3code-send__menu" role="menu">
              {actions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  role="menuitem"
                  disabled={disabled || busy}
                  onClick={() => void send(action.overrides)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          </details>
        )}
      </div>
      <span className="t3code-send__status" role="status" aria-live="polite">{status}</span>
    </div>
  );
}
