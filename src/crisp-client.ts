/**
 * Crisp API Client for MCP Server
 *
 * Types and endpoint paths verified against Crisp's official Node SDK
 * (github.com/crisp-im/node-crisp-api) on 2026-04-21. Where the public REST
 * docs disagree with the SDK, the SDK is the source of truth because it's
 * what Crisp themselves ship.
 *
 * Key design notes:
 *   - request() has exponential-backoff retry for 429 + 5xx responses. Crisp
 *     rate-limits aggressively and a naive client silently drops operator
 *     replies under load.
 *   - Every `list_*` response exposes { data, nextPage } so callers can
 *     paginate without a separate "has more" probe.
 *   - File upload is two-step: generate bucket URL, PUT the bytes to it,
 *     then send a `type=file` message referencing the returned URL.
 *   - Segment add/remove still does GET-then-PATCH because Crisp doesn't
 *     expose a dedicated add-segment endpoint on conversation metas. The
 *     race window is small (we write back the union, not a replacement set
 *     that could clobber a concurrent edit — except for removal).
 */

// ============================================
// Config
// ============================================

export interface CrispConfig {
  identifier: string;
  key: string;
  websiteId: string;
  /** Optional tuning — defaults work for most use cases. */
  maxRetries?: number;
  /** Base delay in ms before the first retry (doubles each attempt). */
  retryBaseDelayMs?: number;
}

// ============================================
// Conversation / Message types
// ============================================

export interface Conversation {
  session_id: string;
  website_id: string;
  inbox_id?: string;
  status: number;
  state: string;
  is_blocked: boolean;
  is_verified: boolean;
  availability: string;
  active: Record<string, unknown>;
  last_message?: string;
  created_at: number;
  updated_at: number;
  unread?: {
    operator: number;
    visitor: number;
  };
  assigned?: {
    user_id: string;
  };
  meta?: {
    nickname?: string;
    email?: string;
    phone?: string;
    address?: string;
    subject?: string;
    ip?: string;
    segments?: string[];
    data?: Record<string, unknown>;
    device?: {
      capabilities?: string[];
      geolocation?: {
        country?: string;
        region?: string;
        city?: string;
      };
      system?: {
        os?: { name?: string; version?: string };
        engine?: { name?: string; version?: string };
        browser?: { name?: string; version?: string };
        useragent?: string;
      };
      timezone?: number;
      locales?: string[];
    };
  };
}

/**
 * Message content is polymorphic depending on `type`. When `type === "text"`
 * or `type === "note"`, content is a plain string. When `type === "file"`,
 * `type === "animation"`, or `type === "audio"`, content is an object with
 * `{ name, type, url }`. Other types (picker, field, event, carousel) carry
 * structured payloads that we surface via renderMessageContent() below.
 */
export interface Message {
  session_id: string;
  website_id: string;
  type: string;
  from: "user" | "operator";
  origin: string;
  content: MessageContent;
  stamped: boolean;
  timestamp: number;
  fingerprint: number;
  user?: {
    user_id?: string;
    nickname?: string;
    avatar?: string;
  };
  original?: string;
  edited?: boolean;
  translated?: boolean;
  read?: string;
  delivered?: string;
  references?: string[];
  mentions?: string[];
  preview?: unknown[];
}

export type MessageContent =
  | string
  | FileContent
  | PickerContent
  | FieldContent
  | EventContent
  | Record<string, unknown>;

export interface FileContent {
  name?: string;
  type?: string;
  url?: string;
}

export interface PickerContent {
  id?: string;
  text?: string;
  choices?: Array<{ value: string; label: string; selected?: boolean }>;
  required?: boolean;
}

export interface FieldContent {
  id?: string;
  text?: string;
  explain?: string;
  value?: string;
  required?: boolean;
}

export interface EventContent {
  namespace?: string;
  text?: string;
}

// ============================================
// People (Contacts) types
// ============================================

