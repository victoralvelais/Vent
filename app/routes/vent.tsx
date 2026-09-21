import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import type { Route } from "./+types/vent";
import { BlackHoleCanvas, type BlackHoleMessage } from "../components/BlackHoleCanvas";
import { fetchMessages } from "../server/vent.server";

// Polling is deliberately slow — manual refresh is the primary update path
// while developing. One Discord request per interval, single timer chain.
const POLL_INTERVAL_MS = 30 * 60 * 1000;
const MAX_IN_MEMORY = 500;

type DemoReason = "missing_token" | "missing_channel" | "empty_channel";

type LoaderData = {
  messages: BlackHoleMessage[];
  demo: boolean;
  demoReason?: DemoReason;
};

type ActionData =
  | { ok: true; messages: BlackHoleMessage[] }
  | { ok: false; error: string; message: string; retryAfter?: number };

export async function loader(_args: Route.LoaderArgs) {
  console.log("[vent.loader] running");
  const result = await fetchMessages({ limit: 100 });
  console.log("[vent.loader] result:", JSON.stringify(result).slice(0, 2000));
  if (!result.ok) {
    console.error("[vent.loader] throwing 502 for message:", result.message);
    throw new Response(result.message, { status: 502 });
  }
  return {
    messages: result.messages,
    demo: result.demo,
    demoReason: result.demoReason,
  } satisfies LoaderData;
}

export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData();
  const after = formData.get("after");
  const limitRaw = formData.get("limit");
  const limit = limitRaw ? Number(limitRaw) : 50;
  console.log(`[vent.action] poll request | after: ${after} | limit: ${limit}`);

  const result = await fetchMessages({
    after: typeof after === "string" && after.length > 0 ? after : undefined,
    limit: Number.isFinite(limit) ? limit : 50,
  });
  console.log(
    `[vent.action] result → ${result.ok ? `ok, ${result.messages.length} msg(s)` : `error: ${JSON.stringify(result)}`}`,
  );

  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      message: result.message,
      retryAfter: result.retryAfter,
    } satisfies ActionData;
  }

  // Polls never return demo data (the server guarantees this when `after`
  // is set), so the action response carries messages only.
  return { ok: true, messages: result.messages } satisfies ActionData;
}

export function meta(_args: Route.MetaArgs) {
  return [
    { title: "Vent — Discord Black Hole" },
    {
      name: "description",
      content:
        "Watch Discord messages spiral into a black hole, ordered by when they were sent.",
    },
  ];
}

export default function BlackholeRoute({ loaderData }: Route.ComponentProps) {
  const [messages, setMessages] = useState<BlackHoleMessage[]>(loaderData.messages);
  const [error, setError] = useState<string | null>(null);
  const [latest, setLatest] = useState<BlackHoleMessage | null>(
    loaderData.messages[0] ?? null,
  );
  const lastIdRef = useRef<string | null>(loaderData.messages[0]?.id ?? null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetcher = useFetcher<ActionData>();

  // Single poll scheduler: clear any pending timer, then schedule the next
  // submit. All branches (success, error, retry) funnel through here so
  // there is exactly one timer chain for the lifetime of the component.
  const schedulePoll = (delay: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const formData = new FormData();
      if (lastIdRef.current) formData.set("after", lastIdRef.current);
      formData.set("limit", "50");
      fetcher.submit(formData, { method: "post" });
    }, delay);
  };

  useEffect(() => {
    console.log("[vent.route] mounted — scheduling first poll in", POLL_INTERVAL_MS, "ms");
    schedulePoll(POLL_INTERVAL_MS);
    return () => {
      console.log("[vent.route] unmounting — clearing pending poll timer");
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // React to fetcher results and schedule the next poll.
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;

    const result = fetcher.data;
    console.log("[vent.route] fetcher result:", JSON.stringify(result).slice(0, 1000));

    if (!result.ok) {
      // Config errors: stop polling, show the error card.
      if (
        result.error === "missing_token" ||
        result.error === "missing_channel" ||
        result.error === "missing_intent" ||
        result.error === "missing_permission" ||
        result.error === "not_found"
      ) {
        console.error("[vent.route] fatal config error, stopping polls:", result);
        setError(result.message);
        return;
      }
      // Rate limit or transient error: back off and poll again.
      const delay =
        result.error === "rate_limited" && result.retryAfter
          ? Math.max(POLL_INTERVAL_MS, result.retryAfter * 1000)
          : POLL_INTERVAL_MS;
      console.warn(`[vent.route] retryable error "${result.error}", next poll in ${delay}ms`);
      schedulePoll(delay);
      return;
    }

    console.log(`[vent.route] poll returned ${result.messages.length} new message(s)`);

    if (result.messages.length > 0) {
      // Dedupe by ID — Discord's `?after=<id>` can occasionally return
      // messages already in the list (e.g., on retry after a transient error).
      setMessages((prev) => {
        const existingIds = new Set(prev.map((m) => m.id));
        const fresh = result.messages.filter((m) => !existingIds.has(m.id));
        // Newest-first ordering: fresh messages go at the front.
        const merged = [...fresh, ...prev];
        return merged.length > MAX_IN_MEMORY
          ? merged.slice(0, MAX_IN_MEMORY)
          : merged;
      });
      const newest = result.messages[0];
      lastIdRef.current = newest.id;
      setLatest(newest);
    }

    schedulePoll(POLL_INTERVAL_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  if (error) {
    return (
      <div className="bh-error">
        <div className="bh-error-card">
          <h1>Cannot reach Discord</h1>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  const isDemo = loaderData.demo;
  const demoReason = loaderData.demoReason;
  const demoHint =
    demoReason === "missing_token"
      ? "Set DISCORD_BOT_TOKEN to see real messages."
      : demoReason === "missing_channel"
        ? "Set DISCORD_CHANNEL_ID to see real messages."
        : demoReason === "empty_channel"
          ? "Discord channel is empty — showing sample messages."
          : "Showing sample messages.";

  return (
    <>
      <BlackHoleCanvas messages={messages} />
      <div className="bh-overlay">
        <div className="bh-panel bh-panel--top-left">
          <h2>
            Vent {isDemo && <span className="bh-demo-badge">demo</span>}
          </h2>
          <div className="bh-sub">
            {`${messages.length} message${messages.length === 1 ? "" : "s"} in orbit`}
          </div>
          {isDemo && <div className="bh-sub">{demoHint}</div>}
        </div>
        {latest && (
          <div className="bh-panel bh-panel--bottom-right">
            <h2>{latest.author.displayName}</h2>
            <div>{latest.content || <em>(empty message)</em>}</div>
            <div className="bh-sub">
              {new Date(latest.timestamp).toLocaleString()}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
