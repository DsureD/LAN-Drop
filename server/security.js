export function contentSecurityPolicy(host) {
  const sources = ["'self'"];
  if (typeof host === 'string' && /^(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:.]+\])(?::\d{1,5})?$/.test(host)) {
    try {
      const plain = new URL(`ws://${host}`);
      const secure = new URL(`wss://${host}`);
      sources.push(plain.origin, secure.origin);
    } catch {}
  }
  return `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src ${sources.join(' ')}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`;
}
