import { AI_MODEL, getAIClient } from "@/lib/ai/client";
import { buildStrategyPrompt } from "@/lib/ai/prompts/algorithm";
import { createClient } from "@/lib/supabase/server";
import { algorithmFormSchema } from "@/lib/validators/algorithm";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = await request.json();
  const parsed = algorithmFormSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(parsed.error.issues[0].message, { status: 400 });
  }

  const { count } = await supabase
    .from("trades")
    .select("*", { count: "exact", head: true });

  try {
    const client = getAIClient();
    const { system, userMessage } = buildStrategyPrompt(parsed.data, count ?? 0);

    const stream = await client.chat.completions.create({
      model: AI_MODEL,
      max_tokens: 1024,
      stream: true,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userMessage },
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
