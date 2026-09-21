// Server module: proxies Discord channel messages for the Vent route.
// Called from the React Router `loader` (initial SSR) and `action` (polling).


const DISCORD_API = "https://discord.com/api/v10";

// Fallback messages, used ONLY on initial load when env vars are missing or
// the channel is empty. Poll responses (`after` cursor set) never return these,
// so sample IDs can never leak into the poll cursor.
const SAMPLE_MESSAGES: SanitizedMessage[] = [
  {
    id: "sample-1",
    content: "Welcome to Vent — set DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID to see real messages.",
    timestamp: new Date(Date.now() - 1000 * 60 * 42).toISOString(),
    author: {
      id: "sample-bot",
      username: "vent_bot",
      displayName: "Vent",
      avatarUrl: null,
    },
    attachments: [],
  },
  {
    id: "sample-2",
    content: "Each particle is a Discord message, spiraling in by send time.",
    timestamp: new Date(Date.now() - 1000 * 60 * 31).toISOString(),
    author: {
      id: "sample-user-1",
      username: "astro_dev",
      displayName: "Astro",
      avatarUrl: null,
    },
    attachments: [],
  },
  {
    id: "sample-3",
    content: "Older messages start closer to the event horizon.",
    timestamp: new Date(Date.now() - 1000 * 60 * 24).toISOString(),
    author: {
      id: "sample-user-2",
      username: "nova",
      displayName: "Nova",
      avatarUrl: null,
    },
    attachments: [],
  },
];

type DiscordAuthor = {
  id: string;
  username: string;
  global_name?: string | null;
  avatar: string | null;
};

type DiscordAttachment = {
  id: string;
  filename: string;
  url: string;
  proxy_url: string;
  content_type?: string | null;
  width?: number | null;
  height?: number | null;
};

type DiscordMessage = {
  id: string;
  content: string;
  timestamp: string;
  edited_timestamp: string | null;
  author: DiscordAuthor;
  attachments: DiscordAttachment[];
};

type SanitizedMessage = {
  id: string;
  content: string;
  timestamp: string;
  author: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
  };
  attachments: Array<{
    id: string;
    filename: string;
    url: string;
    contentType: string | null;
    width: number | null;
    height: number | null;
  }>;
};

type ErrorPayload = {
  error:
    | "missing_token"
    | "missing_channel"
    | "missing_intent"
    | "missing_permission"
    | "not_found"
    | "rate_limited"
    | "discord_error"
    | "upstream_error";
  message: string;
  retryAfter?: number;
};

function getEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function sanitize(msg: DiscordMessage): SanitizedMessage {
  const avatarUrl = msg.author.avatar
    ? `https://cdn.discordapp.com/avatars/${msg.author.id}/${msg.author.avatar}.png?size=64`
    : null;
  return {
    id: msg.id,
    content: msg.content,
    timestamp: msg.timestamp,
    author: {
      id: msg.author.id,
      username: msg.author.username,
      displayName: msg.author.global_name ?? msg.author.username,
      avatarUrl,
    },
    attachments: msg.attachments.map((a) => ({
      id: a.id,
      filename: a.filename,
      url: a.url,
      contentType: a.content_type ?? null,
      width: a.width ?? null,
      height: a.height ?? null,
    })),
  };
}

function classifyDiscordError(status: number, body: unknown): ErrorPayload {
  const discordMessage =
    typeof body === "object" && body !== null && "message" in body
      ? String((body as { message?: unknown }).message ?? "")
      : "";

  if (status === 401) {
    return {
      error: "missing_token",
      message:
        "The Discord bot token is invalid or missing. Set DISCORD_BOT_TOKEN in Netlify env vars (Functions scope).",
    };
  }
  if (status === 403) {
    const lower = discordMessage.toLowerCase();
    if (lower.includes("message content") || lower.includes("intent")) {
      return {
        error: "missing_intent",
        message:
          "The bot is missing the MESSAGE_CONTENT privileged intent. Enable it in the Discord Developer Portal under Bot → Privileged Gateway Intents.",
      };
    }
    return {
      error: "missing_permission",
      message:
        "The bot lacks permission to read this channel. Ensure it has View Channel and Read Message History, and is invited to the guild.",
    };
  }
  if (status === 404) {
    return {
      error: "not_found",
      message:
        "Channel not found. Check DISCORD_CHANNEL_ID and that the bot is in the guild.",
    };
  }
  if (status === 429) {
    return {
      error: "rate_limited",
      message: "Discord rate limit hit. Backing off.",
    };
  }
  return {
    error: "discord_error",
    message: `Discord API error (${status}): ${discordMessage || "unknown"}`,
  };
}

