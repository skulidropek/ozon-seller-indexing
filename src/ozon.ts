import { chromium, type Browser, type BrowserContext, type Page } from "playwright"

import { extractSellerAboutFieldsFromText } from "./sellerAbout.js"
import { writeBinaryArtifact, writeTextArtifact } from "./storage.js"
import type { IndexerConfig, JsonValue, OzonBlockSource, SellerAboutFields } from "./types.js"
import { nowIso, normalizeWhitespace, safeId, sellerKeyFromUrl, toErrorMessage, toOzonComUrl, toOzonRuUrl } from "./utils.js"

export class OzonBlockError extends Error {
  readonly blockSource: OzonBlockSource
  readonly artifacts: ReadonlyArray<string>

  constructor(
    message: string,
    input: {
      readonly blockSource: OzonBlockSource
      readonly artifacts?: ReadonlyArray<string>
    }
  ) {
    super(message)
    this.name = "OzonBlockError"
    this.blockSource = input.blockSource
    this.artifacts = input.artifacts ?? []
  }
}

const isRecord = (value: JsonValue): value is { readonly [key: string]: JsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseMaybeJson = (value: JsonValue): JsonValue => {
  if (typeof value !== "string") {
    return value
  }
  const trimmed = value.trim()
  if ((!trimmed.startsWith("{") && !trimmed.startsWith("[")) || trimmed.length < 2) {
    return value
  }
  try {
    return JSON.parse(trimmed) as JsonValue
  } catch {
    return value
  }
}

const walkJson = (value: JsonValue, visit: (value: JsonValue) => void): void => {
  visit(value)
  const parsed = parseMaybeJson(value)
  if (parsed !== value) {
    walkJson(parsed, visit)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      walkJson(item, visit)
    }
    return
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      walkJson(item, visit)
    }
  }
}

const trimUrlTail = (value: string): string => value.replaceAll(/[),.;\]}]+$/g, "")

const collectOzonUrls = (value: JsonValue, kind: "product" | "seller"): ReadonlyArray<string> => {
  const found = new Set<string>()
  const fullPattern = new RegExp(`https?://(?:www\\.)?ozon\\.(?:ru|com)/${kind}/[^\\s"'<>\\\\]+`, "giu")
  const pathPattern = new RegExp(`/${kind}/[^\\s"'<>\\\\]+`, "giu")
  walkJson(value, (item) => {
    if (typeof item !== "string") {
      return
    }
    for (const match of item.matchAll(fullPattern)) {
      found.add(toOzonRuUrl(trimUrlTail(match[0])))
    }
    for (const match of item.matchAll(pathPattern)) {
      found.add(toOzonRuUrl(trimUrlTail(match[0])))
    }
  })
  return [...found].sort()
}

const readTextField = (record: { readonly [key: string]: JsonValue }, keys: ReadonlyArray<string>): string | null => {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && normalizeWhitespace(value).length > 0) {
      return normalizeWhitespace(value)
    }
  }
  return null
}

export type SellerCandidate = {
  readonly sellerUrl: string
  readonly sellerKey: string
  readonly sellerName: string | null
}

export const extractSellerCandidates = (json: JsonValue): ReadonlyArray<SellerCandidate> => {
  const candidates = new Map<string, SellerCandidate>()
  walkJson(json, (item) => {
    if (!isRecord(item)) {
      return
    }
    const maybeLink = readTextField(item, ["link", "url", "href", "action", "sellerUrl"])
    if (maybeLink === null || !maybeLink.includes("/seller/")) {
      return
    }
    const sellerUrl = toOzonRuUrl(maybeLink)
    const sellerKey = sellerKeyFromUrl(sellerUrl)
    candidates.set(sellerKey, {
      sellerUrl,
      sellerKey,
      sellerName: readTextField(item, ["title", "name", "text", "sellerName"])
    })
  })
  for (const sellerUrl of collectOzonUrls(json, "seller")) {
    const sellerKey = sellerKeyFromUrl(sellerUrl)
    if (!candidates.has(sellerKey)) {
      candidates.set(sellerKey, {
        sellerUrl,
        sellerKey,
        sellerName: null
      })
    }
  }
  return [...candidates.values()].sort((left, right) => left.sellerKey.localeCompare(right.sellerKey))
}

export const extractProductUrls = (json: JsonValue): ReadonlyArray<string> => collectOzonUrls(json, "product")

