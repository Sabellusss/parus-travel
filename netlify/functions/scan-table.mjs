import { GoogleGenAI } from "@google/genai";

/* Модели закреплены точными именами. Плавающие псевдонимы вида
   "gemini-flash-latest" молча переезжают на новую версию, и распознавание
   начинает читать те же снимки иначе — именно так сканы и портятся сами,
   без единой правки кода. CHEAP разбирает обычные скриншоты, QUALITY —
   мелкий и рукописный текст, и включается сам, если дешёвая модель
   вернула пустую или явно кривую таблицу. */
const MODEL_CHEAP = "gemini-2.5-flash";
const MODEL_QUALITY = "gemini-2.5-pro";

const PROMPT = [
  "На фото — таблица туристов турагентства. Перепиши её в JSON дословно, как переписчик, а не как редактор.",
  "Верни строго JSON вида { \"columns\": [\"...\"], \"rows\": [[\"...\"]], \"title\": \"...\", \"tour\": \"...\" }.",
  "columns — заголовки столбцов слева направо, ровно теми словами, что на фото.",
  "rows — строки таблицы сверху вниз; в каждой строке ровно столько значений, сколько заголовков,",
  "и значение стоит на месте своего столбца. Пустая ячейка — пустая строка \"\".",
  "Ничего не переводи, не сокращай, не исправляй и не дополняй: имена, отели и пометки переписывай знак в знак.",
  "Телефон переписывай теми же цифрами и в том же виде, как на фото, вместе с «+» и нулём в начале;",
  "цифры не выбрасывай и не добавляй.",
  "Числа не пересчитывай и не складывай: сколько написано в ячейке, столько и передай.",
  "Если ячейка объединена на несколько строк — повтори её значение в каждой из этих строк.",
  "Если в ячейке галочка, крестик или плюс — передай их символом; пустое место оставь пустым.",
  "Строку таблицы не дроби на несколько и не склеивай несколько в одну.",
  "title — любой текст рядом с таблицей: над ней, под ней, на полях, от руки —",
  "название тура или маршрута, дата, имя гида. Текста нет — пустая строка.",
  "tour — какой это тур, если он виден на фото где угодно: в заголовке, в подписи, в столбце,",
  "в названии файла на экране. Допустимые значения: dalat (Далат), islands_north (Северные острова),",
  "islands_south (Южные острова), yangbay (Янгбей), baho (Бахо — Зоклет; Зоклет тоже baho).",
  "Тура на фото не видно — верни пустую строку, не угадывай по названиям отелей.",
  "Поле tour — это только подпись группы; числа из таблицы не меняй и не пересчитывай.",
  "Не добавляй пояснений вне JSON.",
].join(" ");

/* Тур распознаётся по самому фото — кнопкой «Определит ИИ» оператор просит
   именно это. Из снимка берётся только подпись группы: строки, имена и числа
   разносит страница сама, по распознанной таблице. */
const TOURS = ["", "dalat", "islands_north", "islands_south", "yangbay", "baho"];

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    columns: { type: "array", items: { type: "string" } },
    rows: { type: "array", items: { type: "array", items: { type: "string" } } },
    title: { type: "string" },
    tour: { type: "string", enum: TOURS },
  },
  required: ["columns", "rows"],
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

const SEP = "";

function cell(v) {
  return String(v == null ? "" : v).replace(/\s+/g, " ").trim();
}

/* Модель иногда отдаёт строки короче или длиннее шапки. Такую строку нельзя
   показывать как есть: значения съезжают на соседние столбцы, и телефон
   оказывается в отеле, а число детей — в цене. Приводим сетку к одной ширине. */
function normalizeGrid(parsed) {
  let columns = (Array.isArray(parsed?.columns) ? parsed.columns : []).map(cell);
  let rows = (Array.isArray(parsed?.rows) ? parsed.rows : [])
    .filter((r) => Array.isArray(r))
    .map((r) => r.map(cell));

  // Шапки нет, но строки есть — значит первая строка и была шапкой.
  if (!columns.some((c) => c) && rows.length) columns = rows.shift();

  const width = Math.max(columns.length, ...rows.map((r) => r.length), 0);
  columns = Array.from({ length: width }, (_, i) => columns[i] || "");
  rows = rows.map((r) => Array.from({ length: width }, (_, i) => r[i] || ""));

  const headKey = columns.join(SEP).toLowerCase();
  rows = rows.filter((r) => {
    if (!r.some((c) => c)) return false;                          // пустая строка
    if (r.join(SEP).toLowerCase() === headKey) return false;      // шапка повторилась в теле
    return true;
  });

  const title = cell(parsed?.title).slice(0, 200);
  const tour = TOURS.includes(parsed?.tour) ? parsed.tour : "";
  return { columns, rows, title, tour };
}

/* Таблица считается нечитаемой, если строк нет вовсе, столбец всего один или
   ячейки почти пустые: так бывает на мелком снимке, где модель сдалась. */
function looksBroken(grid) {
  if (!grid.rows.length) return true;
  if (grid.columns.length < 2) return true;
  const filled = grid.rows.reduce((n, r) => n + r.filter((c) => c).length, 0);
  return filled < grid.rows.length;   // меньше одной заполненной ячейки на строку
}

async function readTable(client, model, image, mimeType) {
  const response = await client.models.generateContent({
    model,
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
      // распознавание должно читать, а не придумывать: один и тот же снимок
      // обязан давать один и тот же результат
      temperature: 0,
      topP: 1,
    },
  });

  const text = response.text;
  if (!text) return null;
  try {
    return normalizeGrid(JSON.parse(text));
  } catch {
    return null;
  }
}

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let image, mimeType, mode;
  try {
    ({ image, mimeType, mode } = await req.json());
  } catch {
    return new Response(JSON.stringify({ error: "Некорректный запрос." }), { status: 400 });
  }
  if (!image) {
    return new Response(JSON.stringify({ error: "Изображение не передано." }), { status: 400 });
  }

  const wantQuality = mode === "quality";
  const client = createClient();

  try {
    let grid = await readTable(client, wantQuality ? MODEL_QUALITY : MODEL_CHEAP, image, mimeType);
    let escalated = false;

    // дешёвая модель ничего не прочитала — сами переходим на подробную,
    // как и обещано на странице
    if (!wantQuality && (!grid || looksBroken(grid))) {
      const better = await readTable(client, MODEL_QUALITY, image, mimeType);
      if (better && !looksBroken(better)) {
        grid = better;
        escalated = true;
      }
    }

    if (!grid) {
      return new Response(JSON.stringify({ error: "Не удалось разобрать ответ распознавания." }), { status: 502 });
    }
    if (!grid.rows.length) {
      return new Response(JSON.stringify({ error: "Таблица на фото не распознана. Нужен снимок покрупнее и чётче." }), { status: 502 });
    }

    return Response.json({
      columns: grid.columns,
      rows: grid.rows,
      title: grid.title,
      tour: grid.tour,
      quality: escalated || wantQuality,
      escalated,
    });
  } catch (e) {
    console.error("scan-table failed:", e);
    return new Response(JSON.stringify({ error: "Сервис распознавания временно недоступен." }), { status: 502 });
  }
};

export const config = {
  path: "/api/scan-table",
};
