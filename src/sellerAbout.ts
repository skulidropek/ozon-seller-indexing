import type { LegalIdentifierType, SellerAboutFields } from "./types.js"
import { normalizeWhitespace } from "./utils.js"

export const emptySellerAboutFields = (): SellerAboutFields => ({
  sellerLegalName: null,
  sellerLegalPersonName: null,
  sellerLegalIdentifier: null,
  sellerLegalIdentifierType: null,
  sellerAboutText: null,
  sellerAboutRawJson: null,
  sellerAboutExtractedAt: null
})

const nonLegalLines = new Set([
  "о магазине",
  "заказов",
  "работает с ozon",
  "средняя оценка товаров",
  "количество отзывов",
  "оригинальные товары брендов",
  "оригинальность товаров подтверждена сертификатами",
  "работает согласно графику ozon",
  "понятно"
])

const decodeBasicHtmlEntities = (value: string): string =>
  value
    .replaceAll(/&nbsp;|&#160;|&#xA0;/gi, " ")
    .replaceAll(/&amp;/gi, "&")
    .replaceAll(/&quot;/gi, "\"")
    .replaceAll(/&#39;|&apos;/gi, "'")
    .replaceAll(/&lt;/gi, "<")
    .replaceAll(/&gt;/gi, ">")

const htmlIgnoredBlockPattern = /<\s*(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\s*\1\s*>/gi

const htmlBreakPattern = /<\s*br\s*\/?\s*>|<\/\s*(?:div|p|span|li|tr|td|section|article|h[1-6])\s*>/gi

const stripHtmlToText = (value: string): string =>
  decodeBasicHtmlEntities(value.replaceAll(htmlIgnoredBlockPattern, " "))
    .replaceAll(htmlBreakPattern, "\n")
    .replaceAll(/<[^>]*>/g, " ")

const toNormalizedLines = (rawText: string): ReadonlyArray<string> =>
  stripHtmlToText(rawText)
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line.length > 0)

const isLegalIdentifierLine = (line: string): boolean => {
  const digits = line.replaceAll(/\D/g, "")
  return line.replaceAll(/\s/g, "") === digits &&
    (digits.length === 10 || digits.length === 12 || digits.length === 13 || digits.length === 15)
}

const classifyLegalIdentifier = (identifier: string): LegalIdentifierType => {
  if (identifier.length === 10 || identifier.length === 12) {
    return "inn"
  }
  if (identifier.length === 13) {
    return "ogrn"
  }
  if (identifier.length === 15) {
    return "ogrnip"
  }
  return "unknown"
}

type LegalIdentifierMatch = {
  readonly lineIndex: number
  readonly identifier: string
  readonly startIndex: number
}

const readLegalIdentifierInLine = (line: string): Omit<LegalIdentifierMatch, "lineIndex"> | null => {
  if (isLegalIdentifierLine(line)) {
    return {
      identifier: line.replaceAll(/\D/g, ""),
      startIndex: 0
    }
  }

  for (const match of line.matchAll(/(?:\d[\s-]*){10,15}/g)) {
    const rawMatch = match[0]
    const digits = rawMatch.replaceAll(/\D/g, "")
    if (digits.length === 10 || digits.length === 12 || digits.length === 13 || digits.length === 15) {
      return {
        identifier: digits,
        startIndex: match.index ?? 0
      }
    }
  }
  return null
}

const findLegalIdentifierMatches = (lines: ReadonlyArray<string>): ReadonlyArray<LegalIdentifierMatch> => {
  const result: Array<LegalIdentifierMatch> = []
  lines.forEach((line, lineIndex) => {
    const matched = readLegalIdentifierInLine(line)
    if (matched !== null) {
      result.push({
        ...matched,
        lineIndex
      })
    }
  })
  return result
}

const isUsefulLegalNameLine = (line: string): boolean => {
  const normalized = line.toLowerCase()
  if (nonLegalLines.has(normalized)) {
    return false
  }
  if (
    normalized.startsWith("{") ||
    normalized.startsWith("[") ||
    normalized.includes("{\"") ||
    normalized.includes("\"component\"") ||
    normalized.includes("cms.")
  ) {
    return false
  }
  return !/^\d/.test(normalized)
}

const extractLegalNameCandidate = (line: string): string | null => {
  const cleaned = normalizeWhitespace(line).replaceAll(/[|:;,]+$/g, "").trim()
  if (!isUsefulLegalNameLine(cleaned)) {
    return null
  }
  const matched = cleaned.match(
    /(?:^|\s)((?:ип|индивидуальный предприниматель|ооо|общество с ограниченной ответственностью|ао|пао|зао)\s+[^{}[\]]+)$/i
  )
  if (matched?.[1] === undefined) {
    return null
  }
  const candidate = normalizeWhitespace(matched[1])
  return candidate.length > 0 && isUsefulLegalNameLine(candidate) ? candidate : null
}

const findLegalNameBefore = (lines: ReadonlyArray<string>, identifierIndex: number): string | null => {
  for (let index = identifierIndex - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (line !== undefined && isUsefulLegalNameLine(line)) {
      return extractLegalNameCandidate(line)
    }
  }
  return null
}

const toLegalPersonName = (legalName: string | null): string | null => {
  if (legalName === null) {
    return null
  }
  const withoutIpPrefix = legalName.replace(/^ип\s+/i, "").trim()
  const withoutFullPrefix = withoutIpPrefix.replace(/^индивидуальный предприниматель\s+/i, "").trim()
  return withoutFullPrefix.length > 0 && withoutFullPrefix !== legalName ? withoutFullPrefix : null
}

const readLegalNameAt = (lines: ReadonlyArray<string>, matched: LegalIdentifierMatch | null): string | null => {
  if (matched === null) {
    return null
  }
  const line = lines[matched.lineIndex]
  if (line !== undefined && matched.startIndex > 0) {
    const inlineCandidate = extractLegalNameCandidate(line.slice(0, matched.startIndex))
    if (inlineCandidate !== null) {
      return inlineCandidate
    }
  }
  return findLegalNameBefore(lines, matched.lineIndex)
}

export const extractSellerAboutFieldsFromText = (input: {
  readonly rawText: string
  readonly rawJson: string | null
  readonly extractedAt: string
}): SellerAboutFields => {
  const lines = toNormalizedLines(input.rawText)
  const normalizedText = lines.join("\n")
  const identifierMatch = findLegalIdentifierMatches(lines).find((matched) => readLegalNameAt(lines, matched) !== null) ??
    null
  const identifier = identifierMatch?.identifier ?? null
  const legalName = readLegalNameAt(lines, identifierMatch)

  return {
    sellerLegalName: legalName,
    sellerLegalPersonName: toLegalPersonName(legalName),
    sellerLegalIdentifier: identifier,
    sellerLegalIdentifierType: identifier === null ? null : classifyLegalIdentifier(identifier),
    sellerAboutText: normalizedText.length > 0 ? normalizedText : null,
    sellerAboutRawJson: input.rawJson,
    sellerAboutExtractedAt: normalizedText.length > 0 || input.rawJson !== null ? input.extractedAt : null
  }
}
