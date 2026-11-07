// Masks secrets in text that leaves the app through the CLI and MCP server, where it usually
// ends up in a coding agent's conversation. The app's own window shows the output as it is.

const MASK = '[redacted]'
// Shorter values are too likely to match ordinary words ("dev", "true").
const MIN_SECRET_LENGTH = 6

// Credentials that look the same whichever service prints them.
const TOKEN_SHAPES = [
  /\b(?:sk|pk|rk)[-_](?:live|test|ant|proj)?[-_]?[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abeoprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
]

export const SECRET_NAME = /SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_?KEY|AUTH_?KEY|ACCESS_?KEY/i

export function redactText(text: string, secrets: string[] = []) {
  let result = text
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret.length >= MIN_SECRET_LENGTH) result = result.split(secret).join(MASK)
  }
  for (const shape of TOKEN_SHAPES) result = result.replace(shape, MASK)
  return result
    // postgres://user:password@host
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)[^\s/@]+(@)/gi, `$1${MASK}$2`)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${MASK}`)
    // API_KEY=abc, --token abc, "password": "abc"
    .replace(/([\w-]*(?:secret|token|password|passwd|api[_-]?key)[\w-]*["']?\s*(?:=|:|\s)\s*["']?)([^\s"',;&]{4,})/gi, (match, name: string, value: string) =>
      value === MASK || /^(?:true|false|null|undefined|expired|invalid|missing|required)$/i.test(value) ? match : `${name}${MASK}`)
}
