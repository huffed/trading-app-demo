import { getAnthropicClient } from "@/lib/ai/client";
import { buildAlgorithmPrompt } from "@/lib/ai/prompts/algorithm";
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

  const client = getAnthropicClient();
  const { system, userMessage } = buildAlgorithmPrompt(parsed.data, count ?? 0);

  const stream = await client.messages.stream({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2048,
    system,
    messages: [{ role: "user", content: userMessage }],
  });

  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
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
