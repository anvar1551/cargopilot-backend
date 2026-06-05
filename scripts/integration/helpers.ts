import "dotenv/config";

type JsonObject = Record<string, unknown>;

type Session = {
  token: string;
  refreshToken?: string;
  user?: Record<string, unknown>;
};

type SseEvent = {
  id?: string;
  event: string;
  data: unknown;
};

export function getBaseUrl() {
  return String(process.env.INTEGRATION_BASE_URL || "http://localhost:4000").replace(/\/$/, "");
}

export function getRequiredEnv(name: string) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

export function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function httpJson<T = JsonObject>(args: {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  token?: string;
  body?: unknown;
}) {
  const url = `${getBaseUrl()}${args.path}`;
  const hasBody = args.body !== undefined;
  const response = await fetch(url, {
    method: args.method || "GET",
    headers: {
      ...(args.token ? { Authorization: `Bearer ${args.token}` } : {}),
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
    },
    body: hasBody ? JSON.stringify(args.body) : undefined,
  });

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!response.ok) {
    throw new Error(
      `${args.method || "GET"} ${args.path} failed (${response.status}): ${
        typeof parsed === "string" ? parsed : JSON.stringify(parsed)
      }`,
    );
  }

  return parsed as T;
}

export async function login(email: string, password: string): Promise<Session> {
  const result = await httpJson<Session>({
    method: "POST",
    path: "/api/auth/login",
    body: { email, password },
  });

  if (!result?.token) {
    throw new Error("Login succeeded but token missing in response");
  }

  return result;
}

export async function consumeSseUntil(args: {
  path: string;
  token: string;
  timeoutMs: number;
  onEvent?: (event: SseEvent) => Promise<void> | void;
  doneWhen: (state: { events: SseEvent[] }) => boolean;
}) {
  const url = `${getBaseUrl()}${args.path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("SSE timeout")), args.timeoutMs);

  const events: SseEvent[] = [];
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "text/event-stream",
      Authorization: `Bearer ${args.token}`,
    },
    signal: controller.signal,
  });

  if (!response.ok || !response.body) {
    clearTimeout(timer);
    throw new Error(`SSE connect failed ${args.path}: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "message";
  let currentId: string | undefined;
  let dataLines: string[] = [];

  const flush = async () => {
    if (dataLines.length === 0) {
      currentEvent = "message";
      currentId = undefined;
      return;
    }

    const raw = dataLines.join("\n");
    let data: unknown = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      // keep raw string
    }

    const nextEvent: SseEvent = {
      id: currentId,
      event: currentEvent,
      data,
    };
    events.push(nextEvent);

    if (args.onEvent) {
      await args.onEvent(nextEvent);
    }

    dataLines = [];
    currentEvent = "message";
    currentId = undefined;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        const lineRaw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const line = lineRaw.endsWith("\r") ? lineRaw.slice(0, -1) : lineRaw;

        if (line === "") {
          await flush();
          if (args.doneWhen({ events })) {
            controller.abort();
            return events;
          }
          idx = buffer.indexOf("\n");
          continue;
        }

        if (line.startsWith(":")) {
          idx = buffer.indexOf("\n");
          continue;
        }

        if (line.startsWith("id:")) {
          currentId = line.slice(3).trim() || undefined;
        } else if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim() || "message";
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }

        idx = buffer.indexOf("\n");
      }
    }

    return events;
  } catch (err: any) {
    if (String(err?.message || "").toLowerCase().includes("abort")) {
      if (args.doneWhen({ events })) return events;
      throw new Error(`SSE aborted before completion for ${args.path}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {
      // noop
    }
  }
}

export function pretty(value: unknown) {
  return JSON.stringify(value, null, 2);
}

export function logStep(step: string) {
  console.log(`\n[integration] ${step}`);
}
