import { GoogleGenAI } from "@google/genai";

let client: GoogleGenAI | null = null;

export function getAIClient(): GoogleGenAI {
  if (!client) {
    const apiKey = process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) {
      throw new Error("GOOGLE_AI_API_KEY environment variable is not set");
    }
    client = new GoogleGenAI({ apiKey });
  }
  return client;
}

export const AI_MODEL = "gemini-2.5-flash";
