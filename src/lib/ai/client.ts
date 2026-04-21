import Groq from "groq-sdk";

export function getAIClient(): Groq {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY environment variable is not set");
  }
  return new Groq({ apiKey });
}

export const AI_MODEL = "llama-3.3-70b-versatile";
