import { GoogleGenAI } from "@google/genai";

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let image, mimeType;
  try {
    ({ image, mimeType } = await req.json());
  } catch {
    return new Response(JSON.stringify({ error: "Некорректный запрос." }), { status: 400 });
  }
  if (!image) {
    return new Response(JSON.stringify({ error: "Изображение не передано." }), { status: 400 });
  }

  try {
    const ai = new GoogleGenAI({});
    const prompt = "Извлеки все данные таблицы с фото в JSON: { columns: ['...'], rows: [['...']] }";

    const response = await ai.models.generateContent({
      model: "gemini-flash-latest",
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: mimeType || "image/jpeg", data: image } },
            { text: prompt },
          ],
        },
      ],
      config: { responseMimeType: "application/json" },
    });

    const text = response.text;
    if (!text) {
      return new Response(JSON.stringify({ error: "Gemini не вернул результат (возможно, сработал фильтр безопасности)." }), { status: 502 });
    }
    return new Response(text, { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || "Ошибка при обращении к Gemini API." }), { status: 502 });
  }
};

export const config = {
  path: "/api/scan-table",
};
