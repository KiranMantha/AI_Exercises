// Client for any OpenAI-compatible server hosting Unlimited-OCR
// (vLLM, llama.cpp server, Ollama's /v1 endpoint).
const BASE_URL = process.env.OCR_BASE_URL ?? "http://localhost:8000/v1";
const MODEL = process.env.OCR_MODEL ?? "baidu/Unlimited-OCR";
const PROMPT = process.env.OCR_PROMPT ?? "document parsing.";
const TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS ?? 300_000);

export async function ocrImage(png) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.OCR_API_KEY && {
        authorization: `Bearer ${process.env.OCR_API_KEY}`,
      }),
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
              },
            },
            { type: "text", text: PROMPT },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OCR server ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content.trim();
}
