/**
 * Atributo HTML com lista separada por vírgulas → conjunto.
 * "a, b,c" → {"a","b","c"}; vazio ou ausente → conjunto vazio (= sem filtro).
 */
export function listAttr(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
  );
}
