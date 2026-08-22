import type { Context, Config } from "@netlify/functions";

const PROMPT = `На изображении находится таблица (возможно, сфотографированная под углом). Извлеки ВСЕ строки данных максимально точно, не пропуская ни одной строки, включая итоговые/суммирующие строки, если они есть.

Ответь СТРОГО в виде JSON, без пояснений, без markdown-обёртки \`\`\`json, без какого-либо текста до или после JSON.

Формат ответа:
{
  "title": "заголовок таблицы, если есть, иначе пустая строка",
  "columns": ["Столбец 1", "Столбец 2"],
  "rows": [["значение1", "значение2"]]
}

Правила:
- Пустые ячейки передавай как пустую строку "".
- Сохраняй оригинальное написание текста (включая опечатки, регистр, диакритику).
- Число элементов в каждой строке rows должно совпадать с числом элементов в columns.`;

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const apiKey = Netlify.env.get("GEMINI_API_KEY");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "Ключ GEMINI_API_KEY не настроен на сервере." }), { status: 500 });
  }

  let body: { image?: string; mimeType?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Некорректный запрос." }), { status: 400 });
  }

  if (!body.image || !body.mimeType) {
    return new Response(JSON.stringify({ error: "Не передано изображение." }), { status: 400 });
  }

  try {
    const apiRes = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { inline_data: { mime_type: body.mimeType, data: body.image } },
                { text: PROMPT },
              ],
            },
          ],
        }),
      }
    );

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      return new Response(JSON.stringify({ error: `Ошибка Gemini API (${apiRes.status}): ${errText}` }), { status: 502 });
    }

    const json = await apiRes.json();
    const parts = json?.candidates?.[0]?.content?.parts || [];
    let raw = parts.map((p: any) => p.text || "").join("\n").trim();

    if (raw.startsWith("```")) {
      raw = raw.replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
    }

    const data = JSON.parse(raw);

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || "Не удалось распознать изображение." }), { status: 500 });
  }
};

export const config: Config = {
  path: "/api/scan-table",
};
