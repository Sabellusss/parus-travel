import { createClient } from "../lib/ai-client.mjs";

/* Самая дешёвая модель шлюза Netlify AI: Gemini Flash Lite.
   Шаг чисто текстовый (фото уже распознано в /api/scan-table), поэтому и токенов,
   и денег он стоит в разы меньше самого распознавания. */
const MODEL = "gemini-flash-lite-latest";

const TOURS = ["dalat", "islands_north", "islands_south", "baho", "zoklet", "unknown"];

const PROMPT = [
  "Ты — помощник туроператора в Нячанге. На вход — таблица, распознанная с фото (списки туристов, брони, ведомости).",
  "Задача: разнести строки по турам и посчитать, сколько где взрослых (AD) и детей (CHD).",
  "",
  "Коды туров:",
  "· dalat — Далат, Da Lat, Dalat, Далат парк, Crazy House, Кукушка/поезд, канатка, сани, стеклянный мост;",
  "· islands_north — Северные острова, Сев. острова, North islands, остров орхидей, остров обезьян;",
  "· islands_south — Южные острова, South islands, снорклинг, кано, маски;",
  "· baho — Бахо, Ba Ho, водопады Бахо;",
  "· zoklet — Зоклет, Doc Let, Док Лет, белый пляж;",
  "· unknown — тур не назван или это другой тур (Янгбей, Дананг, Хойан, Фанранг и прочее).",
  "",
  "Правила:",
  "1. Название тура ищи в любой ячейке строки. Если тур указан заголовком/подзаголовком над блоком строк — он относится ко всем строкам блока до следующего заголовка.",
  "2. Одна строка — одна семья/бронь. Строки-заголовки, итоги и пустые строки пропускай.",
  "3. Взрослые и дети: ищи столбцы AD/ADL/взр/взрослые и CHD/CHILD/дет/дети/реб. Записи «2+1», «2/1», «2 взр 1 реб» означают ad=2, chd=1.",
  "4. Если указано только общее число человек без разбивки — запиши всех во взрослые и напиши об этом в notes.",
  "5. Если возраст указан числом: младше 12 лет — ребёнок, иначе взрослый. Инфанта (до 2 лет) считай ребёнком.",
  "6. Для Далата отметь развлечения, если в таблице есть такие столбцы или пометки (✓, +, x, да): full (всё включено), alpin (сани), most (стеклянный мост), kanat (канатка), train (поезд). Если пометок нет — оставь false.",
  "7. Ничего не выдумывай: если в строке нет людей, её не включай. Числа не округляй и не додумывай.",
  "8. Один тур — одна группа в ответе; все семьи этого тура клади в неё.",
  "9. В notes коротко по-русски напиши, что было неоднозначно (максимум 2 предложения). Если всё чисто — пустая строка.",
].join("\n");

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
                ad: { type: "integer" },
                chd: { type: "integer" },
                full: { type: "boolean" },
                alpin: { type: "boolean" },
                most: { type: "boolean" },
                kanat: { type: "boolean" },
                train: { type: "boolean" },
              },
              required: ["name", "ad", "chd"],
              propertyOrdering: ["name", "ad", "chd", "full", "alpin", "most", "kanat", "train"],
            },
          },
        },
        required: ["tour", "families"],
        propertyOrdering: ["tour", "families"],
      },
    },
    notes: { type: "string" },
  },
  required: ["groups"],
  propertyOrdering: ["groups", "notes"],
};

function clamp99(v) {
  const n = Math.round(Number(v));
  if (!isFinite(n) || n < 0) return 0;
  return Math.min(99, n);
}

function tableToText(columns, rows) {
  const head = columns.map((c) => String(c == null ? "" : c)).join(" | ");
  const body = rows
    .slice(0, 300)
    .map((r, i) => (i + 1) + ". " + (Array.isArray(r) ? r : [r]).map((c) => String(c == null ? "" : c)).join(" | "));
  return ["Заголовки: " + head, "Строки:", ...body].join("\n");
}

/* Модель может ошибиться в мелочах, поэтому чистим ответ на сервере:
   неизвестные туры, отрицательные и дробные числа, пустые семьи. */
function sanitize(parsed) {
  const byTour = new Map();
  const groups = Array.isArray(parsed?.groups) ? parsed.groups : [];

  for (const g of groups) {
    const tour = TOURS.includes(g?.tour) ? g.tour : "unknown";
    const families = Array.isArray(g?.families) ? g.families : [];
    for (const f of families) {
      const ad = clamp99(f?.ad);
      const chd = clamp99(f?.chd);
      if (ad + chd === 0) continue;
      const item = { name: String(f?.name || "").slice(0, 80), ad, chd };
      if (tour === "dalat") {
        const full = !!f?.full;
        item.full = full;
        item.alpin = full || !!f?.alpin;
        item.most = full || !!f?.most;
        item.kanat = full || !!f?.kanat;
        item.train = full || !!f?.train;
      }
      if (!byTour.has(tour)) byTour.set(tour, []);
      const list = byTour.get(tour);
      if (list.length < 200) list.push(item);
    }
  }

  return [...byTour.entries()].map(([tour, families]) => ({
    tour,
    families,
    ad: families.reduce((s, f) => s + f.ad, 0),
    chd: families.reduce((s, f) => s + f.chd, 0),
  }));
}

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let columns, rows;
  try {
    ({ columns, rows } = await req.json());
  } catch {
    return new Response(JSON.stringify({ error: "Некорректный запрос." }), { status: 400 });
  }
  if (!Array.isArray(columns) || !Array.isArray(rows) || !rows.length) {
    return new Response(JSON.stringify({ error: "Таблица не передана." }), { status: 400 });
  }

  try {
    const response = await createClient().models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: PROMPT + "\n\nТАБЛИЦА:\n" + tableToText(columns, rows) }] }],
      config: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
        temperature: 0,
      },
    });

    const text = response.text;
    if (!text) {
      return new Response(JSON.stringify({ error: "ИИ не смог разнести таблицу по турам." }), { status: 502 });
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return new Response(JSON.stringify({ error: "Не удалось разобрать ответ ИИ." }), { status: 502 });
    }

    const groups = sanitize(parsed);
    if (!groups.length) {
      return new Response(JSON.stringify({ error: "В таблице не нашлось строк с туристами." }), { status: 422 });
    }

    return Response.json({ groups, notes: String(parsed?.notes || "").slice(0, 400), model: MODEL });
  } catch (e) {
    console.error("plan-uchet failed:", e);
    return new Response(JSON.stringify({ error: "Сервис разнесения временно недоступен." }), { status: 502 });
  }
};

export const config = {
  path: "/api/plan-uchet",
};