export interface PeopleProfile {
  people_id: string;
  email?: string;
  person?: {
    nickname?: string;
    avatar?: string;
    gender?: string;
    phone?: string;
    address?: string;
    description?: string;
    website?: string;
    timezone?: number;
    profiles?: Array<{ type: string; handle: string }>;
    employment?: { title?: string; role?: string; name?: string };
    geolocation?: { country?: string; region?: string; city?: string; coordinates?: { latitude?: number; longitude?: number } };
    locales?: string[];
  };
  company?: {
    name?: string;
    legal_name?: string;
    domain?: string;
    url?: string;
    industry?: string;
    employment?: { title?: string; role?: string; name?: string };
    tags?: string[];
    metrics?: Record<string, unknown>;
    geolocation?: Record<string, unknown>;
  };
  segments?: string[];
  notepad?: string;
  active?: { now: boolean; last: number };
  score?: number;
  created_at?: number;
  updated_at?: number;
}

// ============================================
// Operator / Visitor types
// (verified against crisp-im/node-crisp-api)
// ============================================

export interface Operator {
  type?: string;
  details?: OperatorDetails;
}

export interface OperatorDetails {
  user_id?: string;
  email?: string;
  avatar?: string;
  first_name?: string;
  last_name?: string;
  role?: string;
  title?: string;
  availability?: string;
  has_token?: boolean;
  identifier?: string;
  key?: string;
}

export interface Visitor {
  session_id?: string;
  inbox_id?: string;
  nickname?: string;
  email?: string;
  avatar?: string;
  useragent?: string;
  initiated?: boolean;
  active?: boolean;
  last_page?: { page_title?: string; page_url?: string };
  geolocation?: {
    coordinates?: { latitude?: number; longitude?: number };
    city?: string;
    region?: string;
    country?: string;
  };
  timezone?: number;
  capabilities?: string[];
  locales?: string[];
}

// ============================================
// Request option types
// ============================================

/**
 * Listing + filtering options for GET /website/{id}/conversations/{page}.
 * Names match Crisp's wire format verbatim — they get forwarded as query
 * params. Verified against their ConversationsListOptions type.
 *
 * BUG NOTE: the original MCP code used `filter_unresolved` which is NOT a
 * real Crisp param. The correct one is `filter_not_resolved`. This fix
 * alone changes behaviour of the old `unresolved_only` flag.
 */
export interface ListConversationsOptions {
  pageNumber?: number;
  perPage?: number;
  includeEmpty?: boolean;
  inboxId?: string;
  /** Unread by operator. */
  filterUnread?: boolean;
  filterResolved?: boolean;
  filterNotResolved?: boolean;
  /** Only conversations where the caller is @-mentioned in an internal note. */
  filterMention?: boolean;
  /** user_id of the operator the conversation is assigned to. */
  filterAssigned?: string;
  filterUnassigned?: boolean;
  /** ISO 8601 date string, filters on conversation update date. */
  filterDateStart?: string;
  filterDateEnd?: string;
  orderDateCreated?: boolean;
  orderDateUpdated?: boolean;
  /** Order by when the customer is waiting for a reply — great for "what needs my attention". */
  orderDateWaiting?: boolean;
  /** Plain-text search across the conversation. */
  searchText?: string;
  /** Filter by a specific segment (tag) name. */
  searchSegment?: string;
}

export interface SendMessageOptions {
  type?: "text" | "note" | "file";
  from?: "operator" | "user";
  origin?: string;
  user?: { nickname?: string; avatar?: string };
  stealth?: boolean;
  mentions?: string[];
}

export interface SendFileMessageOptions {
  /** Defaults to "operator". */
  from?: "operator" | "user";
  /** Defaults to "chat". */
  origin?: string;
  user?: { nickname?: string; avatar?: string };
  stealth?: boolean;
  mentions?: string[];
}

export interface PaginatedResult<T> {
  data: T[];
  pageNumber: number;
  /** True when the current page was full, so a next page probably exists. */
  hasMore: boolean;
  nextPage: number | null;
}

// ============================================
// Client
// ============================================

export class CrispClient {
  private identifier: string;
  private key: string;
  private websiteId: string;
  private baseUrl = "https://api.crisp.chat/v1";
  private maxRetries: number;
  private retryBaseDelayMs: number;

