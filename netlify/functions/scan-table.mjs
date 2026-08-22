export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  try {
    const { image, mimeType } = await req.json();
    const apiKey = process.env.GEMINI_API_KEY;
    
    const prompt = "Извлеки все данные таблицы с фото в JSON: { columns: ['...'], rows: [['...']] }";
    
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: mimeType || "image/jpeg", data: image } },
            { text: prompt }
          ]
        }],
        generationConfig: { response_mime_type: "application/json" }
      })
    });
    
    const data = await response.json();
    const text = data.candidates[0].content.parts[0].text;
    return new Response(text, { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};
