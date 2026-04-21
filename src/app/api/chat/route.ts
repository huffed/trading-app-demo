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

  try {
    const client = getAIClient();
    const system = buildChatSystemPrompt(stats as Parameters<typeof buildChatSystemPrompt>[0]);

    const stream = await client.chat.completions.create({
      model: AI_MODEL,
      max_tokens: 512,
      stream: true,
      messages: [
        { role: "system", content: system },
        ...messages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
      ],
    });

    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        for await (const chunk of stream) {
          const text = chunk.choices[0]?.delta?.content;
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
  } catch {
    return new Response("AI is temporarily unavailable.", { status: 503 });
  }
}
