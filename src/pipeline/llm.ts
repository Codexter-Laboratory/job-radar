export interface LlmResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmClient {
  readonly provider: string;
  readonly model: string;
  complete(system: string, user: string, opts?: { maxTokens?: number }): Promise<LlmResponse>;
}

/** USD per million tokens. Override in config when prices move. */
export interface Pricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

export function estimateCostUsd(
  inputTokens: number,
  outputTokens: number,
  pricing: Pricing
): number {
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion
  );
}

export class OpenAiClient implements LlmClient {
  readonly provider = "openai";

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.openai.com/v1"
  ) {}

  async complete(system: string, user: string, opts: { maxTokens?: number } = {}): Promise<LlmResponse> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });

    if (!res.ok) {
      throw new Error(`openai ${res.status}: ${await res.text()}`);
    }

    const data: any = await res.json();
    return {
      text: data?.choices?.[0]?.message?.content ?? "",
      inputTokens: data?.usage?.prompt_tokens ?? 0,
      outputTokens: data?.usage?.completion_tokens ?? 0,
    };
  }
}

export class AnthropicClient implements LlmClient {
  readonly provider = "anthropic";

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.anthropic.com/v1"
  ) {}

  async complete(system: string, user: string, opts: { maxTokens?: number } = {}): Promise<LlmResponse> {
    const res = await fetch(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: opts.maxTokens ?? 512,
        temperature: 0,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });

    if (!res.ok) {
      throw new Error(`anthropic ${res.status}: ${await res.text()}`);
    }

    const data: any = await res.json();
    const text = (data?.content ?? [])
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text)
      .join("");

    return {
      text,
      inputTokens: data?.usage?.input_tokens ?? 0,
      outputTokens: data?.usage?.output_tokens ?? 0,
    };
  }
}

export function clientFromEnv(env: NodeJS.ProcessEnv = process.env): LlmClient {
  const provider = (env.LLM_PROVIDER ?? "openai").toLowerCase();

  if (provider === "anthropic") {
    const key = env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
    return new AnthropicClient(env.LLM_MODEL ?? "claude-sonnet-4-5", key);
  }

  // Any OpenAI-compatible server works: Groq, Gemini, OpenRouter, or a local Ollama.
  const baseUrl = env.OPENAI_BASE_URL?.replace(/\/+$/, "");
  const key = env.OPENAI_API_KEY || (baseUrl?.includes("localhost") ? "ollama" : undefined);
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  return new OpenAiClient(env.LLM_MODEL ?? "gpt-4o-mini", key, baseUrl);
}
