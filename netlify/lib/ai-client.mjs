import { GoogleGenAI } from "@google/genai";

// Шлюз Netlify AI всегда доступен в рантайме. Собственный GEMINI_API_KEY сайта
// отключает автоподстановку GOOGLE_GEMINI_BASE_URL, поэтому адрес шлюза задаём явно —
// иначе SDK уходит напрямую в Google и получает 401.
export function createClient() {
  const key = process.env.NETLIFY_AI_GATEWAY_KEY;
  const baseUrl = process.env.NETLIFY_AI_GATEWAY_BASE_URL;
  if (key && baseUrl) {
    return new GoogleGenAI({
      apiKey: key,
      httpOptions: { baseUrl: baseUrl.replace(/\/+$/, "") },
    });
  }
  return new GoogleGenAI({});
}