export type FetchMessagesResult =
  | {
      ok: true;
      messages: SanitizedMessage[];
      demo: boolean;
      demoReason?: DemoReason;
    }
  | {
      ok: false;
      error: ErrorPayload["error"];
      message: string;
      retryAfter?: number;
    };

type DemoReason = "missing_token" | "missing_channel" | "empty_channel";

type FetchMessagesParams = {
  limit?: number;
  after?: string;
  before?: string;
};

// Discord returns messages newest-first. Demo data must match the same
// contract so the route's `latest`/`lastIdRef` and prepend-merge logic
// behave identically in both modes.
const byNewestFirst = (a: SanitizedMessage, b: SanitizedMessage) =>
  b.timestamp.localeCompare(a.timestamp);

async function fetchFromDiscord(params: FetchMessagesParams): Promise<FetchMessagesResult> {
  const token = getEnv("DISCORD_BOT_TOKEN");
  const channelId = getEnv("DISCORD_CHANNEL_ID");

  // Demo mode: no env vars configured. Return sample messages so the
  // visualization still renders. The frontend will show a "demo mode" badge.
  if (!token || !channelId) {
    const limit = Math.min(
      SAMPLE_MESSAGES.length,
      Math.max(1, params.limit ?? 50),
    );
    return {
      ok: true,
      messages: [...SAMPLE_MESSAGES].sort(byNewestFirst).slice(0, limit),
      demo: true,
      demoReason: !token ? "missing_token" : "missing_channel",
    };
  }

  const limit = Math.min(100, Math.max(1, params.limit ?? 50));
  const discordUrl = new URL(`${DISCORD_API}/channels/${channelId}/messages`);
  discordUrl.searchParams.set("limit", String(limit));
  if (params.before) discordUrl.searchParams.set("before", params.before);
  if (params.after) discordUrl.searchParams.set("after", params.after);

  console.log(
    `[vent.server] Discord request → ${discordUrl.toString()} (token: ${token ? `Bot ${token.slice(0, 8)}…` : "MISSING"})`,
  );

  let upstream: Response;
  try {
    upstream = await fetch(discordUrl, {
      headers: {
        Authorization: `Bot ${token}`,
        "User-Agent": "VentBlackhole/1.0 (React Router)",
      },
    });
  } catch (err) {
    console.error("[vent.server] Discord fetch threw:", err);
    return {
      ok: false,
      error: "upstream_error",
      message: `Failed to reach Discord: ${(err as Error).message}`,
    };
  }

  console.log(`[vent.server] Discord responded with status ${upstream.status}`);

  if (!upstream.ok) {
    let body: unknown = null;
    try {
      body = await upstream.json();
    } catch {
      // ignore
    }
    console.error(
      `[vent.server] Discord error ${upstream.status}: body =`,
      JSON.stringify(body),
      "| Retry-After header:",
      upstream.headers.get("Retry-After"),
    );
    const classified = classifyDiscordError(upstream.status, body);
    console.error("[vent.server] Classified error payload:", classified);
    const retryAfterHeader = upstream.headers.get("Retry-After");
    const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : undefined;
    return {
      ok: false,
      error: classified.error,
      message: classified.message,
      retryAfter,
    };
  }

  const raw = (await upstream.json()) as DiscordMessage[];
  console.log(`[vent.server] Discord returned ${raw.length} message(s)`);
  const messages = raw.map(sanitize);

  // A poll (`after` cursor set) returning nothing is the normal "no new
  // messages" case — return an empty result so the client's cursor is
  // untouched. Sample data is only ever used on initial load.
  if (messages.length === 0) {
    if (params.after) {
      return { ok: true, messages: [], demo: false };
    }
    return {
      ok: true,
      messages: [...SAMPLE_MESSAGES].sort(byNewestFirst),
      demo: true,
      demoReason: "empty_channel",
    };
  }

  return { ok: true, messages, demo: false };
}

// Fetch messages: initial load (no `after`) or incremental poll (`after` set).
export async function fetchMessages(
  params: FetchMessagesParams = {},
): Promise<FetchMessagesResult> {
  console.log(
    `[vent.server] fetchMessages called with params:`,
    JSON.stringify(params),
    `| env DISCORD_BOT_TOKEN set: ${Boolean(getEnv("DISCORD_BOT_TOKEN"))} | DISCORD_CHANNEL_ID set: ${Boolean(getEnv("DISCORD_CHANNEL_ID"))}`,
  );
  const result = params.after
    ? await fetchFromDiscord({ limit: 50, ...params })
    : await fetchFromDiscord({ limit: 100, ...params });
  console.log(
    `[vent.server] fetchMessages result → ok: ${result.ok}${result.ok ? `, ${result.messages.length} msg(s), demo: ${result.demo}` : `, error: ${result.error}`}`,
  );
  return result;
}
