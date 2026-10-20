/** Render-only identity metadata. Raw Finding and artifact contracts stay unchanged. */
export const THREAD_BODY_BYTES = 60000;
const PREFIX = "<!-- lupa:rules:v1:";

export function memberRuleMarker(rules: readonly string[]): string {
  return `${PREFIX}${Buffer.from(JSON.stringify(rules), "utf8").toString("base64url")} -->`;
}

/** Bound the encoded input before allocation/decoding; malformed markers use legacy parsing. */
export function memberRulesOf(body: unknown): readonly string[] | undefined {
  if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > THREAD_BODY_BYTES) return undefined;
  const match = /\n\n<!-- lupa:rules:v1:([A-Za-z0-9_-]+) -->$/.exec(body);
  if (match === null) return undefined;
  const encoded = match[1]!;
  try {
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.toString("base64url") !== encoded) return undefined;
    const rules: unknown = JSON.parse(decoded.toString("utf8"));
    if (!Array.isArray(rules) || rules.length === 0 || rules.some((rule: unknown) => typeof rule !== "string")) return undefined;
    return rules as string[];
  } catch {
    return undefined;
  }
}
