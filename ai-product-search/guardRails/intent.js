// Guards on what the LLM returns: it is never trusted, every field is validated.
export const GENDERS = ["Men", "Women", "Boys", "Girls", "Unisex"];

// Sent as response_format so the endpoint itself can only produce this shape.
export const intentSchema = (types) => ({
  type: "object",
  properties: {
    relevant: { type: "boolean" },
    query: { type: "string" },
    gender: { enum: [...GENDERS, "none"] },
    types: { type: "array", items: { enum: types } },
  },
  required: ["relevant", "query", "gender", "types"],
  additionalProperties: false,
});

export function parseIntent(text, fallback, types) {
  try {
    const j = JSON.parse(text.match(/\{[\s\S]*\}/)[0]);
    if (j.relevant === false) return { relevant: false, query: fallback, gender: null, types: [], llm: true };
    const query = typeof j.query === "string" ? j.query.trim().slice(0, 200) : "";
    return {
      relevant: true,
      query: query || fallback,
      gender: GENDERS.includes(j.gender) ? j.gender : null,
      types: (Array.isArray(j.types) ? j.types : []).filter((t) => types.includes(t)),
      llm: true,
    };
  } catch {
    return { relevant: true, query: fallback, gender: null, types: [], llm: false, error: `unparseable LLM output: ${String(text).slice(0, 120)}` };
  }
}
