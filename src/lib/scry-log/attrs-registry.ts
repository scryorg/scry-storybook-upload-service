// scry-log attribute registry: the ONLY place a log attribute is declared. Zero dependencies.
// Source of truth: scry-management/lib/scry-log/. Vendored into services by sync.sh; do not edit copies.
//
// A line may carry `attrs`, an object of registered, typed values (schema v1, additive). Anything not declared here is
// dropped and counted (`attrs_drop`). To add an attribute: one entry below + one test in test/attrs.test.ts; see README
// "How to add a log attribute". Never register free text from a user or an agent (prompts, intents, argument values, bodies).
import type { Service } from './schema';

export type AttrType = 'id' | 'token' | 'string' | 'int' | 'bool' | 'token_list';

export interface AttrDef {
  type: AttrType;
  /**
   * id: max length (default and ceiling 128). token: max length (default 64, ceiling 128). string: max length (default and
   * ceiling 256). int: largest allowed value (default Number.MAX_SAFE_INTEGER). token_list: max length of each item
   * (default 64, ceiling 128). bool: unused.
   */
  max?: number;
  /** Extra shape the value (or each token_list item) must match, on top of the type's own rule. */
  pattern?: RegExp;
  /** Services allowed to send it. Omitted: any service. */
  services?: ReadonlyArray<Service>;
  description: string;
}

/** `ns.name`: lowercase namespace, a dot, a lowercase name of at most 40 chars. */
export const ATTR_NAME = /^[a-z][a-z0-9]*\.[a-z][a-z0-9_]{0,39}$/;

/** Limits per line. Beyond them an attribute is dropped and counted, never truncated. */
export const MAX_ATTRS = 24;
export const MAX_ATTRS_BYTES = 2048;
export const MAX_LIST_ITEMS = 32;

const MCP: ReadonlyArray<Service> = ['mcp'];
const SEARCH: ReadonlyArray<Service> = ['search'];
const BUILD: ReadonlyArray<Service> = ['build'];
const LOGS: ReadonlyArray<Service> = ['logs'];