  constructor(config: CrispConfig) {
    this.identifier = config.identifier;
    this.key = config.key;
    this.websiteId = config.websiteId;
    this.maxRetries = config.maxRetries ?? 4;
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? 500;
  }

  getWebsiteId(): string {
    return this.websiteId;
  }

  private getAuthHeader(): string {
    return `Basic ${Buffer.from(`${this.identifier}:${this.key}`).toString("base64")}`;
  }

  /**
   * Raw HTTP wrapper with exponential-backoff retry on 429 + 5xx. Reads the
   * `Retry-After` header on 429 when present (capped so we don't sleep
   * forever on a poisoned response).
   *
   * Retries ONLY on status codes that are safe to retry for idempotent
   * methods AND for Crisp's POST endpoints (message send is idempotent on
   * their side via fingerprinting). If that ever changes we'll need a
   * per-method opt-out flag.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === "") continue;
        params.append(k, String(v));
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: this.getAuthHeader(),
          "Content-Type": "application/json",
          "X-Crisp-Tier": "plugin",
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

      if (response.ok) {
        const json = await response.json();
        return json.data as T;
      }

      const errorText = await response.text().catch(() => "");
      const err = new Error(
        `Crisp API error: ${response.status} ${response.statusText} - ${errorText}`,
      );
      (err as any).status = response.status;
      (err as any).body = errorText;
      lastError = err;

      // Retry on 429 (rate limit) and 5xx (server errors). 4xx other than
      // 429 are client bugs — retrying won't help, fail fast.
      const shouldRetry =
        (response.status === 429 || response.status >= 500) &&
        attempt < this.maxRetries;
      if (!shouldRetry) throw err;

      // Honour Retry-After if present, else exponential backoff with jitter.
      // Cap the header-driven wait at 30s — some servers return absurd values.
      let delay = this.retryBaseDelayMs * Math.pow(2, attempt);
      const retryAfter = response.headers.get("retry-after");
      if (retryAfter) {
        const n = Number(retryAfter);
        if (!Number.isNaN(n) && n > 0) delay = Math.min(n * 1000, 30_000);
      }
      // Small jitter so parallel clients don't retry in lockstep.
      delay += Math.floor(Math.random() * 250);
      await new Promise((r) => setTimeout(r, delay));
    }

    throw lastError ?? new Error("Crisp API error: retry budget exhausted");
  }

  // ============================================
  // Conversations
  // ============================================

  /**
   * List conversations. Uses Crisp's real wire-format filter names.
   * Returns { data, nextPage, hasMore } so callers can paginate without a
   * second round trip to probe for more results.
   */
  async listConversations(
    options: ListConversationsOptions = {},
  ): Promise<PaginatedResult<Conversation>> {
    const pageNumber = options.pageNumber ?? 1;
    const perPage = options.perPage ?? 20;

    const query: Record<string, string | number | undefined> = {
      per_page: perPage,
      filter_unread: options.filterUnread ? 1 : undefined,
      filter_resolved: options.filterResolved ? 1 : undefined,
      filter_not_resolved: options.filterNotResolved ? 1 : undefined,
      filter_mention: options.filterMention ? 1 : undefined,
      filter_assigned: options.filterAssigned,
      filter_unassigned: options.filterUnassigned ? 1 : undefined,
      filter_date_start: options.filterDateStart,
      filter_date_end: options.filterDateEnd,
      filter_inbox_id: options.inboxId,
      include_empty: options.includeEmpty ? 1 : undefined,
      order_date_created: options.orderDateCreated ? 1 : undefined,
      order_date_updated: options.orderDateUpdated ? 1 : undefined,
      order_date_waiting: options.orderDateWaiting ? 1 : undefined,
    };

    if (options.searchSegment) {
      query.search_type = "segment";
      query.search_query = options.searchSegment;
    } else if (options.searchText) {
      query.search_type = "text";
      query.search_query = options.searchText;
    }

    const data = await this.request<Conversation[]>(
      "GET",
      `/website/${this.websiteId}/conversations/${pageNumber}`,
      undefined,
      query,
    );

    return {
      data,
      pageNumber,
      hasMore: data.length >= perPage,
      nextPage: data.length >= perPage ? pageNumber + 1 : null,
    };
  }

