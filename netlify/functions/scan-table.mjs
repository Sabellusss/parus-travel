import { createClient } from "../lib/ai-client.mjs";

const MODEL = "gemini-flash-latest";

const PROMPT = [
  "На фото — таблица. Извлеки из неё все данные.",
  "Верни строго JSON вида { \"columns\": [\"...\"], \"rows\": [[\"...\"]] }.",
  "columns — заголовки столбцов по порядку.",
  "rows — строки таблицы; в каждой строке столько же значений, сколько заголовков.",
  "Пустую ячейку передавай пустой строкой. Не добавляй пояснений вне JSON.",
].join(" ");

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    columns: { type: "array", items: { type: "string" } },
    rows: { type: "array", items: { type: "array", items: { type: "string" } } },
  },
  required: ["columns", "rows"],
};

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
    const response = await createClient().models.generateContent({
      model: MODEL,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: mimeType || "image/jpeg", data: image } },
            { text: PROMPT },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    });

    const text = response.text;
    if (!text) {
      return new Response(JSON.stringify({ error: "Не удалось распознать таблицу на фото." }), { status: 502 });
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return new Response(JSON.stringify({ error: "Не удалось разобрать ответ распознавания." }), { status: 502 });
    }
    if (!Array.isArray(parsed?.columns) || !Array.isArray(parsed?.rows)) {
      return new Response(JSON.stringify({ error: "Таблица на фото не распознана." }), { status: 502 });
    }

    return Response.json(parsed);
  } catch (e) {
    console.error("scan-table failed:", e);
    return new Response(JSON.stringify({ error: "Сервис распознавания временно недоступен." }), { status: 502 });
  }
};

export const config = {
  path: "/api/scan-table",
};
