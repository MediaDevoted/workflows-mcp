const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMS = 1536;
const MAX_BATCH = 100;
const TIMEOUT_MS = 30_000;

export class EmbeddingsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingsUnavailableError";
  }
}

export interface EmbeddingsClientOptions {
  apiKey: string;
}

export class EmbeddingsClient {
  constructor(private readonly options: EmbeddingsClientOptions) {
    if (!options.apiKey) {
      throw new EmbeddingsUnavailableError("OPENAI_API_KEY is not set");
    }
  }

  static get dimensions(): number {
    return EMBEDDING_DIMS;
  }

  static get model(): string {
    return EMBEDDING_MODEL;
  }

  async embed(input: string): Promise<number[]> {
    const [vector] = await this.embedBatch([input]);
    if (!vector) throw new EmbeddingsUnavailableError("OpenAI returned no embedding for single input");
    return vector;
  }

  async embedBatch(inputs: string[]): Promise<number[][]> {
    if (inputs.length === 0) return [];
    const out: number[][] = [];
    for (let i = 0; i < inputs.length; i += MAX_BATCH) {
      const chunk = inputs.slice(i, i + MAX_BATCH);
      const vectors = await this.callOpenAi(chunk);
      out.push(...vectors);
    }
    return out;
  }

  private async callOpenAi(inputs: string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(OPENAI_EMBEDDINGS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({ model: EMBEDDING_MODEL, input: inputs }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = (await response.text()).slice(0, 300);
        throw new EmbeddingsUnavailableError(`OpenAI embeddings HTTP ${response.status}: ${body}`);
      }
      const json = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
      const data = json.data ?? [];
      if (data.length !== inputs.length) {
        throw new EmbeddingsUnavailableError(`OpenAI embeddings returned ${data.length} vectors for ${inputs.length} inputs`);
      }
      return data.map((entry, idx) => {
        const vec = entry.embedding;
        if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIMS) {
          throw new EmbeddingsUnavailableError(`OpenAI embeddings vector ${idx} has unexpected shape`);
        }
        return vec;
      });
    } catch (error) {
      if (error instanceof EmbeddingsUnavailableError) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      throw new EmbeddingsUnavailableError(`OpenAI embeddings request failed: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
