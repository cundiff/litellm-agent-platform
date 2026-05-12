import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// Content block shapes that foldSdkMessages accumulates from stream_event frames.
interface TextBlock {
  type: "text";
  text: string;
}

interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input?: unknown;
  input_partial_json?: string;
}

type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | { type: string; [key: string]: unknown };

// FoldedMessage mirrors the SDKMessage shapes the UI cares about.
// system/user/result pass through unchanged; assistant is either a
// complete SDKAssistantMessage or a rolling view assembled from
// stream_event frames.
export type FoldedMessage =
  | { type: "system"; [key: string]: unknown }
  | { type: "user"; message?: { content?: unknown }; [key: string]: unknown }
  | { type: "assistant"; message?: { content?: ContentBlock[] }; [key: string]: unknown }
  | { type: "result"; total_cost_usd?: number; duration_ms?: number; num_turns?: number; is_error?: boolean; subtype?: string; [key: string]: unknown };

/**
 * Collapse a raw SDKMessage stream into FoldedMessages suitable for rendering.
 *
 * Complete assistant/user/system/result messages pass through directly.
 * stream_event (SDKPartialAssistantMessage) frames are accumulated into a
 * rolling assistant message using the Anthropic streaming protocol:
 *   message_start → content_block_start → content_block_delta* → content_block_stop → message_stop
 * The rolling message is flushed into the output whenever a non-streaming
 * message arrives or the stream ends.
 */
export function foldSdkMessages(messages: SDKMessage[]): FoldedMessage[] {
  const result: FoldedMessage[] = [];
  let rollingBlocks: ContentBlock[] | null = null;
  let rollingMeta: Record<string, unknown> = {};

  function flushRolling() {
    if (rollingBlocks !== null) {
      result.push({
        type: "assistant",
        message: { content: rollingBlocks },
        ...rollingMeta,
      });
      rollingBlocks = null;
      rollingMeta = {};
    }
  }

  for (const m of messages) {
    if (m.type === "assistant" || m.type === "user" || m.type === "result") {
      flushRolling();
      result.push(m as unknown as FoldedMessage);
    } else if (m.type === "system") {
      flushRolling();
      result.push(m as unknown as FoldedMessage);
    } else if (m.type === "stream_event") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const event = (m as unknown as { event: { type: string; [k: string]: unknown } }).event;
      if (!event) continue;

      switch (event.type) {
        case "message_start":
          if (rollingBlocks !== null) flushRolling();
          rollingBlocks = [];
          break;

        case "content_block_start": {
          if (rollingBlocks === null) rollingBlocks = [];
          const idx = event.index as number;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const cb = (event as any).content_block as ContentBlock | undefined;
          if (cb) {
            const block: ContentBlock = { ...cb };
            if (block.type === "text") (block as TextBlock).text = "";
            if (block.type === "thinking") (block as ThinkingBlock).thinking = "";
            rollingBlocks[idx] = block;
          }
          break;
        }

        case "content_block_delta": {
          if (rollingBlocks === null) break;
          const idx = event.index as number;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const delta = (event as any).delta as { type: string; [k: string]: unknown } | undefined;
          if (!delta) break;
          let block = rollingBlocks[idx];
          if (!block) {
            block = { type: "text", text: "" } as TextBlock;
            rollingBlocks[idx] = block;
          }
          if (delta.type === "text_delta" && block.type === "text") {
            (block as TextBlock).text += (delta.text as string) ?? "";
          } else if (delta.type === "input_json_delta" && block.type === "tool_use") {
            (block as ToolUseBlock).input_partial_json =
              ((block as ToolUseBlock).input_partial_json ?? "") + ((delta.partial_json as string) ?? "");
          } else if (delta.type === "thinking_delta" && block.type === "thinking") {
            (block as ThinkingBlock).thinking += (delta.thinking as string) ?? "";
          }
          break;
        }

        case "content_block_stop": {
          if (rollingBlocks === null) break;
          const idx = event.index as number;
          const block = rollingBlocks[idx] as ToolUseBlock | undefined;
          if (block?.type === "tool_use" && block.input_partial_json && !block.input) {
            try {
              block.input = JSON.parse(block.input_partial_json);
            } catch {
              // leave as partial JSON — still renderable
            }
          }
          break;
        }

        case "message_stop":
          flushRolling();
          break;

        default:
          // message_delta and any future events are ignored
          break;
      }
    }
    // All other SDKMessage types (status, retry, hook events, etc.) are ignored.
  }

  flushRolling();
  return result;
}
