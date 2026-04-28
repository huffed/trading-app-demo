import { NextResponse } from "next/server";
import { z } from "zod";
import { AI_MODEL, getAIClient } from "@/lib/ai/client";
import { buildChatSystemPrompt } from "@/lib/ai/prompts/chat";
import { createClient } from "@/lib/supabase/server";

const chatRequestSchema = z.object({
  messages: z
    .array(
      z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(10_000) })
    )
    .min(1)
    .max(100),
  stats: z.record(z.string(), z.unknown()).nullable().optional(),
  tradeHistory: z.string().max(50_000).nullable().optional(),
});

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message, code: "validation_error" },
      { status: 400 }
    );
  }

  const { messages, stats, tradeHistory } = parsed.data;

  // Fetch user's algorithms and trading profile for context
  const [{ data: algorithms }, { data: profile }] = await Promise.all([
    supabase
      .from("algorithms")
      .select(
        "id, name, description, rules, status, risk_level, capital, time_horizon, asset_class"
      )
      .order("created_at", { ascending: false }),
    supabase.from("profiles").select("trading_profile").eq("id", user.id).single(),
  ]);

  try {
    const client = getAIClient();
    const system = buildChatSystemPrompt(
      stats as Parameters<typeof buildChatSystemPrompt>[0],
      tradeHistory,
      algorithms ?? [],
      profile?.trading_profile as Parameters<typeof buildChatSystemPrompt>[3]
    );

    const stream = await client.chat.completions.create({
      model: AI_MODEL,
      max_tokens: tradeHistory ? 1024 : 512,
      stream: true,
      messages: [
        { role: "system", content: system },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
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
    return NextResponse.json(
      { error: "AI is temporarily unavailable.", code: "upstream_unavailable" },
      { status: 503 }
    );
  }
}
