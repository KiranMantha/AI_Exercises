import { pipeline } from "@huggingface/transformers";

const MODEL = "Xenova/all-MiniLM-L6-v2"; // 384 dimensions
let extractorPromise;

function getExtractor() {
  extractorPromise ??= pipeline("feature-extraction", MODEL);
  return extractorPromise;
}

async function embed(texts) {
  const extractor = await getExtractor();
  const output = await extractor(texts, { pooling: "mean", normalize: true });
  return output.tolist();
}

export const embeddings = {
  async embedQuery(text) {
    const [vector] = await embed([text]);
    return vector;
  },
  async embedDocuments(texts) {
    const vectors = [];
    for (let i = 0; i < texts.length; i += 32) {
      vectors.push(...(await embed(texts.slice(i, i + 32))));
    }
    return vectors;
  },
};
