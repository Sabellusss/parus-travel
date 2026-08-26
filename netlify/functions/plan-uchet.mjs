import { GoogleGenAI } from "@google/genai";

const MODEL = "gemini-flash-latest";

const TOURS = ["dalat", "islands_north", "islands_south", "yangbay", "baho", "zoklet", "unknown"];
const MARKS = ["full", "alpin", "most", "kanat", "train"];

const PROMPT = [
  "Ниже — распознанная таблица туристов турагентства (столбцы и строки).",
  "Разнеси строки по турам и семьям.",
  "Одна семья — одна строка ведомости: имя (или фамилия) семьи, телефон, число взрослых (ad) и детей (chd).",
  "Если в таблице есть отель и номер комнаты семьи — передавай их в полях hotel и room, гиду они нужны.",
  "Ребёнком считается турист с детской ценой или пометкой CHD/ребёнок; остальные — взрослые (ad).",
  "Возможные туры: dalat (Далат), islands_north (Северные острова), islands_south (Южные острова),",
  "yangbay (Янгбей, парк с водопадами), baho (Бахо, водопады), zoklet (Зоклет).",
  "Если тур строки определить нельзя — ставь tour: \"unknown\", не выдумывай.",
  "Для Далата отметь дополнительные опции, если они есть в таблице:",
  "full (полный пакет), alpin (сани/альпийские горки), most (мост), kanat (канатная дорога), train (поезд).",
  "Служебные строки (заголовки, итоги, пустые) пропускай.",
  "Если в таблице написано имя гида (guide, HDV, гид) — верни его в поле guide, латиницей, как в таблице.",
  "Если в таблице есть дата тура — верни её в поле date в формате ГГГГ-ММ-ДД. Даты нет — поле не заполняй.",
  "Верни строго JSON, без пояснений вне JSON.",
].join(" ");

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          tour: { type: "string", enum: TOURS },
          families: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                phone: { type: "string" },
                hotel: { type: "string" },
                room: { type: "string" },
                ad: { type: "integer" },
                chd: { type: "integer" },
                full: { type: "boolean" },
                alpin: { type: "boolean" },
                most: { type: "boolean" },
                kanat: { type: "boolean" },
                train: { type: "boolean" },
              },
              required: ["name", "ad", "chd"],
            },
          },
        },
        required: ["tour", "families"],
      },
    },
    notes: { type: "string" },
    guide: { type: "string" },
    date: { type: "string" },
  },
  required: ["groups"],
};

// Шлюз Netlify AI всегда доступен в рантайме. Собственный GEMINI_API_KEY сайта
// отключает автоподстановку GOOGLE_GEMINI_BASE_URL, поэтому адрес шлюза задаём явно —
// иначе SDK уходит напрямую в Google и получает 401.
function createClient() {
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

function num(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 99);
}

/* Приводим ответ модели к тому, что ждёт страница: один блок на тур,
   суммы взрослых и детей считаем сами, а не доверяем модели. */
function normalize(parsed) {
  const byTour = new Map();
  for (const g of parsed?.groups || []) {
    const tour = TOURS.includes(g?.tour) ? g.tour : "unknown";
    const families = (Array.isArray(g?.families) ? g.families : [])
      .map((f) => {
        const fam = {
          name: String(f?.name || "").trim(),
          phone: String(f?.phone || "").trim(),
          hotel: String(f?.hotel || "").trim(),
          room: String(f?.room || "").trim(),
          ad: num(f?.ad),
          chd: num(f?.chd),
        };
        if (tour === "dalat" || tour === "unknown") {
          for (const m of MARKS) fam[m] = !!f?.[m];
          if (fam.full) for (const m of MARKS) fam[m] = true;
        }
        return fam;
      })
      .filter((f) => f.name || f.phone || f.ad || f.chd);
    if (!families.length) continue;
    if (!byTour.has(tour)) byTour.set(tour, { tour, families: [], ad: 0, chd: 0 });
    byTour.get(tour).families.push(...families);
  }

  const groups = [...byTour.values()];
  for (const g of groups) {
    g.ad = g.families.reduce((n, f) => n + f.ad, 0);
    g.chd = g.families.reduce((n, f) => n + f.chd, 0);
  }
  const out = { groups };
  if (parsed?.notes) out.notes = String(parsed.notes);
  // имя гида и дата нужны сообщениям партнёрам — там они стоят в первой строке текста
  const guide = String(parsed?.guide || "").trim();
  if (guide) out.guide = guide.slice(0, 60);
  const date = String(parsed?.date || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) out.date = date;
  return out;
}

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let columns, rows, tour;
  try {
    ({ columns, rows, tour } = await req.json());
  } catch {
    return new Response(JSON.stringify({ error: "Некорректный запрос." }), { status: 400 });
  }
  if (!Array.isArray(rows) || !rows.length) {
    return new Response(JSON.stringify({ error: "Таблица не передана." }), { status: 400 });
  }

  const hint = TOURS.includes(tour) && tour !== "unknown"
    ? ' Все строки этой таблицы относятся к туру "' + tour + '" — ставь его всем группам.'
    : "";

  const table = JSON.stringify({ columns: Array.isArray(columns) ? columns : [], rows });

  try {
    const response = await createClient().models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: PROMPT + hint + "\n\nТаблица:\n" + table }] }],
      config: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    });

    const text = response.text;
    if (!text) {
      return new Response(JSON.stringify({ error: "ИИ не смог разобрать таблицу." }), { status: 502 });
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return new Response(JSON.stringify({ error: "Не удалось разобрать ответ ИИ." }), { status: 502 });
    }

    const result = normalize(parsed);
    if (!result.groups.length) {
      return new Response(JSON.stringify({ error: "ИИ не нашёл в таблице туристов." }), { status: 502 });
    }

    return Response.json(result);
  } catch (e) {
    console.error("plan-uchet failed:", e);
    return new Response(JSON.stringify({ error: "Сервис разнесения временно недоступен." }), { status: 502 });
  }
};

export const config = {
  path: "/api/plan-uchet",
};
