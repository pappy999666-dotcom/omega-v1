// ============================================================
// Poll Game Engine — AI provider
//
// The resolver is called with the current WhatsApp session id for
// every request. No global key is used as a fallback: a game can
// only run after that session has configured its own provider.
// ============================================================

import type { GameApiConfig, QuizQuestionContent, WyrContent } from './types.js';
import { POLL_GAME_CONFIG } from './config.js';

const DEFAULT_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

export interface GameAiOptions {
  getConfig: (sessionId: string) => GameApiConfig | null;
  fetchImpl?: typeof fetch;
}

export class GameAI {
  private readonly getConfig: (sessionId: string) => GameApiConfig | null;
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<string, QuizQuestionContent[]>();

  public constructor(options: GameAiOptions) {
    this.getConfig = options.getConfig;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  }

  public isConfigured(sessionId: string): boolean {
    return Boolean(this.getConfig(sessionId)?.apiKey);
  }

  public configuredModel(sessionId: string): string {
    return this.getConfig(sessionId)?.model ?? DEFAULT_MODEL;
  }

  public cacheQuiz(gameId: string, questions: QuizQuestionContent[]): void {
    this.cache.set(gameId, questions);
  }

  public getCachedQuiz(gameId: string): QuizQuestionContent[] | undefined {
    return this.cache.get(gameId);
  }

  public clearCache(gameId: string): void {
    this.cache.delete(gameId);
  }

  /** Generate one fresh, family-safe WYR prompt. */
  public async generateWyr(sessionId: string): Promise<WyrContent> {
    const content = await this.completeJSON(sessionId, [
      'You are the game master for a family-safe WhatsApp group.',
      'Generate ONE original, varied and debatable Would You Rather question.',
      'Include two concrete choices. Avoid harmful, illegal, sexual, hateful or political content.',
      'Keep the question and choices concise enough for a WhatsApp poll.',
      'Return STRICT JSON only:',
      '{"question":"Would you rather ...?","optionA":"...","optionB":"..."}',
    ].join('\n'), { temperature: 0.9, maxTokens: 500 });
    const question = String(content.question ?? '').trim();
    const optionA = String(content.optionA ?? '').trim();
    const optionB = String(content.optionB ?? '').trim();
    if (!question || !optionA || !optionB || optionA === optionB) {
      throw new Error('Game AI returned an incomplete WYR question.');
    }
    return { question, optionA, optionB };
  }

  /** Generate a deterministic question bank once for a Quiz game. */
  public async generateQuiz(
    sessionId: string,
    count: number,
    categories: string[],
  ): Promise<QuizQuestionContent[]> {
    const safeCount = Math.max(1, Math.min(count, POLL_GAME_CONFIG.maximumQuestions));
    const content = await this.completeJSON(sessionId, [
      'You are the quiz master for a family-safe WhatsApp group.',
      `Generate EXACTLY ${safeCount} varied multiple-choice questions.`,
      'Use a mixture of the supplied categories and exactly one correct answer per question.',
      'Questions must be factual, unambiguous, concise, and safe for a general group.',
      `Categories: ${categories.join(', ')}.`,
      'Return STRICT JSON only as {"questions":[...]} with this shape:',
      '{"question":"...","options":["...","...","...","..."],"correctIndex":0,"explanation":"...","category":"Science","difficulty":"easy|medium|hard"}',
      'correctIndex is zero-based. Do not reveal the answer outside correctIndex/explanation fields.',
    ].join('\n'), { temperature: 0.85, maxTokens: Math.min(6000, 500 + safeCount * 400) });

    const raw = Array.isArray(content.questions) ? content.questions : [];
    const questions: QuizQuestionContent[] = [];
    for (const item of raw.slice(0, safeCount)) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const question = String(record.question ?? '').trim();
      const options = Array.isArray(record.options)
        ? record.options.map((option) => String(option).trim()).filter(Boolean).slice(0, 4)
        : [];
      const correctIndex = Number(record.correctIndex);
      if (!question || options.length < 2 || !Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length) continue;
      const difficulty = ['easy', 'medium', 'hard'].includes(String(record.difficulty))
        ? String(record.difficulty) as QuizQuestionContent['difficulty']
        : 'medium';
      questions.push({
        question,
        options,
        correctIndex,
        explanation: String(record.explanation ?? '').trim() || 'The answer is shown after the poll closes.',
        category: String(record.category ?? 'General Knowledge').trim() || 'General Knowledge',
        difficulty,
      });
    }
    if (questions.length === 0) throw new Error('Game AI returned no valid quiz questions.');
    return questions;
  }

  private async completeJSON(
    sessionId: string,
    prompt: string,
    opts: { temperature: number; maxTokens: number },
  ): Promise<Record<string, unknown>> {
    const cfg = this.getConfig(sessionId);
    if (!cfg?.apiKey) {
      throw new Error('No Game API configured for this WhatsApp session. Use .gameapi guide, then .gameapi <key>.');
    }
    const endpoint = cfg.endpoint ?? DEFAULT_ENDPOINT;
    const model = cfg.model ?? DEFAULT_MODEL;
    let lastError = 'request failed';

    for (let attempt = 1; attempt <= POLL_GAME_CONFIG.aiRetryAttempts; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const response = await this.fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: 'Output only valid JSON. No markdown or code fences.' },
              { role: 'user', content: prompt },
            ],
            temperature: opts.temperature,
            max_tokens: opts.maxTokens,
            response_format: { type: 'json_object' },
            stream: false,
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const body = await response.text().catch(() => '');
          let reason = '';
          try {
            const parsed = JSON.parse(body) as { error?: { code?: string; message?: string } };
            reason = `${parsed.error?.code ?? ''} ${parsed.error?.message ?? ''}`.trim();
          } catch { /* provider returned non-JSON */ }
          reason = reason.replaceAll(cfg.apiKey, '[redacted]').slice(0, 160);
          lastError = `Game AI returned HTTP ${response.status}${reason ? ` — ${reason}` : ''}.`;
        } else {
          const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
          const raw = data.choices?.[0]?.message?.content?.trim() ?? '';
          if (!raw) {
            lastError = 'Game AI returned an empty response.';
          } else {
            const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
            try {
              return JSON.parse(cleaned) as Record<string, unknown>;
            } catch {
              const start = raw.indexOf('{');
              const end = raw.lastIndexOf('}');
              if (start >= 0 && end > start) {
                try { return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>; } catch { /* retry */ }
              }
              lastError = 'Game AI returned unparseable JSON.';
            }
          }
        }
      } catch (error) {
        lastError = `Game AI request failed: ${error instanceof Error ? error.message : String(error)}`;
        lastError = lastError.replaceAll(cfg.apiKey, '[redacted]');
      } finally {
        clearTimeout(timeout);
      }
      if (attempt < POLL_GAME_CONFIG.aiRetryAttempts) {
        await new Promise((resolve) => setTimeout(resolve, POLL_GAME_CONFIG.aiRetryBackoffMs * attempt));
      }
    }
    throw new Error(lastError);
  }
}

export const QUIZ_CATEGORIES = [
  'Mathematics', 'History', 'Geography', 'Science', 'Technology', 'Sports',
  'Entertainment', 'General Knowledge', 'Literature', 'Logic', 'Random Trivia',
];
