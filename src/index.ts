#!/usr/bin/env node

/**
 * Crisp MCP Server
 *
 * An MCP server that provides tools for interacting with the Crisp
 * customer support platform. See README.md for tool-by-tool docs.
 *
 * This revision (v1.1.0) adds five major capability areas on top of the
 * original tool set:
 *   - People / Contacts lookup (find by email, past conversations, profile)
 *   - A "rich context" super-tool that assembles everything Ana needs
 *     about a ticket in one call
 *   - File attachment send (by URL) and better inbound file rendering
 *   - Exponential-backoff retry for 429 + 5xx on every request
 *   - Smart conversation filters (awaiting-reply, assigned-to-me, by segment)
 *
 * See crisp-client.ts for the underlying HTTP client; this file only wires
 * up the MCP tool schemas and dispatches calls.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  CrispClient,
  Conversation,
  Message,
  PeopleProfile,
  OperatorDetails,
} from "./crisp-client.js";

// Get configuration from environment variables
const CRISP_IDENTIFIER = process.env.CRISP_IDENTIFIER;
const CRISP_KEY = process.env.CRISP_KEY;
const CRISP_WEBSITE_ID = process.env.CRISP_WEBSITE_ID;

if (!CRISP_IDENTIFIER || !CRISP_KEY || !CRISP_WEBSITE_ID) {
  console.error(
    "Error: CRISP_IDENTIFIER, CRISP_KEY, and CRISP_WEBSITE_ID environment variables are required",
  );
  process.exit(1);
}

const crispClient = new CrispClient({
  identifier: CRISP_IDENTIFIER,
  key: CRISP_KEY,
  websiteId: CRISP_WEBSITE_ID,
});

// ============================================
// Tool schemas
// ============================================

const tools: Tool[] = [
  // ── Conversation discovery ──────────────────
  {
    name: "list_conversations",
    description:
      "List conversations with optional filters. Returns `{ data, pageNumber, hasMore, nextPage }` so callers know whether to fetch more. Filters are OR-combined with the standard search.",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "number", description: "Page number (default: 1)" },
        per_page: { type: "number", description: "Items per page (default: 20)" },
        search: { type: "string", description: "Plain-text search across conversations" },
        segment: { type: "string", description: "Filter to conversations tagged with this segment" },
        unresolved_only: { type: "boolean", description: "Only return unresolved conversations" },
        unread_only: { type: "boolean", description: "Only conversations unread by the operator" },
        assigned_to: { type: "string", description: "Operator user_id the conversation is assigned to" },
        unassigned_only: { type: "boolean", description: "Only return unassigned conversations" },
        mention_only: { type: "boolean", description: "Only conversations where you are @-mentioned in internal notes" },
        order_by_waiting: { type: "boolean", description: "Sort by how long the customer has been waiting (best for triage)" },
      },
    },
  },
  {
    name: "get_unresolved_conversations",
    description:
      "Shortcut for all unresolved conversations across multiple pages. Returns a flat array (no pagination metadata). Use `conversations_awaiting_reply` if you specifically want ones where a customer is waiting on YOU.",
    inputSchema: {
      type: "object",
      properties: {
        max_pages: { type: "number", description: "Max pages to walk (default: 5)" },
      },
    },
  },
  {
    name: "conversations_awaiting_reply",
    description:
      "List unresolved conversations where the customer is currently waiting on an operator reply (unread_by_operator > 0). Ordered so the longest-waiting appear first. This is the single most useful 'what should I work on' tool.",
    inputSchema: {
      type: "object",
      properties: {
        max_pages: { type: "number", description: "Max pages to walk (default: 3)" },
      },
    },
  },
  {
    name: "conversations_assigned_to_me",
    description: "List conversations assigned to a specific operator (pass their user_id).",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "Operator user_id" },
        unresolved_only: { type: "boolean", description: "Default true" },
        max_pages: { type: "number", description: "Max pages (default: 3)" },
      },
      required: ["user_id"],
    },
  },
  {
    name: "conversations_by_segment",
    description: "List conversations tagged with a specific segment (e.g. `refund`, `bug`, `billing`).",
    inputSchema: {
      type: "object",
      properties: {
        segment: { type: "string", description: "Segment name (tag)" },
        unresolved_only: { type: "boolean" },
        max_pages: { type: "number", description: "Default: 3" },
      },
      required: ["segment"],
    },
  },
  {
    name: "search_conversations",
    description: "Plain-text search across conversations.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },

  // ── Conversation detail ─────────────────────
  {
    name: "get_conversation",
    description: "Get detailed information about a specific conversation.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
    },
  },
  {
    name: "get_messages",
    description: "Get message history for a conversation. File/animation/audio messages have their URLs surfaced in the output.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        max_age_hours: { type: "number", description: "Only return messages newer than this" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "get_conversation_with_messages",
    description:
      "Get a conversation with messages formatted for analysis. Good for small-context summaries. For full customer history + cross-conversation context use `get_rich_context` instead.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        max_age_hours: { type: "number", description: "Default: 48" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "get_rich_context",
    description:
      "HEAVY CONTEXT: returns conversation + messages + linked Crisp People profile + that person's past conversations + custom data, all in one call. Replaces 4-5 round trips. Use this at the start of any non-trivial ticket reply.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        max_age_hours: { type: "number", description: "Default: 72" },
        max_other_conversations: { type: "number", description: "Default: 10" },
      },
      required: ["session_id"],
    },
  },

  // ── Messaging ───────────────────────────────
  {
    name: "send_message",
    description: "Send a text message or internal note to a conversation.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        content: { type: "string" },
        type: {
          type: "string",
          enum: ["text", "note"],
          description: "'text' for customer-visible, 'note' for internal. Default: text",
        },
        nickname: { type: "string", description: "Sender display name (default: 'Support')" },
        mentions: {
          type: "array",
          items: { type: "string" },
          description: "Operator user_ids to @-mention in an internal note",
        },
      },
      required: ["session_id", "content"],
    },
  },
  {
    name: "send_file_message",
    description:
      "Attach a file to a conversation by URL (no upload). Good when the file is already hosted (S3/R2/imgur/etc.). If you need to push raw bytes through Crisp's bucket, use the Crisp web UI or call the client's `uploadAndSendFile` method directly.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        url: { type: "string", description: "Publicly accessible URL to the file" },
        name: { type: "string", description: "Filename to display to the customer (default: derived from URL)" },
        mime_type: { type: "string", description: "e.g. image/png, application/pdf (default: application/octet-stream)" },
        nickname: { type: "string", description: "Sender display name (default: 'Support')" },
      },
      required: ["session_id", "url"],
    },
  },

  // ── Conversation state ──────────────────────
  {
    name: "set_conversation_state",
    description: "Change conversation state (pending / unresolved / resolved).",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        state: { type: "string", enum: ["pending", "unresolved", "resolved"] },
      },
      required: ["session_id", "state"],
    },
  },
  {
    name: "update_conversation_meta",
    description: "Update conversation metadata (email, nickname, subject, segments).",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        email: { type: "string" },
        nickname: { type: "string" },
        subject: { type: "string" },
        segments: { type: "array", items: { type: "string" } },
      },
      required: ["session_id"],
    },
  },
  {
    name: "add_segments",
    description: "Add segments (tags) to a conversation. Idempotent — existing segments are preserved.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        segments: { type: "array", items: { type: "string" } },
      },
      required: ["session_id", "segments"],
    },
  },
  {
    name: "remove_segments",
    description: "Remove specific segments from a conversation.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        segments: { type: "array", items: { type: "string" } },
      },
      required: ["session_id", "segments"],
    },
  },

  // ── Conversation actions ────────────────────
  {
    name: "assign_conversation",
    description: "Assign a conversation to an operator by user_id. Tip: use `find_operator_by_email` if you know their email but not their user_id.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        user_id: { type: "string" },
      },
      required: ["session_id", "user_id"],
    },
  },
  {
    name: "block_conversation",
    description: "Block a conversation (spam/abuse).",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
    },
  },
  {
    name: "unblock_conversation",
    description: "Unblock a previously blocked conversation.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
    },
  },
  {
    name: "delete_conversation",
    description: "Permanently delete a conversation. Cannot be undone.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
    },
  },

  // ── People (Contacts) ───────────────────────
  {
    name: "find_person_by_email",
    description:
      "Find a Crisp People profile by email. Returns the profile with its stable `people_id` which other person_* tools need. Returns null if no match.",
    inputSchema: {
      type: "object",
      properties: { email: { type: "string" } },
      required: ["email"],
    },
  },
  {
    name: "get_person",
    description: "Get a full People profile by `people_id` (UUID, returned from `find_person_by_email`).",
    inputSchema: {
      type: "object",
      properties: { people_id: { type: "string" } },
      required: ["people_id"],
    },
  },
  {
    name: "get_person_conversations",
    description: "List all conversations this person has had with your team.",
    inputSchema: {
      type: "object",
      properties: {
        people_id: { type: "string" },
        page: { type: "number", description: "Default: 1" },
      },
      required: ["people_id"],
    },
  },
  {
    name: "get_person_data",
    description: "Get the custom data dictionary attached to a People profile (plan, subscription status, whatever your website has pushed in).",
    inputSchema: {
      type: "object",
      properties: { people_id: { type: "string" } },
      required: ["people_id"],
    },
  },

  // ── Team & Visitors ─────────────────────────
  {
    name: "get_operators",
    description: "Get typed list of operators (team members) with user_id, email, role, availability.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "find_operator_by_email",
    description: "Resolve an operator's user_id from their email. Useful as a pre-step to `assign_conversation`.",
    inputSchema: {
      type: "object",
      properties: { email: { type: "string" } },
      required: ["email"],
    },
  },
  {
    name: "get_visitors",
    description: "Get currently-active website visitors (typed, with geolocation + page info).",
    inputSchema: {
      type: "object",
      properties: { page: { type: "number", description: "Default: 1" } },
    },
  },
];

// ============================================
// Formatting helpers
// ============================================

/**
 * Compact conversation summary optimised for listings. Hides device/IP
 * noise that blows up token counts when you're just scanning tickets.
 */
