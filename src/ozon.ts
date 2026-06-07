import { randomUUID } from "node:crypto"

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

export type SellerFeedPage = {
  readonly sellers: ReadonlyArray<SellerCandidate>
  readonly nextPagePath: string | null
}

const readRecord = (
  record: { readonly [key: string]: JsonValue },
  key: string
): { readonly [key: string]: JsonValue } | null => {
  const value = record[key]
  return isRecord(value) ? value : null
}

const readActionLink = (value: JsonValue): string | null => {
  if (!isRecord(value)) {
    return null
  }
  const link = value.link
  return typeof link === "string" && link.includes("/seller/") ? link : null
}

const readSellerFeedCardName = (record: { readonly [key: string]: JsonValue }): string | null => {
  const header = readRecord(record, "header")
  const title = header === null ? null : readRecord(header, "title")
  const titleText = title === null ? null : title.text
  return typeof titleText === "string" && normalizeWhitespace(titleText).length > 0
    ? normalizeWhitespace(titleText)
    : null
}

const readSellerFeedCardLink = (record: { readonly [key: string]: JsonValue }): string | null => {
  const topLevelActionLink = readActionLink(record.action)
  if (topLevelActionLink !== null) {
    return topLevelActionLink
  }
  const header = readRecord(record, "header")
  const badges = header?.badges
  if (!Array.isArray(badges)) {
    return null
  }
  for (const badge of badges) {
    if (!isRecord(badge)) {
      continue
    }
    const text = badge.text
    const common = readRecord(badge, "common")
    const actionLink = common === null ? null : readActionLink(common.action)
    if (typeof text === "string" && normalizeWhitespace(text).toLowerCase() === "магазин" && actionLink !== null) {
      return actionLink
    }
  }
  return null
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

export const extractSellerFeedPage = (json: JsonValue): SellerFeedPage => {
  const sellers = new Map<string, SellerCandidate>()
  walkJson(json, (item) => {
    if (!isRecord(item) || !isRecord(item.header)) {
      return
    }
    const sellerLink = readSellerFeedCardLink(item)
    if (sellerLink === null) {
      return
    }
    const sellerUrl = toOzonRuUrl(sellerLink)
    const sellerKey = sellerKeyFromUrl(sellerUrl)
    sellers.set(sellerKey, {
      sellerUrl,
      sellerKey,
      sellerName: readSellerFeedCardName(item)
    })
  })
  return {
    sellers: [...sellers.values()].sort((left, right) => left.sellerKey.localeCompare(right.sellerKey)),
    nextPagePath: extractNextPagePath(json)
  }
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

const buildEntrypointUrl = (origin: string, pagePath: string): string =>
  `${origin}/api/entrypoint-api.bx/page/json/v2?url=${encodeURIComponent(pagePath)}`

const chromeUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"

const ozonManifestVersion =
  "frontend-ozon-ru:df4078d8a985eacdeefede81fd777148f87be11b,checkout-render-api:2ca2f4f229fe231bf4550031f98439ea64df2346,search-render-api:a0eaad67467046d6f20c733080dc11799bb4694d,sf-render-api:274b716169ea6ae0439153df72feb1b430ec495d,fav-render-api:9d3f1045703d16b2af09e0441efcfc9818d31001"

const extractStartPageId = (pagePath: string): string | null => {
  const parsed = new URL(pagePath, "https://ozon.com")
  return parsed.searchParams.get("start_page_id")
}

export const redactCookieHeader = (cookie: string): string =>
  cookie
    .split(";")
    .map((part) => {
      const [rawName] = part.split("=")
      const name = rawName.trim()
      return name.length === 0 ? null : `${name}=<redacted>`
    })
    .filter((part): part is string => part !== null)
    .join("; ")

const entrypointHeaders = (input: {
  readonly config: IndexerConfig
  readonly pagePath: string
  readonly referer: string
  readonly pagePrevious: string
}): Record<string, string> => {
  const parentRequestId = extractStartPageId(input.pagePath)
  const headers: Record<string, string> = {
    accept: "application/json",
    "accept-language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
    "content-type": "application/json",
    priority: "u=1, i",
    referer: input.referer,
    "sec-ch-ua": '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": chromeUserAgent,
    "x-o3-app-name": "dweb_client",
    "x-o3-app-version": "release_5-5-2026_df4078d8",
    "x-o3-manifest-version": ozonManifestVersion,
    "x-page-previous": input.pagePrevious,
    "x-page-view-id": randomUUID()
  }
  if (parentRequestId !== null) {
    headers["x-o3-parent-requestid"] = parentRequestId
  }
  if (input.config.ozonCookie !== null) {
    headers.cookie = input.config.ozonCookie
  }
  return headers
}

const redactHeaderValue = (name: string, value: string): string => {
  const lowerName = name.toLowerCase()
  if (lowerName === "cookie" || lowerName === "set-cookie") {
    return redactCookieHeader(value)
  }
  if (lowerName.includes("token") || lowerName === "authorization") {
    return "<redacted>"
  }
  return value
}

const redactHeaders = (headers: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, redactHeaderValue(name, value)]))

