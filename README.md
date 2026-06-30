# Crisp MCP Server

An MCP (Model Context Protocol) server that provides tools for interacting with the [Crisp](https://crisp.chat) customer support platform. Use it with Claude Code or any MCP-compatible client to manage support conversations, send messages, and more.

## Installation

```bash
git clone https://github.com/getlate-dev/crisp-mcp.git
cd crisp-mcp
mise install
npm install
npm run build
```

## Getting Your Crisp API Credentials

This server uses a Crisp **website token**.

1. In the [Crisp app](https://app.crisp.chat/), go to **Settings → Workspace Settings → Advanced configuration** (owner-only).
2. In the **API Token** section, click **Generate Token**. This gives you a **Token identifier** (`CRISP_TOKEN_ID`) and a **Token key** (`CRISP_TOKEN_KEY`).
3. Find your **Website ID** in the dashboard URL: `app.crisp.chat/website/XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX/` (`CRISP_WEBSITE_ID`).

## Configuration

Set these environment variables:

| Variable | Description | Example |
|----------|-------------|---------|
| `CRISP_TOKEN_ID` | Token identifier from Advanced configuration | `ab1c2d3e-4f5g-6h7i-8j9k-0l1m2n3o4p5q` |
| `CRISP_TOKEN_KEY` | Token key from Advanced configuration | `a1b2c3d4e5f6...` (long string) |
| `CRISP_WEBSITE_ID` | Your website ID | `12345678-1234-1234-1234-123456789012` |

## Usage with Claude Code

Add this to your Claude Code MCP settings (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "crisp": {
      "command": "node",
      "args": ["/path/to/crisp-mcp/dist/index.js"],
      "env": {
        "CRISP_TOKEN_ID": "your-token-id",
        "CRISP_TOKEN_KEY": "your-token-key",
        "CRISP_WEBSITE_ID": "your-website-id"
      }
    }
  }
}
```

Then restart Claude Code. You can now use natural language to manage your Crisp conversations:

- "Show me unresolved support tickets"
- "What's the context of conversation session_abc123?"
- "Reply to that customer saying we're looking into it"
- "Mark that conversation as resolved"

## Available Tools

### Conversation Discovery

| Tool | Description |
|------|-------------|
| `list_conversations` | Paginated list with filters: search, segment, unresolved_only, unread_only, assigned_to, unassigned_only, mention_only, order_by_waiting. Returns `{ conversations, page_number, has_more, next_page }`. |
| `get_unresolved_conversations` | All unresolved across multiple pages (flat array). |
| `conversations_awaiting_reply` | **Best triage tool.** Unresolved AND customer is waiting on an operator reply. Sorted longest-wait first. |
| `conversations_assigned_to_me` | Conversations assigned to a specific operator (pass user_id). |
| `conversations_by_segment` | Conversations tagged with a specific segment (e.g. `refund`, `bug`). |
| `search_conversations` | Plain-text search. |

### Conversation Detail

| Tool | Description |
|------|-------------|
| `get_conversation` | Detailed info about a specific conversation. |
| `get_messages` | Message history. File/image/audio messages have their URLs surfaced cleanly. |
| `get_conversation_with_messages` | Plain-text formatted transcript for analysis (small context). |
| `get_rich_context` | **Heavy context**: conversation + messages + Crisp People profile + past conversations from same customer + custom data, all in one call. Replaces 4-5 round trips. |

### Messaging

| Tool | Description |
|------|-------------|
| `send_message` | Send text or internal note. Supports `mentions` for @-tagging operators. |
| `send_file_message` | Attach a file by URL (no upload needed — pass any publicly hosted URL). |

### Conversation State

| Tool | Description |
|------|-------------|
| `set_conversation_state` | Change state (pending, unresolved, resolved). |
| `update_conversation_meta` | Update metadata (email, nickname, subject, segments). |
| `add_segments` / `remove_segments` | Add or remove tags. |

### Conversation Actions

| Tool | Description |
|------|-------------|
| `assign_conversation` | Assign to a specific operator (by user_id). |
| `resolve_conversation` / `reopen_conversation` | One-shot aliases over `set_conversation_state`. |
| `block_conversation` / `unblock_conversation` | Block/unblock a conversation. |
| `delete_conversation` | Permanently delete. |

### Realtime & Navigation

| Tool | Description |
|------|-------------|
| `set_composing_state` | Send a "typing…" indicator to the customer (start/stop). Auto-expires after ~6s. |
| `mark_messages_read` | Mark operator-side unread counter as read so conversations stop resurfacing in triage. |
| `get_conversation_url` | Build the Crisp web app URL for a conversation — useful for Slack/Linear escalations. |

### People / Contacts

| Tool | Description |
|------|-------------|
| `find_person_by_email` | Find a Crisp People profile by email. Returns null if no match. |
| `find_conversations_for_email` | Shortcut: resolve person + list their conversations in one call. |
| `get_person` | Full profile by `people_id`. |
| `get_person_conversations` | All conversations this person has ever had. |
| `get_person_data` | Custom data dictionary (plan, subscription, etc. pushed in by your app). |

### Team & Visitors

| Tool | Description |
|------|-------------|
| `get_operators` | Typed list of operators (user_id, email, role, availability). |
| `find_operator_by_email` | Resolve an operator's user_id from their email (useful before `assign_conversation`). |
| `get_visitors` | Active website visitors with geolocation + page context. |

## Reliability

The HTTP client automatically retries with exponential backoff on `429` (rate limited) and `5xx` responses, honouring `Retry-After` headers when present. Up to 4 retries by default. Prevents silent drops of operator replies when Crisp is under load.

## Available Resources

| URI | Description |
|-----|-------------|
| `crisp://conversations/awaiting-reply` | Unresolved conversations where the customer is currently waiting on an operator reply (longest-wait first). |
| `crisp://conversations/unresolved` | List of all unresolved support conversations. |

## Examples

### List unresolved conversations

```
Use the list_conversations tool with unresolved_only: true
```

### Get a support ticket with full context

```
Use the get_conversation_with_messages tool with the session_id
```

### Reply to a customer

```
Use the send_message tool with session_id and content
```

### Add an internal note (not visible to customer)

```
Use the send_message tool with type: "note"
```

### Mark a ticket as resolved

```
Use the set_conversation_state tool with state: "resolved"
```

## Development

```bash
# Watch mode for development
npm run dev

# Build for production
npm run build

# Run the server directly
npm start
```

## Troubleshooting

### "Crisp API error: 401 Unauthorized"
- Check that your `CRISP_TOKEN_ID` and `CRISP_TOKEN_KEY` are correct
- Make sure the token belongs to the same workspace as `CRISP_WEBSITE_ID`

### "Website not found"
- Double-check your `CRISP_WEBSITE_ID`
- Make sure the plugin is installed on that specific website

## License

MIT