function formatConversationSummary(conv: Conversation): Record<string, unknown> {
  return {
    session_id: conv.session_id,
    state: conv.state,
    customer: {
      nickname: conv.meta?.nickname || "Unknown",
      email: conv.meta?.email || null,
    },
    subject: conv.meta?.subject || null,
    last_message: conv.last_message,
    segments: conv.meta?.segments || [],
    assigned_to: conv.assigned?.user_id || null,
    unread_operator: conv.unread?.operator || 0,
    unread_visitor: conv.unread?.visitor || 0,
    is_awaiting_operator_reply:
      conv.state !== "resolved" && (conv.unread?.operator ?? 0) > 0,
    created_at: new Date(conv.created_at).toISOString(),
    updated_at: new Date(conv.updated_at).toISOString(),
  };
}

/**
 * Per-message summary that surfaces file URLs instead of dumping the raw
 * content object. Keep fields small — this gets repeated many times.
 */
function formatMessageSummary(msg: Message): Record<string, unknown> {
  return {
    type: msg.type,
    from: msg.from,
    timestamp: new Date(msg.timestamp).toISOString(),
    author: msg.user?.nickname || (msg.from === "user" ? "Customer" : "Operator"),
    content: crispClient.renderMessageContent(msg),
    fingerprint: msg.fingerprint,
  };
}

