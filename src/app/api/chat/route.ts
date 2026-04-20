import { getAnthropicClient } from "@/lib/ai/client";
import { buildChatSystemPrompt } from "@/lib/ai/prompts/chat";
import { createClient } from "@/lib/supabase/server";
import type { ChatMessage } from "@/types/chat";

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { messages, stats } = (await request.json()) as {
    messages: ChatMessage[];
    stats: Record<string, unknown> | null;
  };

  const client = getAnthropicClient();
  const system = buildChatSystemPrompt(stats as Parameters<typeof buildChatSystemPrompt>[0]);

  const stream = await client.messages.stream({
    model: "claude-sonnet-4-20250514",
    max_tokens: 512,
    system,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  });

  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          controller.enqueue(encoder.encode(event.delta.text));
        }
      }
      controller.close();
    },
  });

  return new Response(readable, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