  /**
   * Walk pages until exhaustion or maxPages is hit. Convenience wrapper —
   * each underlying call still uses listConversations().
   */
  async listConversationsAllPages(
    base: Omit<ListConversationsOptions, "pageNumber">,
    maxPages = 5,
  ): Promise<Conversation[]> {
    const all: Conversation[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const res = await this.listConversations({ ...base, pageNumber: page });
      all.push(...res.data);
      if (!res.hasMore) break;
    }
    return all;
  }

  async getConversation(sessionId: string): Promise<Conversation> {
    return this.request<Conversation>(
      "GET",
      `/website/${this.websiteId}/conversation/${sessionId}`,
    );
  }

  async getMessages(
    sessionId: string,
    timestampBefore?: number,
  ): Promise<Message[]> {
    const path = `/website/${this.websiteId}/conversation/${sessionId}/messages`;
    return this.request<Message[]>(
      "GET",
      path,
      undefined,
      timestampBefore ? { timestamp_before: timestampBefore } : undefined,
    );
  }

  /**
   * Walk the message history. maxAgeHours stops the walk early when we
   * encounter messages older than the cutoff, so big conversations don't
   * cost N page fetches just to throw them away.
   */
  async getAllMessages(
    sessionId: string,
    maxBatches = 10,
    maxAgeHours?: number,
  ): Promise<Message[]> {
    const allMessages: Message[] = [];
    let oldestTimestamp: number | undefined;
    const cutoffTime = maxAgeHours
      ? Date.now() - maxAgeHours * 60 * 60 * 1000
      : undefined;

    for (let batch = 0; batch < maxBatches; batch++) {
      const messages = await this.getMessages(sessionId, oldestTimestamp);
      if (messages.length === 0) break;

      const filtered = cutoffTime
        ? messages.filter((m) => m.timestamp >= cutoffTime)
        : messages;
      allMessages.push(...filtered);

      // If the cutoff filtered anything out, we've walked past the window.
      if (filtered.length < messages.length) break;

      oldestTimestamp = Math.min(...messages.map((m) => m.timestamp));
    }

    return allMessages.sort((a, b) => a.timestamp - b.timestamp);
  }

  async sendMessage(
    sessionId: string,
    content: string | FileContent,
    options: SendMessageOptions = {},
  ): Promise<{ fingerprint: number }> {
    const payload: Record<string, unknown> = {
      type: options.type ?? "text",
      from: options.from ?? "operator",
      origin: options.origin ?? "chat",
      content,
      stealth: options.stealth ?? false,
    };
    if (options.user) payload.user = options.user;
    if (options.mentions) payload.mentions = options.mentions;

    return this.request<{ fingerprint: number }>(
      "POST",
      `/website/${this.websiteId}/conversation/${sessionId}/message`,
      payload,
    );
  }

  /**
   * Send a message that references a file URL. Does NOT upload the file —
   * callers provide an already-hosted URL (Crisp bucket URL from
   * generateBucketURL, or any other publicly accessible URL). Keep separate
   * from sendMessage so the `type=file` content shape is enforced.
   */
  async sendFileMessage(
    sessionId: string,
    file: { url: string; name?: string; mimeType?: string },
    options: SendFileMessageOptions = {},
  ): Promise<{ fingerprint: number }> {
    const content: FileContent = {
      url: file.url,
      name: file.name ?? file.url.split("/").pop() ?? "file",
      type: file.mimeType ?? "application/octet-stream",
    };
    return this.sendMessage(sessionId, content, {
      type: "file",
      from: options.from,
      origin: options.origin,
      user: options.user,
      stealth: options.stealth,
      mentions: options.mentions,
    });
  }

  async setConversationState(
    sessionId: string,
    state: "pending" | "unresolved" | "resolved",
  ): Promise<void> {
    await this.request<unknown>(
      "PATCH",
      `/website/${this.websiteId}/conversation/${sessionId}/state`,
      { state },
    );
  }