export const extractNextPagePath = (json: JsonValue): string | null => {
  if (isRecord(json) && typeof json.nextPage === "string" && json.nextPage.trim().length > 0) {
    return json.nextPage
  }
  let result: string | null = null
  walkJson(json, (item) => {
    if (result !== null || !isRecord(item)) {
      return
    }
    const nextPage = item.nextPage
    if (typeof nextPage === "string" && nextPage.trim().length > 0) {
      result = nextPage
    }
  })
  return result
}

const buildEntrypointUrl = (pagePath: string): string =>
  `https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2?url=${encodeURIComponent(pagePath)}`

const blockTextPatterns = [
  /мы заметили подозрительную активность/i,
  /подозрительн[а-я\s]+активност/i,
  /доступ ограничен/i,
  /captcha/i,
  /forbidden/i,
  /access denied/i
]

const detectBlockReason = (text: string, source: string): string | null => {
  if (text.includes("__rr=") && text.includes("location")) {
    return `ozon_redirect_loop:${source}`
  }
  if (blockTextPatterns.some((pattern) => pattern.test(text))) {
    return `ozon_antibot_screen:${source}`
  }
  return null
}

const assertNotBlockedText = (text: string, source: string, blockSource: OzonBlockSource): void => {
  const reason = detectBlockReason(text, source)
  if (reason !== null) {
    throw new OzonBlockError(reason, { blockSource })
  }
}

const captureDiagnosticScreenshot = async (
  page: Page
): Promise<{
  readonly bytes: Uint8Array | null
  readonly mode: "fullPage" | "viewport" | null
  readonly error: string | null
}> => {
  const fullPage = await page.screenshot({ fullPage: true }).then(
    (bytes) => ({ bytes, mode: "fullPage" as const, error: null }),
    (error: unknown) => ({ bytes: null, mode: null, error: `fullPage:${toErrorMessage(error)}` })
  )
  if (fullPage.bytes !== null) {
    return fullPage
  }
  return page.screenshot({ fullPage: false }).then(
    (bytes) => ({ bytes, mode: "viewport" as const, error: fullPage.error }),
    (error: unknown) => ({
      bytes: null,
      mode: null,
      error: `${fullPage.error};viewport:${toErrorMessage(error)}`
    })
  )
}

export const savePageDiagnostics = async (input: {
  readonly config: IndexerConfig
  readonly page: Page
  readonly label: string
  readonly reason: string
  readonly source: OzonBlockSource
}): Promise<ReadonlyArray<string>> => {
  const capturedAt = nowIso()
  const baseName = `${capturedAt.replaceAll(/[^0-9]/g, "").slice(0, 14)}-${safeId(input.label).slice(0, 80)}`
  const html = await input.page.content().catch((error: unknown) => `page_content_failed:${toErrorMessage(error)}`)
  const text = await input.page.locator("body").textContent({ timeout: 2_000 }).catch(() => null)
  const title = await input.page.title().catch(() => null)
  const screenshot = await captureDiagnosticScreenshot(input.page)
  const paths = [await writeTextArtifact(input.config, `diagnostics/${baseName}.html`, html)]
  const screenshotPath =
    screenshot.bytes === null
      ? null
      : await writeBinaryArtifact(input.config, `diagnostics/${baseName}.png`, screenshot.bytes)
  if (screenshotPath !== null) {
    paths.push(screenshotPath)
  }
  const metadata = {
    capturedAt,
    label: input.label,
    reason: input.reason,
    source: input.source,
    currentUrl: input.page.url(),
    title,
    screenshot: {
      mode: screenshot.mode,
      path: screenshotPath,
      error: screenshot.error
    },
    text
  }
  paths.push(await writeTextArtifact(input.config, `diagnostics/${baseName}.json`, JSON.stringify(metadata, null, 2)))
  return paths
}

export const openBrowser = async (config: IndexerConfig): Promise<Browser> =>
  chromium.launch({
    headless: config.headless
  })

export const openContext = async (browser: Browser, config: IndexerConfig): Promise<BrowserContext> =>
  browser.newContext({
    locale: "ru-RU",
    timezoneId: "Europe/Moscow",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    viewport: {
      width: 1365,
      height: 900
    },
    ignoreHTTPSErrors: true,
    javaScriptEnabled: true
  })

