import { z } from "zod";
import { AI_MODEL, getAIClient } from "@/lib/ai/client";
import { buildStrategyPrompt } from "@/lib/ai/prompts/algorithm";
import { createClient } from "@/lib/supabase/server";
import { algorithmFormSchema } from "@/lib/validators/algorithm";

const generateRequestSchema = z.object({
  preferences: z.record(z.string(), z.string()),
  messages: z
    .array(
      z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(10_000) })
    )
    .max(50)
    .optional(),
});

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const raw = await request.json();
  const reqParsed = generateRequestSchema.safeParse(raw);
  if (!reqParsed.success) {
    return new Response(reqParsed.error.issues[0].message, { status: 400 });
  }

  const { preferences, messages } = reqParsed.data;

  const parsed = algorithmFormSchema.safeParse(preferences);
  if (!parsed.success) {
    return new Response(parsed.error.issues[0].message, { status: 400 });
  }

  const { count } = await supabase.from("trades").select("*", { count: "exact", head: true });

  try {
    const client = getAIClient();
    const isInitial = !messages || messages.length === 0;

    const systemPrompt = isInitial
      ? buildStrategyPrompt(parsed.data, count ?? 0).system
      : buildRefineSystemPrompt();

    const chatMessages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "system", content: systemPrompt },
    ];

    if (isInitial) {
      chatMessages.push({
        role: "user",
        content: buildStrategyPrompt(parsed.data, count ?? 0).userMessage,
      });
    } else {
      // Include initial context + full conversation
      chatMessages.push({
        role: "user",
        content: buildStrategyPrompt(parsed.data, count ?? 0).userMessage,
      });
      for (const msg of messages) {
        chatMessages.push({
          role: msg.role === "assistant" ? "assistant" : "user",
          content: msg.content,
        });
      }
    }

    const stream = await client.chat.completions.create({
      model: AI_MODEL,
      max_tokens: 1024,
      stream: true,
      messages: chatMessages,
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

function buildRefineSystemPrompt(): string {
  return `You are a quantitative trading strategist helping refine a trading algorithm. The user has already generated an initial strategy and wants to adjust it.

When the user asks for changes:
- Acknowledge what they want to change
- Explain how the updated strategy works
- Be concise (100-200 words)

You can adjust entry/exit conditions, stop loss, take profit, position sizing, risk level, indicators, or any aspect of the strategy. Always explain the impact of changes.`;
}
