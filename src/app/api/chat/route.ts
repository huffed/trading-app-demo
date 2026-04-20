import { AI_MODEL, getAIClient } from "@/lib/ai/client";
import { buildChatSystemPrompt } from "@/lib/ai/prompts/chat";
import { createClient } from "@/lib/supabase/server";
import type { ChatMessage } from "@/types/chat";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { messages, stats } = (await request.json()) as {
    messages: ChatMessage[];
    stats: Record<string, unknown> | null;
  };

  const client = getAIClient();
  const system = buildChatSystemPrompt(stats as Parameters<typeof buildChatSystemPrompt>[0]);

  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? ("model" as const) : ("user" as const),
    parts: [{ text: m.content }],
  }));

  const stream = await client.models.generateContentStream({
    model: AI_MODEL,
    contents,
    config: {
      systemInstruction: system,
      maxOutputTokens: 512,
    },
  });

  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      for await (const chunk of stream) {
        const text = chunk.text;
        if (text) {
          controller.enqueue(encoder.encode(text));
        }
      }
      controller.close();
    },
  });

  return new Response(readable, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