export const fetchEntrypointJson = async (input: {
  readonly context: BrowserContext
  readonly pagePath: string
  readonly timeoutMs: number
}): Promise<JsonValue> => {
  const requestUrl = buildEntrypointUrl(input.pagePath)
  const response = await input.context.request.get(requestUrl, {
    maxRedirects: 3,
    timeout: input.timeoutMs,
    headers: {
      accept: "application/json",
      referer: "https://www.ozon.ru/"
    }
  })
  const status = response.status()
  const text = await response.text()
  if (status === 403 || status === 429 || status === 451) {
    throw new OzonBlockError(`ozon_http_${status}:${input.pagePath}`, { blockSource: "request_context" })
  }
  assertNotBlockedText(text, input.pagePath, "request_context")
  if (status < 200 || status >= 300) {
    throw new Error(`ozon_http_${status}:${input.pagePath}`)
  }
  try {
    return JSON.parse(text) as JsonValue
  } catch (error) {
    throw new Error(`ozon_json_parse_failed:${input.pagePath}:${toErrorMessage(error)}`)
  }
}

export const fetchRenderedPageSnapshot = async (input: {
  readonly page: Page
  readonly config: IndexerConfig
  readonly pagePath: string
  readonly label: string
}): Promise<JsonValue> => {
  const pageUrl = new URL(input.pagePath, "https://www.ozon.ru").toString()
  const response = await input.page.goto(pageUrl, {
    waitUntil: "domcontentloaded",
    timeout: input.config.navigationTimeoutMs
  }).catch((error: unknown) => {
    throw new Error(`rendered_page_navigation_failed:${pageUrl}:${toErrorMessage(error)}`)
  })
  await input.page.waitForTimeout(2_000)
  const status = response?.status() ?? null
  const text = await input.page.locator("body").textContent({ timeout: 5_000 }).catch(() => "")
  const html = await input.page.content().catch(() => "")
  const reason = status !== null && [403, 429, 451].includes(status)
    ? `ozon_rendered_http_${status}:${input.pagePath}`
    : detectBlockReason(`${text}\n${html}`, input.pagePath)
  if (reason !== null) {
    const artifacts = await savePageDiagnostics({
      config: input.config,
      page: input.page,
      label: input.label,
      reason,
      source: "browser_page"
    })
    throw new OzonBlockError(reason, {
      blockSource: "browser_page",
      artifacts
    })
  }

  return {
    source: "browser_page",
    pagePath: input.pagePath,
    url: pageUrl,
    currentUrl: input.page.url(),
    status,
    text,
    html,
    capturedAt: nowIso()
  }
}

const clickSellerShopPill = async (page: Page): Promise<boolean> => {
  const locators = [
    page.getByRole("button", { name: /магазин/i }).first(),
    page.locator("button", { hasText: "Магазин" }).first(),
    page.locator("text=Магазин").first()
  ]
  for (const locator of locators) {
    try {
      if (await locator.isVisible({ timeout: 2_000 })) {
        await locator.click({ timeout: 5_000 })
        return true
      }
    } catch {
      // Try next selector.
    }
  }
  return false
}

const readAboutSnapshot = async (page: Page): Promise<{ readonly text: string; readonly html: string } | null> => {
  const modal = page.locator("[data-widget='modalLayout'], [role='dialog']").filter({ hasText: /О магазине/i }).first()
  try {
    if (await modal.isVisible({ timeout: 5_000 })) {
      return {
        text: (await modal.textContent()) ?? "",
        html: await modal.evaluate((element) => element.outerHTML)
      }
    }
  } catch {
    // Fall back to body scan.
  }
  const bodyText = await page.locator("body").textContent({ timeout: 5_000 }).catch(() => "")
  if (bodyText !== null && /О магазине/i.test(bodyText)) {
    const bodyHtml = await page.locator("body").evaluate((element) => element.outerHTML).catch(() => "")
    return {
      text: bodyText,
      html: bodyHtml
    }
  }
  return null
}

const extractSellerIdFromUrl = (sellerUrl: string): string | null => {
  const matched = sellerUrl.match(/-(\d+)\/?$/)
  return matched?.[1] ?? null
}