const sanitizeDiagnosticText = (text: string): string =>
  text
    .replaceAll(/((?:__Secure-[A-Za-z0-9_-]+|abt_data|access_token|refresh_token|access-token|refresh-token)=)[^;\s"']+/gi, "$1<redacted>")
    .replaceAll(/("(?:userToken|pageToken|requestID|accessToken|refreshToken)"\s*:\s*")[^"]+(")/gi, "$1<redacted>$2")
    .replaceAll(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1<redacted>")

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

const saveRequestDiagnostics = async (input: {
  readonly config: IndexerConfig
  readonly label: string
  readonly reason: string
  readonly requestUrl: string
  readonly pagePath: string
  readonly status: number
  readonly requestHeaders: Record<string, string>
  readonly responseHeaders: Record<string, string>
  readonly body: string
}): Promise<ReadonlyArray<string>> => {
  const capturedAt = nowIso()
  const baseName = `${capturedAt.replaceAll(/[^0-9]/g, "").slice(0, 14)}-${safeId(input.label).slice(0, 80)}`
  const bodyPreview = sanitizeDiagnosticText(input.body.slice(0, 20_000))
  const bodyPreviewPath = await writeTextArtifact(input.config, `diagnostics/${baseName}.txt`, bodyPreview)
  const metadata = {
    capturedAt,
    label: input.label,
    reason: input.reason,
    source: "request_context",
    requestUrl: input.requestUrl,
    pagePath: input.pagePath,
    status: input.status,
    requestHeaders: redactHeaders(input.requestHeaders),
    responseHeaders: redactHeaders(input.responseHeaders),
    bodyLength: input.body.length,
    bodyPreviewPath,
    bodyPreview: bodyPreview.slice(0, 2_000)
  }
  const metadataPath = await writeTextArtifact(
    input.config,
    `diagnostics/${baseName}.json`,
    JSON.stringify(metadata, null, 2)
  )
  return [bodyPreviewPath, metadataPath]
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
    userAgent: chromeUserAgent,
    viewport: {
      width: 1365,
      height: 900
    },
    ignoreHTTPSErrors: true,
    javaScriptEnabled: true
  })

export const fetchEntrypointJson = async (input: {
  readonly context: BrowserContext
  readonly config: IndexerConfig
  readonly pagePath: string
  readonly referer?: string
  readonly pagePrevious?: string
  readonly timeoutMs: number
}): Promise<JsonValue> => {
  const requestUrl = buildEntrypointUrl(input.config.ozonApiOrigin, input.pagePath)
  const requestHeaders = entrypointHeaders({
    config: input.config,
    pagePath: input.pagePath,
    referer: input.referer ?? `${input.config.ozonApiOrigin}/`,
    pagePrevious: input.pagePrevious ?? "unknown"
  })
  const response = await input.context.request.get(requestUrl, {
    maxRedirects: 3,
    timeout: input.timeoutMs,
    headers: requestHeaders
  })
  const status = response.status()
  const text = await response.text()
  const redirectLocation = response.headers().location ?? ""
  const throwWithRequestDiagnostics = async (reason: string): Promise<never> => {
    const artifacts = await saveRequestDiagnostics({
      config: input.config,
      label: `request-${input.pagePath}`,
      reason,
      requestUrl,
      pagePath: input.pagePath,
      status,
      requestHeaders,
      responseHeaders: response.headers(),
      body: text
    })
    throw new OzonBlockError(reason, {
      blockSource: "request_context",
      artifacts
    })
  }
  if (status >= 300 && status < 400 && redirectLocation.includes("__rr=")) {
    await throwWithRequestDiagnostics(`ozon_redirect_loop:${input.pagePath}`)
  }
  if (status === 403 || status === 429 || status === 451) {
    await throwWithRequestDiagnostics(`ozon_http_${status}:${input.pagePath}`)
  }
  const textBlockReason = detectBlockReason(text, input.pagePath)
  if (textBlockReason !== null) {
    await throwWithRequestDiagnostics(textBlockReason)
  }
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