export const ATTRS: Readonly<Record<string, AttrDef>> = {
  // --- mcp (feature mcp-analytics): one mcp_tool_call line per tool call; see scry-mcp src/analytics/event.ts ---
  'mcp.session_id': { type: 'id', services: MCP, description: 'MCP session (Durable Object) id, e.g. do_<16 hex>' },
  'mcp.conversation_id': { type: 'id', services: MCP, description: 'Conversation id the agent passed in the conversation_id argument' },
  'mcp.client_name': { type: 'token', max: 64, services: MCP, description: 'MCP client name from the initialize handshake' },
  'mcp.client_version': { type: 'token', max: 32, services: MCP, description: 'MCP client version from the initialize handshake' },
  'mcp.protocol_version': { type: 'token', max: 16, services: MCP, description: 'MCP protocol version negotiated at initialize' },
  'mcp.llm_model': { type: 'token', max: 64, services: MCP, description: 'Model the client stated in request metadata; never inferred' },
  'mcp.llm_model_source': { type: 'token', max: 32, services: MCP, description: 'Where llm_model came from (client_metadata)' },
  'mcp.input_keys': { type: 'token_list', max: 64, services: MCP, description: 'Names of the declared arguments that were present; never values' },
  'mcp.response_bytes': { type: 'int', services: MCP, description: 'Size of the tool result in bytes; never the body' },
  'mcp.has_intent': { type: 'bool', services: MCP, description: 'The call carried a context (intent) argument; the text is never logged' },
  'mcp.intent_source': { type: 'token', max: 32, services: MCP, description: 'Where the intent came from (context_parameter)' },
  'mcp.missing_capability': { type: 'bool', services: MCP, description: 'The agent called get_more_tools: it wanted a capability Scry lacks' },
  'mcp.server_build': { type: 'token', max: 64, services: MCP, description: 'Deployed server build (commit sha or version)' },
  'mcp.tool_count': { type: 'int', max: 10000, services: MCP, description: 'Number of tools returned by tools/list' },
  // --- search (feature search-speedup F22 + phase 2 hedge): the `search embed` line; enums, flags and counts only ---
  'search.embed_mode': { type: 'token', max: 8, pattern: /^(?:text|image|both|none)$/, services: SEARCH, description: 'Which embeddings the search used: text, image, both or none (keyword only)' },
  'search.hedged': { type: 'bool', services: SEARCH, description: 'A second identical text-embed request was sent because the first was slow (hedge)' },
  'search.warm_steps': { type: 'token_list', max: 40, services: SEARCH, description: 'Warm-up run steps as step:outcome tokens (firestore:ok, embed:ok, zilliz:ok, caches:skipped_needs_user)' },
  'search.hedge_winner': { type: 'int', max: 2, services: SEARCH, description: 'Which hedged text-embed request answered first: 1 = the original, 2 = the hedge' },
  // --- search (feature search-speedup preheat Step 0): the `search session` line; milliseconds and an opaque instance id only ---
  'search.auth_ms': { type: 'int', max: 600000, services: SEARCH, description: 'Milliseconds spent verifying the Firebase ID token' },
  'search.limit_ms': { type: 'int', max: 600000, services: SEARCH, description: 'Milliseconds spent in the rate limiter' },
  'search.access_ms': { type: 'int', max: 600000, services: SEARCH, description: 'Milliseconds spent on the fresh project access read' },
  'search.gate_ms': { type: 'int', max: 600000, services: SEARCH, description: 'Milliseconds spent on the wallet and balance gate (its own duration, also when it ran beside the access read)' },
  'search.inst': { type: 'token', max: 8, pattern: /^[0-9a-f]{8}$/, services: SEARCH, description: 'Opaque random id of the function instance that answered (8 hex, new per instance start); never a host, user or request value' },
  'search.inst_age_ms': { type: 'int', max: 604800000, services: SEARCH, description: 'Milliseconds since that instance loaded the route (small = a fresh instance)' },
  // --- build (feature search-speedup P2-3): search thumbnails (`<key>.thumb.webp`), from the BPS writer and the backfill job ---
  'thumb.outcome': { type: 'token', max: 8, pattern: /^(?:written|skipped|failed)$/, services: BUILD, description: 'Result of one thumbnail: written, skipped (already there / unsupported) or failed' },
  'thumb.source': { type: 'token', max: 8, pattern: /^(?:worker|backfill)$/, services: BUILD, description: 'Who made the thumbnail: the BPS Worker at index time, or the backfill job' },
  'thumb.mode': { type: 'token', max: 8, pattern: /^(?:dry-run|apply)$/, services: BUILD, description: 'Backfill run mode' },
  // --- logs (feature log-core-hardening S1): the store's own /query request line; enums and a count only, never an id or a filter ---
  'logs.mode': { type: 'token', max: 8, pattern: /^(?:index|scan)$/, services: LOGS, description: 'How a /query was answered: from the request-id index, or by listing and reading R2 (scan)' },
  'logs.stopped': { type: 'token', max: 8, pattern: /^(?:page|objects|bytes|time|listing)$/, services: LOGS, description: 'Why a /query stopped before the whole window: page (limit reached), objects, bytes, time or listing budget; absent when the scan was complete' },
  'logs.scanned': { type: 'int', max: 100000, services: LOGS, description: 'R2 objects a /query opened' },
  'thumb.bytes_in': { type: 'int', services: BUILD, description: 'Original image size in bytes (sum for a batch or run)' },
  'thumb.bytes_out': { type: 'int', services: BUILD, description: 'Thumbnail size in bytes (sum for a batch or run)' },
  'thumb.planned': { type: 'int', services: BUILD, description: 'Backfill: screenshots still missing a thumbnail when the run started' },
  'thumb.written': { type: 'int', services: BUILD, description: 'Backfill: thumbnails written (batch or run total)' },
  'thumb.skipped': { type: 'int', services: BUILD, description: 'Backfill: screenshots skipped (already had a thumbnail, or over the pixel cap)' },
  'thumb.failed': { type: 'int', services: BUILD, description: 'Backfill: thumbnails that failed (batch or run total)' },
  'thumb.p50_kb_in': { type: 'int', services: BUILD, description: 'Backfill: median original size in KB for the batch or run' },
  'thumb.p50_kb_out': { type: 'int', services: BUILD, description: 'Backfill: median thumbnail size in KB for the batch or run' },
  'thumb.log_post_fail': { type: 'int', services: BUILD, description: 'Backfill: log requests that failed so far (the run continues)' },
};