const tryDirectSellerModal = async (input: {
  readonly page: Page
  readonly sellerUrl: string
  readonly timeoutMs: number
  readonly config: IndexerConfig
}): Promise<{ readonly fields: SellerAboutFields; readonly rawJson: string } | null> => {
  const sellerId = extractSellerIdFromUrl(input.sellerUrl)
  if (sellerId === null) {
    return null
  }
  const modalUrl = `https://www.ozon.ru/modal/shop-in-shop-info?seller_id=${encodeURIComponent(sellerId)}`
  const response = await input.page.goto(modalUrl, {
    waitUntil: "domcontentloaded",
    timeout: input.timeoutMs
  }).catch(() => null)
  if (response !== null && [403, 429, 451].includes(response.status())) {
    const reason = `ozon_modal_http_${response.status()}:${input.sellerUrl}`
    const artifacts = await savePageDiagnostics({
      config: input.config,
      page: input.page,
      label: `modal-${sellerKeyFromUrl(input.sellerUrl)}`,
      reason,
      source: "modal_page"
    })
    throw new OzonBlockError(reason, {
      blockSource: "modal_page",
      artifacts
    })
  }
  await input.page.waitForTimeout(1_000)
  const text = await input.page.locator("body").textContent({ timeout: 5_000 }).catch(() => "")
  const html = await input.page.locator("body").evaluate((element) => element.outerHTML).catch(() => "")
  const blockReason = detectBlockReason(`${text}\n${html}`, input.sellerUrl)
  if (blockReason !== null) {
    const artifacts = await savePageDiagnostics({
      config: input.config,
      page: input.page,
      label: `modal-${sellerKeyFromUrl(input.sellerUrl)}`,
      reason: blockReason,
      source: "modal_page"
    })
    throw new OzonBlockError(blockReason, {
      blockSource: "modal_page",
      artifacts
    })
  }
  const rawJson = JSON.stringify({
    source: "direct_modal",
    sellerUrl: input.sellerUrl,
    sellerId,
    modalUrl,
    text,
    html,
    capturedAt: nowIso()
  })
  return {
    fields: extractSellerAboutFieldsFromText({
      rawText: `${text}\n${html}`,
      rawJson,
      extractedAt: nowIso()
    }),
    rawJson
  }
}

export const extractSellerAboutWithPage = async (input: {
  readonly page: Page
  readonly sellerUrl: string
  readonly config: IndexerConfig
}): Promise<SellerAboutFields> => {
  const sellerUrl = toOzonComUrl(input.sellerUrl)
  const response = await input.page.goto(sellerUrl, {
    waitUntil: "domcontentloaded",
    timeout: input.config.navigationTimeoutMs
  }).catch((error: unknown) => {
    throw new Error(`seller_navigation_failed:${sellerUrl}:${toErrorMessage(error)}`)
  })
  if (response !== null && [403, 429, 451].includes(response.status())) {
    const reason = `ozon_seller_http_${response.status()}:${sellerUrl}`
    const artifacts = await savePageDiagnostics({
      config: input.config,
      page: input.page,
      label: `seller-${sellerKeyFromUrl(sellerUrl)}`,
      reason,
      source: "seller_page"
    })
    throw new OzonBlockError(reason, {
      blockSource: "seller_page",
      artifacts
    })
  }
  await input.page.waitForTimeout(1_500)
  const bodyText = await input.page.locator("body").textContent({ timeout: 5_000 }).catch(() => "")
  const blockReason = detectBlockReason(bodyText ?? "", sellerUrl)
  if (blockReason !== null) {
    const artifacts = await savePageDiagnostics({
      config: input.config,
      page: input.page,
      label: `seller-${sellerKeyFromUrl(sellerUrl)}`,
      reason: blockReason,
      source: "seller_page"
    })
    throw new OzonBlockError(blockReason, {
      blockSource: "seller_page",
      artifacts
    })
  }

  const clicked = await clickSellerShopPill(input.page)
  if (clicked) {
    await input.page.waitForTimeout(1_500)
  }
  const snapshot = await readAboutSnapshot(input.page)
  if (snapshot !== null) {
    const rawJson = JSON.stringify({
      source: "rendered_modal",
      sellerUrl,
      clicked,
      text: snapshot.text,
      html: snapshot.html,
      capturedAt: nowIso()
    })
    const extracted = extractSellerAboutFieldsFromText({
      rawText: `${snapshot.text}\n${snapshot.html}`,
      rawJson,
      extractedAt: nowIso()
    })
    if (extracted.sellerLegalIdentifier !== null || extracted.sellerLegalName !== null) {
      return extracted
    }
  }

  const directModal = await tryDirectSellerModal({
    page: input.page,
    sellerUrl,
    timeoutMs: input.config.navigationTimeoutMs,
    config: input.config
  })
  if (directModal !== null) {
    return directModal.fields
  }

  const rawJson = JSON.stringify({
    source: "seller_page_without_about",
    sellerUrl,
    clicked,
    text: bodyText,
    capturedAt: nowIso()
  })
  return extractSellerAboutFieldsFromText({
    rawText: bodyText ?? "",
    rawJson,
    extractedAt: nowIso()
  })
}
