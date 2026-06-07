import crypto from "node:crypto"

export const nowIso = (): string => new Date().toISOString()

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export const randomInt = (min: number, max: number): number => {
  const low = Math.max(0, Math.floor(min))
  const high = Math.max(low, Math.floor(max))
  return low + Math.floor(Math.random() * (high - low + 1))
}

export const sha1 = (value: string): string => crypto.createHash("sha1").update(value).digest("hex")

export const normalizeWhitespace = (value: string): string =>
  value.replaceAll(/[\u00A0\u202F]/g, " ").replaceAll(/[ \t]+/g, " ").trim()

export const toOzonRuUrl = (rawUrl: string): string => {
  const parsed = new URL(rawUrl, "https://www.ozon.ru")
  parsed.protocol = "https:"
  if (parsed.hostname === "ozon.com" || parsed.hostname === "www.ozon.com" || parsed.hostname === "ozon.ru") {
    parsed.hostname = "www.ozon.ru"
  }
  return parsed.toString()
}

export const toOzonComUrl = (rawUrl: string): string => {
  const parsed = new URL(rawUrl, "https://ozon.com")
  parsed.protocol = "https:"
  if (parsed.hostname === "www.ozon.ru" || parsed.hostname === "ozon.ru" || parsed.hostname === "www.ozon.com") {
    parsed.hostname = "ozon.com"
  }
  return parsed.toString()
}

export const pagePathFromUrl = (rawUrl: string): string => {
  const parsed = new URL(toOzonRuUrl(rawUrl))
  return `${parsed.pathname}${parsed.search}`
}

export const safeId = (value: string): string =>
  value
    .toLowerCase()
    .replaceAll(/[^a-z0-9а-яё_-]+/gi, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 80) || sha1(value).slice(0, 16)

export const sellerKeyFromUrl = (sellerUrl: string): string => {
  const parsed = new URL(toOzonRuUrl(sellerUrl))
  const matched = parsed.pathname.match(/\/seller\/([^/?#]+)\/?/i)
  return safeId(matched?.[1] ?? parsed.pathname)
}

export const productKeyFromUrl = (productUrl: string): string => {
  const parsed = new URL(toOzonRuUrl(productUrl))
  const matched = parsed.pathname.match(/\/product\/([^/?#]+)\/?/i)
  return safeId(matched?.[1] ?? parsed.pathname)
}

export const shardPath = (key: string): string => {
  const hash = sha1(key)
  return `${hash.slice(0, 2)}/${hash.slice(2, 4)}`
}

export const uniquePush = <T>(items: Array<T>, item: T, key: (value: T) => string): boolean => {
  const itemKey = key(item)
  if (items.some((value) => key(value) === itemKey)) {
    return false
  }
  items.push(item)
  return true
}

export const toErrorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)
