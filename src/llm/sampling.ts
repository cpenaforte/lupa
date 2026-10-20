/** OpenAI reasoning models (strict family, and the max_completion_tokens family). */
const OPENAI_REASONING_RE = /\bo\d|gpt-5|gpt-6/i;
/** Claude version token: major, then an optional 1–2 digit minor not followed by another digit (so dates are never read as minors). */
const CLAUDE_VERSION_RE = /claude[^\d]*(\d+)(?:[.-](\d{1,2})(?!\d))?/i;

/**
 * STRICT family (sampling params rejected unless at defaults):
 * OpenAI reasoning models, or Claude major >= 5, or Claude 4.7 and later.
 * Claude 4.0–4.6, Claude 3.x and dated ids are not strict.
 */
function isStrictFamily(model: string): boolean {
  if (OPENAI_REASONING_RE.test(model)) return true;
  const m = CLAUDE_VERSION_RE.exec(model);
  if (m === null) return false;
  const major = Number(m[1]);
  const minor = m[2] === undefined ? 0 : Number(m[2]);
  return major >= 5 || (major === 4 && minor >= 7);
}

export function isAnthropicCompat(provider: string, apiStyle?: string): boolean {
  return provider === "anthropic" || apiStyle === "anthropic-messages";
}

export function validateSampling(o: {
  model: string;
  temperature?: number;
  topP?: number;
  n?: number;
  provider: string;
  apiStyle?: string;
}): void {
  const anthropic = isAnthropicCompat(o.provider, o.apiStyle);

  if (isStrictFamily(o.model)) {
    const explicit =
      (o.temperature !== undefined && o.temperature !== 1) ||
      o.topP !== undefined ||
      (o.n !== undefined && o.n !== 1);
    if (explicit) {
      throw new Error(
        anthropic
          ? `Model "${o.model}" is a reasoning model: Anthropic-compat rejects temperature, top_p and n (HTTP 400). Remove them.`
          : `Model "${o.model}" is a reasoning model: temperature, top_p and n must be left at their defaults. Remove them.`,
      );
    }
    return;
  }

  if (anthropic) {
    if (o.n !== undefined && o.n !== 1) {
      throw new Error(`Anthropic-compat supports only n=1; n must be 1 or unset`);
    }
    if (o.temperature !== undefined && o.topP !== undefined) {
      throw new Error(`temperature and top_p cannot be set together on Anthropic-compat`);
    }
    if (o.temperature !== undefined && !(o.temperature >= 0 && o.temperature <= 1)) {
      throw new Error(`temperature must be between 0 and 1`);
    }
    if (o.topP !== undefined && !(o.topP >= 0 && o.topP <= 1)) {
      throw new Error(`top_p must be between 0 and 1`);
    }
  }
}

/** OpenAI reasoning only. Claude always uses max_tokens (Anthropic API). */
export function tokenFieldFor(model: string): "max_completion_tokens" | "max_tokens" {
  return OPENAI_REASONING_RE.test(model) ? "max_completion_tokens" : "max_tokens";
}