function formatPerson(p: PeopleProfile): Record<string, unknown> {
  return {
    people_id: p.people_id,
    email: p.email || null,
    nickname: p.person?.nickname || null,
    company: p.company?.name || null,
    segments: p.segments || [],
    notepad: p.notepad || null,
    score: p.score ?? null,
    active: p.active ?? null,
    geolocation: p.person?.geolocation || null,
    created_at: p.created_at ? new Date(p.created_at).toISOString() : null,
    updated_at: p.updated_at ? new Date(p.updated_at).toISOString() : null,
  };
}

function formatOperator(op: { type?: string; details?: OperatorDetails }): Record<string, unknown> {
  const d = op.details || {};
  return {
    user_id: d.user_id || null,
    email: d.email || null,
    name: [d.first_name, d.last_name].filter(Boolean).join(" ") || null,
    role: d.role || null,
    title: d.title || null,
    availability: d.availability || null,
  };
}

/** Tight JSON text response, reusing the existing content-block shape. */
function jsonResult(data: unknown): { content: [{ type: "text"; text: string }] } {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

// ============================================
// Server wiring
// ============================================

const server = new Server(
  {
    name: "crisp-mcp",
    version: "1.1.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;

  try {
    switch (name) {
      // ── Conversation discovery ───────────────
      case "list_conversations": {
        const res = await crispClient.listConversations({
          pageNumber: (a.page as number) || 1,
          perPage: (a.per_page as number) || 20,
          searchText: a.search as string | undefined,
          searchSegment: a.segment as string | undefined,
          filterNotResolved: Boolean(a.unresolved_only),
          filterUnread: Boolean(a.unread_only),
          filterAssigned: a.assigned_to as string | undefined,
          filterUnassigned: Boolean(a.unassigned_only),
          filterMention: Boolean(a.mention_only),
          orderDateWaiting: Boolean(a.order_by_waiting),
        });
        return jsonResult({
          conversations: res.data.map(formatConversationSummary),
          page_number: res.pageNumber,
          has_more: res.hasMore,
          next_page: res.nextPage,
        });
      }

      case "get_unresolved_conversations": {
        const maxPages = (a.max_pages as number) || 5;
        const all = await crispClient.listConversationsAllPages(
          { filterNotResolved: true, orderDateWaiting: true },
          maxPages,
        );
        return jsonResult(all.map(formatConversationSummary));
      }

      case "conversations_awaiting_reply": {
        // "Awaiting reply" = unresolved + operator has unread messages on
        // their side. Using filter_unread narrows this server-side so we
        // don't over-fetch.
        const maxPages = (a.max_pages as number) || 3;
        const all = await crispClient.listConversationsAllPages(
          {
            filterNotResolved: true,
            filterUnread: true,
            orderDateWaiting: true,
          },
          maxPages,
        );
        return jsonResult(all.map(formatConversationSummary));
      }

      case "conversations_assigned_to_me": {
        const userId = a.user_id as string;
        if (!userId) throw new Error("user_id is required");
        const maxPages = (a.max_pages as number) || 3;
        const all = await crispClient.listConversationsAllPages(
          {
            filterAssigned: userId,
            filterNotResolved: a.unresolved_only !== false,
            orderDateWaiting: true,
          },
          maxPages,
        );
        return jsonResult(all.map(formatConversationSummary));
      }

      case "conversations_by_segment": {
        const segment = a.segment as string;
        if (!segment) throw new Error("segment is required");
        const maxPages = (a.max_pages as number) || 3;
        const all = await crispClient.listConversationsAllPages(
          {
            searchSegment: segment,
            filterNotResolved: Boolean(a.unresolved_only),
            orderDateWaiting: true,
          },
          maxPages,
        );
        return jsonResult(all.map(formatConversationSummary));
      }

      case "search_conversations": {
        const query = a.query as string;
        if (!query) throw new Error("query is required");
        const res = await crispClient.listConversations({ searchText: query });
        return jsonResult(res.data.map(formatConversationSummary));
      }

      // ── Conversation detail ──────────────────
      case "get_conversation": {
        const sessionId = a.session_id as string;
        if (!sessionId) throw new Error("session_id is required");
        return jsonResult(await crispClient.getConversation(sessionId));
      }

      case "get_messages": {
        const sessionId = a.session_id as string;
        if (!sessionId) throw new Error("session_id is required");
        const messages = await crispClient.getAllMessages(
          sessionId,
          10,
          a.max_age_hours as number | undefined,
        );
        return jsonResult(messages.map(formatMessageSummary));
      }

      case "get_conversation_with_messages": {
        const sessionId = a.session_id as string;
        if (!sessionId) throw new Error("session_id is required");
        const maxAgeHours = (a.max_age_hours as number) || 48;
        const conversation = await crispClient.getConversation(sessionId);
        const messages = await crispClient.getAllMessages(sessionId, 10, maxAgeHours);
        const formatted = crispClient.formatConversationForAnalysis(conversation, messages);
        return {
          content: [{ type: "text", text: formatted }],
        };
      }

      case "get_rich_context": {
        const sessionId = a.session_id as string;
        if (!sessionId) throw new Error("session_id is required");
        const ctx = await crispClient.getRichContext(sessionId, {
          maxAgeHours: (a.max_age_hours as number) || 72,
          maxOtherConversations: (a.max_other_conversations as number) || 10,
        });
        return jsonResult({
          conversation: formatConversationSummary(ctx.conversation),
          messages: ctx.messages.map(formatMessageSummary),
          person: ctx.person ? formatPerson(ctx.person) : null,
          person_custom_data: ctx.personData,
          past_conversations: ctx.otherConversations.map(formatConversationSummary),
        });
      }

      // ── Messaging ────────────────────────────
      case "send_message": {
        const sessionId = a.session_id as string;
        const content = a.content as string;
        if (!sessionId || !content) {
          throw new Error("session_id and content are required");
        }
        const messageType = (a.type as "text" | "note") || "text";
        const nickname = (a.nickname as string) || "Support";
        const mentions = a.mentions as string[] | undefined;
        const result = await crispClient.sendMessage(sessionId, content, {
          type: messageType,
          user: { nickname },
          mentions,
        });
        return jsonResult({ success: true, fingerprint: result.fingerprint });
      }

      case "send_file_message": {
        const sessionId = a.session_id as string;
        const url = a.url as string;
        if (!sessionId || !url) {
          throw new Error("session_id and url are required");
        }
        const nickname = (a.nickname as string) || "Support";
        const result = await crispClient.sendFileMessage(
          sessionId,
          {
            url,
            name: a.name as string | undefined,
            mimeType: a.mime_type as string | undefined,
          },
          { user: { nickname } },
        );
        return jsonResult({ success: true, fingerprint: result.fingerprint });
      }

      // ── Conversation state ───────────────────
      case "set_conversation_state": {
        const sessionId = a.session_id as string;
        const state = a.state as "pending" | "unresolved" | "resolved";
        if (!sessionId || !state) {
          throw new Error("session_id and state are required");
        }
        await crispClient.setConversationState(sessionId, state);
        return jsonResult({ success: true, state });
      }

      case "update_conversation_meta": {
        const sessionId = a.session_id as string;
        if (!sessionId) throw new Error("session_id is required");
        const meta: Record<string, unknown> = {};
        if (a.email) meta.email = a.email;
        if (a.nickname) meta.nickname = a.nickname;
        if (a.subject) meta.subject = a.subject;
        if (a.segments) meta.segments = a.segments;
        await crispClient.updateConversationMeta(sessionId, meta);
        return jsonResult({ success: true, updated: meta });
      }

      case "add_segments": {
        const sessionId = a.session_id as string;
        const segments = a.segments as string[];
        if (!sessionId || !segments) {
          throw new Error("session_id and segments are required");
        }
        await crispClient.addSegments(sessionId, segments);
        return jsonResult({ success: true, added: segments });
      }

      case "remove_segments": {
        const sessionId = a.session_id as string;
        const segments = a.segments as string[];
        if (!sessionId || !segments) {
          throw new Error("session_id and segments are required");
        }
        await crispClient.removeSegments(sessionId, segments);
        return jsonResult({ success: true, removed: segments });
      }

      // ── Conversation actions ─────────────────
      case "assign_conversation": {
        const sessionId = a.session_id as string;
        const userId = a.user_id as string;
        if (!sessionId || !userId) {
          throw new Error("session_id and user_id are required");
        }
        await crispClient.assignConversation(sessionId, userId);
        return jsonResult({ success: true, assigned_to: userId });
      }

      case "block_conversation": {
        const sessionId = a.session_id as string;
        if (!sessionId) throw new Error("session_id is required");
        await crispClient.blockConversation(sessionId);
        return jsonResult({ success: true, blocked: true });
      }

      case "unblock_conversation": {
        const sessionId = a.session_id as string;
        if (!sessionId) throw new Error("session_id is required");
        await crispClient.unblockConversation(sessionId);
        return jsonResult({ success: true, blocked: false });
      }

      case "delete_conversation": {
        const sessionId = a.session_id as string;
        if (!sessionId) throw new Error("session_id is required");
        await crispClient.deleteConversation(sessionId);
        return jsonResult({ success: true, deleted: true });
      }

      // ── People (Contacts) ────────────────────
      case "find_person_by_email": {
        const email = a.email as string;
        if (!email) throw new Error("email is required");
        const person = await crispClient.findPersonByEmail(email);
        return jsonResult(person ? formatPerson(person) : null);
      }

      case "get_person": {
        const peopleId = a.people_id as string;
        if (!peopleId) throw new Error("people_id is required");
        const person = await crispClient.getPerson(peopleId);
        return jsonResult(formatPerson(person));
      }

      case "get_person_conversations": {
        const peopleId = a.people_id as string;
        if (!peopleId) throw new Error("people_id is required");
        const page = (a.page as number) || 1;
        const res = await crispClient.getPersonConversations(peopleId, page);
        return jsonResult({
          conversations: res.data.map(formatConversationSummary),
          page_number: res.pageNumber,
          has_more: res.hasMore,
          next_page: res.nextPage,
        });
      }

      case "get_person_data": {
        const peopleId = a.people_id as string;
        if (!peopleId) throw new Error("people_id is required");
        return jsonResult(await crispClient.getPersonData(peopleId));
      }

      // ── Team & Visitors ──────────────────────
      case "get_operators": {
        const operators = await crispClient.getOperators();
        return jsonResult(operators.map(formatOperator));
      }

      case "find_operator_by_email": {
        const email = a.email as string;
        if (!email) throw new Error("email is required");
        const op = await crispClient.findOperatorByEmail(email);
        return jsonResult(op ? formatOperator({ details: op }) : null);
      }

      case "get_visitors": {
        const page = (a.page as number) || 1;
        return jsonResult(await crispClient.getVisitors(page));
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error occurred";
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: errorMessage }, null, 2),
        },
      ],
      isError: true,
    };
  }
});

// Resource: expose "conversations awaiting reply" since that's the highest-
// value snapshot for an autonomous agent polling the server.
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: "crisp://conversations/awaiting-reply",
      name: "Conversations awaiting operator reply",
      description:
        "Unresolved conversations where a customer is currently waiting on an operator, ordered longest-wait first.",
      mimeType: "application/json",
    },
    {
      uri: "crisp://conversations/unresolved",
      name: "Unresolved Conversations",
      description: "All unresolved support conversations.",
      mimeType: "application/json",
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  if (uri === "crisp://conversations/awaiting-reply") {
    const all = await crispClient.listConversationsAllPages(
      { filterNotResolved: true, filterUnread: true, orderDateWaiting: true },
      3,
    );
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(all.map(formatConversationSummary), null, 2),
        },
      ],
    };
  }

  if (uri === "crisp://conversations/unresolved") {
    const all = await crispClient.listConversationsAllPages(
      { filterNotResolved: true, orderDateWaiting: true },
      5,
    );
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(all.map(formatConversationSummary), null, 2),
        },
      ],
    };
  }

  throw new Error(`Unknown resource: ${uri}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Crisp MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