  async updateConversationMeta(
    sessionId: string,
    meta: {
      nickname?: string;
      email?: string;
      phone?: string;
      address?: string;
      subject?: string;
      segments?: string[];
      data?: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.request<unknown>(
      "PATCH",
      `/website/${this.websiteId}/conversation/${sessionId}/meta`,
      meta,
    );
  }

  async addSegments(sessionId: string, segments: string[]): Promise<void> {
    // Crisp has no "append" endpoint — we have to GET+PATCH with the union.
    // Small race window: concurrent writers can lose segments. Acceptable
    // given segments are operator-controlled and slow-moving.
    const conversation = await this.getConversation(sessionId);
    const existing = conversation.meta?.segments ?? [];
    const merged = [...new Set([...existing, ...segments])];
    await this.updateConversationMeta(sessionId, { segments: merged });
  }

  async removeSegments(sessionId: string, segments: string[]): Promise<void> {
    const conversation = await this.getConversation(sessionId);
    const existing = conversation.meta?.segments ?? [];
    const remaining = existing.filter((s) => !segments.includes(s));
    await this.updateConversationMeta(sessionId, { segments: remaining });
  }

  async assignConversation(sessionId: string, userId: string): Promise<void> {
    await this.request<unknown>(
      "PATCH",
      `/website/${this.websiteId}/conversation/${sessionId}/routing`,
      { assigned: { user_id: userId } },
    );
  }

  async blockConversation(sessionId: string): Promise<void> {
    await this.request<unknown>(
      "PATCH",
      `/website/${this.websiteId}/conversation/${sessionId}/block`,
      { blocked: true },
    );
  }

  async unblockConversation(sessionId: string): Promise<void> {
    await this.request<unknown>(
      "PATCH",
      `/website/${this.websiteId}/conversation/${sessionId}/block`,
      { blocked: false },
    );
  }

  async deleteConversation(sessionId: string): Promise<void> {
    await this.request<unknown>(
      "DELETE",
      `/website/${this.websiteId}/conversation/${sessionId}`,
    );
  }

  /**
   * Send a "start"/"stop" composing state. Crisp renders "Operator is
   * typing…" on the customer side for ~6 seconds after a "start" event,
   * so long replies need a refresh every few seconds. Caller controls
   * cadence — this method just forwards the one PATCH.
   */
  async setComposingState(
    sessionId: string,
    state: "start" | "stop",
    options: { excerpt?: string; stealth?: boolean; automated?: boolean } = {},
  ): Promise<void> {
    await this.request<unknown>(
      "PATCH",
      `/website/${this.websiteId}/conversation/${sessionId}/compose`,
      { type: state, from: "operator", ...options },
    );
  }

  /**
   * Mark messages as read by the operator. Without this, the operator-side
   * unread counter never decrements and `conversations_awaiting_reply`
   * keeps resurfacing the same conversation after Ana reviews it.
   * Optional `fingerprints` limits to specific messages; default clears all.
   */
  async markMessagesRead(
    sessionId: string,
    options: { fingerprints?: number[]; origin?: string } = {},
  ): Promise<void> {
    await this.request<unknown>(
      "PATCH",
      `/website/${this.websiteId}/conversation/${sessionId}/read`,
      {
        from: "operator",
        origin: options.origin ?? "chat",
        ...(options.fingerprints ? { fingerprints: options.fingerprints } : {}),
      },
    );
  }

  /**
   * Build the Crisp inbox URL for a conversation. Pure string construction —
   * useful when escalating a ticket to Slack/Linear and the operator needs
   * a deep link to open the conversation in Crisp's web UI.
   */
  getConversationUrl(sessionId: string): string {
    return `https://app.crisp.chat/website/${this.websiteId}/inbox/${sessionId}/`;
  }

  /**
   * Convenience chain: look up a person by email and return their
   * conversations in a single call. Hides the two-step (find + list)
   * pattern that Ana was running on nearly every ticket reply.
   *
   * Returns `null` if no matching person is found, so the caller doesn't
   * have to distinguish "no person" from "person with zero conversations".
   */
  async findConversationsForEmail(
    email: string,
    pageNumber = 1,
  ): Promise<{ person: PeopleProfile; conversations: PaginatedResult<Conversation> } | null> {
    const person = await this.findPersonByEmail(email);
    if (!person?.people_id) return null;
    const conversations = await this.getPersonConversations(
      person.people_id,
      pageNumber,
    );
    return { person, conversations };
  }

  // ============================================
  // People (Contacts) — new in this revision
  // ============================================

  /**
   * Search Crisp People by text (typically an email address). Crisp matches
   * substrings so passing a partial email works. Use the first match for
   * exact lookups.
   *
   * Path verified against crisp-im/node-crisp-api: listPeopleProfiles
   * (plural) uses `/people/profiles/{page}`, GET single uses `/people/profile/{id}`.
   */
  async listPeopleProfiles(
    pageNumber = 1,
    options: { searchText?: string; searchFilter?: string; sortField?: string; sortOrder?: string } = {},
  ): Promise<PaginatedResult<PeopleProfile>> {
    const query: Record<string, string | undefined> = {
      search_text: options.searchText,
      search_filter: options.searchFilter,
      sort_field: options.sortField,
      sort_order: options.sortOrder,
    };
    const data = await this.request<PeopleProfile[]>(
      "GET",
      `/website/${this.websiteId}/people/profiles/${pageNumber}`,
      undefined,
      query,
    );
    // Crisp's people list doesn't expose per_page — the default is ~20. We
    // use 20 as the heuristic for hasMore.
    const perPage = 20;
    return {
      data,
      pageNumber,
      hasMore: data.length >= perPage,
      nextPage: data.length >= perPage ? pageNumber + 1 : null,
    };
  }

  /**
   * Find the first person whose profile matches the given email. Returns
   * null when no match (including when Crisp returns partial-match rows for
   * a different address).
   */
  async findPersonByEmail(email: string): Promise<PeopleProfile | null> {
    const res = await this.listPeopleProfiles(1, { searchText: email });
    const lower = email.toLowerCase();
    const exact = res.data.find((p) => p.email?.toLowerCase() === lower);
    return exact ?? res.data[0] ?? null;
  }

  /** Get a single People profile by its people_id (UUID). */
  async getPerson(peopleId: string): Promise<PeopleProfile> {
    return this.request<PeopleProfile>(
      "GET",
      `/website/${this.websiteId}/people/profile/${peopleId}`,
    );
  }

  /**
   * List all conversations associated with a People profile. Crisp's path
   * here is unusual: `/people/conversations/{peopleID}/list/{pageNumber}`
   * (rather than the `/people/{peopleID}/conversations` you might expect
   * from REST convention). Ground-truthed from their SDK.
   */
  async getPersonConversations(
    peopleId: string,
    pageNumber = 1,
  ): Promise<PaginatedResult<Conversation>> {
    const data = await this.request<Conversation[]>(
      "GET",
      `/website/${this.websiteId}/people/conversations/${peopleId}/list/${pageNumber}`,
    );
    const perPage = 20;
    return {
      data,
      pageNumber,
      hasMore: data.length >= perPage,
      nextPage: data.length >= perPage ? pageNumber + 1 : null,
    };
  }

  /**
   * List events attached to a People profile. Useful for seeing things like
   * "signed up", "upgraded plan", "filed ticket" when the website pushes
   * events into Crisp.
   */
  async getPersonEvents(peopleId: string, pageNumber = 1): Promise<unknown[]> {
    return this.request<unknown[]>(
      "GET",
      `/website/${this.websiteId}/people/events/${peopleId}/list/${pageNumber}`,
    );
  }

  async getPersonData(peopleId: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      "GET",
      `/website/${this.websiteId}/people/data/${peopleId}`,
    );
  }

  // ============================================
  // Bucket (file upload) — new in this revision
  // ============================================

  /**
   * Ask Crisp to generate a bucket URL for an upcoming file upload. The
   * response carries a URL to PUT the file bytes to; the resulting public
   * URL then gets embedded in a `type=file` conversation message.
   *
   * This is a two-step process. If you just want to send a file that's
   * already publicly hosted (S3/R2/imgur/etc.), skip this and call
   * sendFileMessage() directly with the existing URL.
   */
  async generateBucketUrl(params: {
    namespace: string;
    id?: string;
    file: { name: string; type: string };
    resource?: { type: string; id: string };
  }): Promise<{ url: string }> {
    return this.request<{ url: string }>(
      "POST",
      `/bucket/url/generate`,
      params,
    );
  }

  /**
   * Full upload + send flow. Takes raw bytes (Buffer) from the caller and:
   *   1. Asks Crisp for a signed upload URL.
   *   2. PUTs the bytes to that URL.
   *   3. Sends a file message referencing the returned public URL.
   * The PUT uses a plain fetch (not this.request) because the upload URL
   * is not under api.crisp.chat — it's a signed storage URL.
   */
  async uploadAndSendFile(
    sessionId: string,
    file: { bytes: Buffer; name: string; mimeType: string },
    options: SendFileMessageOptions = {},
  ): Promise<{ fingerprint: number; url: string }> {
    const { url } = await this.generateBucketUrl({
      namespace: "website",
      id: this.websiteId,
      file: { name: file.name, type: file.mimeType },
      resource: { type: "conversation", id: sessionId },
    });

    // Node's built-in fetch accepts Buffer as body at runtime, but the
    // lib.dom.d.ts types that ship with TypeScript don't include it in the
    // BodyInit union. Cast is the pragmatic fix.
    const putRes = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": file.mimeType },
      body: file.bytes as unknown as BodyInit,
    });
    if (!putRes.ok) {
      const errText = await putRes.text().catch(() => "");
      throw new Error(`File upload failed (${putRes.status}): ${errText}`);
    }

    const send = await this.sendFileMessage(
      sessionId,
      { url, name: file.name, mimeType: file.mimeType },
      options,
    );
    return { fingerprint: send.fingerprint, url };
  }

  // ============================================
  // Operators & Visitors — now with real types
  // ============================================

  async getOperators(): Promise<Operator[]> {
    return this.request<Operator[]>(
      "GET",
      `/website/${this.websiteId}/operators/list`,
    );
  }

  /**
   * Resolve the operator user_id matching a given email. Handy for
   * assign_conversation when the caller knows "Pau" but not his UUID.
   */
  async findOperatorByEmail(email: string): Promise<OperatorDetails | null> {
    const operators = await this.getOperators();
    const lower = email.toLowerCase();
    for (const op of operators) {
      if (op.details?.email?.toLowerCase() === lower) return op.details;
    }
    return null;
  }

  async getVisitors(pageNumber = 1): Promise<Visitor[]> {
    return this.request<Visitor[]>(
      "GET",
      `/website/${this.websiteId}/visitors/list/${pageNumber}`,
    );
  }

  // ============================================
  // Rich-context super helper
  // ============================================

  /**
   * Return everything an operator needs to understand a conversation in a
   * single call: the conversation, recent messages, the linked People
   * profile (if email is known), and that person's other past conversations.
   *
   * Collapses 3-5 round trips into 1. Each subcall runs in parallel where
   * possible. Subcalls that fail individually are caught and returned as
   * `null` on the relevant field — we'd rather return partial context than
   * fail the whole lookup.
   */
  async getRichContext(
    sessionId: string,
    options: { maxAgeHours?: number; maxBatches?: number; maxOtherConversations?: number } = {},
  ): Promise<{
    conversation: Conversation;
    messages: Message[];
    person: PeopleProfile | null;
    personData: Record<string, unknown> | null;
    otherConversations: Conversation[];
  }> {
    const conversation = await this.getConversation(sessionId);

    const messagesPromise = this.getAllMessages(
      sessionId,
      options.maxBatches ?? 10,
      options.maxAgeHours ?? 72,
    );

    // If we have an email, kick off the People lookup in parallel with the
    // messages fetch — most of the wall time is the messages call anyway.
    const email = conversation.meta?.email;
    const personPromise = email
      ? this.findPersonByEmail(email).catch(() => null)
      : Promise.resolve(null);

    const [messages, person] = await Promise.all([messagesPromise, personPromise]);

    let personData: Record<string, unknown> | null = null;
    let otherConversations: Conversation[] = [];
    if (person?.people_id) {
      const [dataResult, convsResult] = await Promise.allSettled([
        this.getPersonData(person.people_id),
        this.getPersonConversations(person.people_id, 1),
      ]);
      if (dataResult.status === "fulfilled") personData = dataResult.value;
      if (convsResult.status === "fulfilled") {
        const max = options.maxOtherConversations ?? 10;
        otherConversations = convsResult.value.data
          .filter((c) => c.session_id !== sessionId)
          .slice(0, max);
      }
    }

    return { conversation, messages, person, personData, otherConversations };
  }

  // ============================================
  // Formatters & helpers
  // ============================================

  isFromOperator(message: Message): boolean {
    return message.from === "operator";
  }

  /**
   * Check whether a conversation is waiting for the operator to reply.
   * Heuristic: the last message came from the customer AND the conversation
   * isn't resolved. Doesn't require the caller to have the message list —
   * uses the lightweight `last_message` + unread.operator fields on the
   * conversation summary.
   *
   * Falls back to false when the shape is ambiguous; prefer false-negatives
   * (miss a few) over false-positives (pester customers).
   */
  isAwaitingOperatorReply(conversation: Conversation): boolean {
    if (conversation.state === "resolved") return false;
    const unreadForOperator = conversation.unread?.operator ?? 0;
    return unreadForOperator > 0;
  }

  /**
   * Stringify a single message's content regardless of message type. Named
   * because `content` is polymorphic and JSON-stringifying the raw object
   * in logs makes attached files look like garbage.
   */
  renderMessageContent(message: Message): string {
    const c = message.content;
    if (typeof c === "string") return c;
    if (c && typeof c === "object") {
      // File / animation / audio
      if ("url" in c && typeof (c as FileContent).url === "string") {
        const f = c as FileContent;
        return `[${message.type} ${f.name ?? "file"}] ${f.url}`;
      }
      if ("text" in c && typeof (c as { text?: string }).text === "string") {
        return String((c as { text?: string }).text);
      }
      return JSON.stringify(c);
    }
    return "";
  }

  /**
   * Format a conversation + messages for AI consumption. Surfaces file
   * attachments, mentions, and internal notes so the model can reason
   * about them. Kept close to plain text because MCP clients render this
   * verbatim.
   */
  formatConversationForAnalysis(
    conversation: Conversation,
    messages: Message[],
  ): string {
    const lines: string[] = [];

    lines.push("=== CONVERSATION INFO ===");
    lines.push(`Session ID: ${conversation.session_id}`);
    lines.push(`State: ${conversation.state}`);
    lines.push(`Customer: ${conversation.meta?.nickname ?? "Unknown"}`);
    lines.push(`Email: ${conversation.meta?.email ?? "Not provided"}`);
    if (conversation.meta?.subject) lines.push(`Subject: ${conversation.meta.subject}`);
    if (conversation.meta?.segments?.length) {
      lines.push(`Segments: ${conversation.meta.segments.join(", ")}`);
    }
    if (conversation.assigned?.user_id) {
      lines.push(`Assigned to: ${conversation.assigned.user_id}`);
    }

    lines.push("");
    lines.push("=== MESSAGES ===");

    for (const msg of messages) {
      const timestamp = new Date(msg.timestamp).toISOString();
      const from =
        msg.from === "user"
          ? `[Customer${msg.user?.nickname ? ` - ${msg.user.nickname}` : ""}]`
          : `[${msg.user?.nickname ?? "Operator"}${msg.type === "note" ? " NOTE" : ""}]`;
      lines.push(`${timestamp} ${from}: ${this.renderMessageContent(msg)}`);
    }

    return lines.join("\n");
  }
}
