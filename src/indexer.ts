import type { BrowserContext, Page } from "playwright"

import {
  createPendingSellerRecord,
  createProductRecord,
  ensureOutputDirectories,
  loadState,
  readSellerRecord,
  saveState,
  writeCategoryPageRecord,
  writeProductRecord,
  writeReport,
  writeSellerRecord
} from "./storage.js"
import { DelayGate, hasTimeForMoreWork } from "./rateLimit.js"
import {
  extractNextPagePath,
  extractProductUrls,
  extractSellerAboutWithPage,
  extractSellerCandidates,
  fetchEntrypointJson,
  openBrowser,
  openContext,
  OzonBlockError
} from "./ozon.js"
import type {
  CategoryState,
  IndexerConfig,
  IndexerState,
  JsonValue,
  ProductQueueItem,
  RunReport,
  SellerQueueItem
} from "./types.js"
import {
  nowIso,
  pagePathFromUrl,
  productKeyFromUrl,
  sellerKeyFromUrl,
  sha1,
  toErrorMessage,
  toOzonRuUrl,
  uniquePush
} from "./utils.js"

type RunCounters = {
  pagesProcessed: number
  productsProcessed: number
  sellersProcessed: number
}

type WorkerContext = {
  readonly config: IndexerConfig
  readonly state: IndexerState
  readonly browserContext: BrowserContext
  readonly delayGate: DelayGate
  readonly startedAtMs: number
  readonly runCounters: RunCounters
  blocked: boolean
  stopReason: string
}

const log = (event: string, payload: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ ts: nowIso(), event, ...payload }))
}

const setBlocked = async (ctx: WorkerContext, reason: string): Promise<void> => {
  if (ctx.blocked) {
    return
  }
  ctx.blocked = true
  ctx.stopReason = "ozon_blocked"
  const blockedUntil = new Date(Date.now() + ctx.config.blockCooldownMs).toISOString()
  ctx.state.blockReason = reason
  ctx.state.blockedUntil = blockedUntil
  ctx.state.stats.blocksDetected += 1
  log("ozon_blocked", { reason, blockedUntil })
  await saveState(ctx.config, ctx.state)
}

const waitForExistingCooldown = async (
  config: IndexerConfig,
  state: IndexerState,
  startedAtMs: number
): Promise<boolean> => {
  if (state.blockedUntil === null) {
    return false
  }
  const blockedUntilMs = Date.parse(state.blockedUntil)
  if (!Number.isFinite(blockedUntilMs) || blockedUntilMs <= Date.now()) {
    state.blockReason = null
    state.blockedUntil = null
    await saveState(config, state)
    return false
  }
  const remainingRunMs = config.durationMinutes * 60_000 - (Date.now() - startedAtMs) - 20_000
  const waitMs = Math.min(Math.max(0, remainingRunMs), blockedUntilMs - Date.now())
  if (waitMs <= 0) {
    return true
  }
  log("cooldown_wait_started", { blockedUntil: state.blockedUntil, waitMs })
  await new Promise((resolve) => setTimeout(resolve, waitMs))
  if (Date.now() >= blockedUntilMs) {
    state.blockReason = null
    state.blockedUntil = null
    await saveState(config, state)
    return false
  }
  return true
}

const canContinue = (ctx: WorkerContext): boolean =>
  !ctx.blocked && hasTimeForMoreWork(ctx.startedAtMs, ctx.config.durationMinutes)

const pickCategory = (state: IndexerState): CategoryState | null => {
  const category = state.categories.find((candidate) =>
    candidate.status !== "done" && candidate.status !== "blocked" && candidate.nextPagePath !== null
  )
  return category ?? null
}

const normalizeNextPagePath = (rawPath: string | null, categoryUrl: string): string | null => {
  if (rawPath === null || rawPath.trim().length === 0) {
    return null
  }
  try {
    return pagePathFromUrl(rawPath)
  } catch {
    try {
      return pagePathFromUrl(new URL(rawPath, categoryUrl).toString())
    } catch {
      return null
    }
  }
}

const addPendingProduct = (state: IndexerState, productUrl: string, categoryId: string): boolean => {
  const normalizedUrl = toOzonRuUrl(productUrl)
  if (state.seenProductUrls.includes(normalizedUrl)) {
    return false
  }
  state.seenProductUrls.push(normalizedUrl)
  state.pendingProducts.push({
    productUrl: normalizedUrl,
    categoryId,
    discoveredAt: nowIso()
  })
  state.stats.productsDiscovered += 1
  return true
}

const addPendingSeller = async (
  config: IndexerConfig,
  state: IndexerState,
  item: SellerQueueItem
): Promise<boolean> => {
  const normalizedUrl = toOzonRuUrl(item.sellerUrl)
  const sellerKey = sellerKeyFromUrl(normalizedUrl)
  if (state.seenSellerKeys.includes(sellerKey)) {
    return false
  }
  state.seenSellerKeys.push(sellerKey)
  state.pendingSellers.push({
    ...item,
    sellerUrl: normalizedUrl,
    sellerKey
  })
  state.stats.sellersDiscovered += 1
  const existing = await readSellerRecord(config, sellerKey)
  if (existing === null) {
    await writeSellerRecord(
      config,
      createPendingSellerRecord({
        sellerUrl: normalizedUrl,
        sellerName: item.sellerName,
        sourceUrl: item.sourceUrl,
        now: item.discoveredAt
      })
    )
  }
  return true
}

const categoryWorker = async (ctx: WorkerContext, workerId: number): Promise<void> => {
  while (canContinue(ctx) && ctx.runCounters.pagesProcessed < ctx.config.maxPagesPerRun) {
    const category = pickCategory(ctx.state)
    if (category === null) {
      return
    }
    category.status = "running"
    const pageToken = category.nextPagePath
    if (pageToken === null) {
      category.status = "done"
      continue
    }
    try {
      await ctx.delayGate.wait(`category:${category.id}`)
      log("category_page_started", { workerId, categoryId: category.id, pageToken })
      const json = await fetchEntrypointJson({
        context: ctx.browserContext,
        pagePath: pageToken,
        timeoutMs: ctx.config.navigationTimeoutMs
      })
      const productUrls = extractProductUrls(json)
      const sellerCandidates = extractSellerCandidates(json)
      let newProducts = 0
      let newSellers = 0
      for (const productUrl of productUrls) {
        if (addPendingProduct(ctx.state, productUrl, category.id)) {
          newProducts += 1
        }
      }
      for (const seller of sellerCandidates) {
        const added = await addPendingSeller(ctx.config, ctx.state, {
          sellerUrl: seller.sellerUrl,
          sellerKey: seller.sellerKey,
          sellerName: seller.sellerName,
          sourceUrl: category.url,
          discoveredAt: nowIso()
        })
        if (added) {
          newSellers += 1
        }
      }
      const nextPagePath = normalizeNextPagePath(extractNextPagePath(json), category.url)
      await writeCategoryPageRecord(ctx.config, category.id, pageToken, {
        categoryId: category.id,
        categoryTitle: category.title,
        categoryUrl: category.url,
        pageToken,
        nextPageToken: nextPagePath,
        productUrls,
        sellerUrls: sellerCandidates.map((seller) => seller.sellerUrl),
        capturedAt: nowIso()
      } satisfies JsonValue)
      category.lastPageToken = pageToken
      category.nextPagePath = nextPagePath
      category.pagesVisited += 1
      category.status = nextPagePath === null ? "done" : "pending"
      category.updatedAt = nowIso()
      ctx.runCounters.pagesProcessed += 1
      ctx.state.stats.categoryPagesVisited += 1
      log("category_page_completed", {
        workerId,
        categoryId: category.id,
        products: productUrls.length,
        newProducts,
        sellers: sellerCandidates.length,
        newSellers,
        hasNextPage: nextPagePath !== null
      })
      await saveState(ctx.config, ctx.state)
    } catch (error) {
      category.status = "pending"
      category.updatedAt = nowIso()
      ctx.state.stats.categoryPagesFailed += 1
      if (error instanceof OzonBlockError) {
        await setBlocked(ctx, error.message)
        return
      }
      log("category_page_failed", { workerId, categoryId: category.id, reason: toErrorMessage(error) })
      await saveState(ctx.config, ctx.state)
    }
  }
}

const productWorker = async (ctx: WorkerContext, workerId: number): Promise<void> => {
  while (canContinue(ctx) && ctx.runCounters.productsProcessed < ctx.config.maxProductsPerRun) {
    const item = ctx.state.pendingProducts.shift()
    if (item === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      if (ctx.state.pendingProducts.length === 0 && pickCategory(ctx.state) === null) {
        return
      }
      continue
    }
    await processProduct(ctx, workerId, item)
  }
}

const processProduct = async (ctx: WorkerContext, workerId: number, item: ProductQueueItem): Promise<void> => {
  const firstSeenAt = item.discoveredAt
  try {
    await ctx.delayGate.wait(`product:${productKeyFromUrl(item.productUrl)}`)
    log("product_started", { workerId, productUrl: item.productUrl })
    const json = await fetchEntrypointJson({
      context: ctx.browserContext,
      pagePath: pagePathFromUrl(item.productUrl),
      timeoutMs: ctx.config.navigationTimeoutMs
    })
    const sellers = extractSellerCandidates(json)
    const seller = sellers[0] ?? null
    if (seller !== null) {
      await addPendingSeller(ctx.config, ctx.state, {
        sellerUrl: seller.sellerUrl,
        sellerKey: seller.sellerKey,
        sellerName: seller.sellerName,
        sourceUrl: item.productUrl,
        discoveredAt: nowIso()
      })
    }
    await writeProductRecord(
      ctx.config,
      createProductRecord({
        productUrl: item.productUrl,
        categoryId: item.categoryId,
        status: seller === null ? "seller_missing" : "seller_extracted",
        sellerUrl: seller?.sellerUrl ?? null,
        sellerName: seller?.sellerName ?? null,
        firstSeenAt,
        lastError: null
      })
    )
    ctx.runCounters.productsProcessed += 1
    ctx.state.stats.productsProcessed += 1
    log("product_completed", { workerId, productUrl: item.productUrl, sellerUrl: seller?.sellerUrl ?? null })
    await saveState(ctx.config, ctx.state)
  } catch (error) {
    if (error instanceof OzonBlockError) {
      ctx.state.pendingProducts.unshift(item)
      await setBlocked(ctx, error.message)
      return
    }
    ctx.state.stats.productsFailed += 1
    await writeProductRecord(
      ctx.config,
      createProductRecord({
        productUrl: item.productUrl,
        categoryId: item.categoryId,
        status: "failed",
        sellerUrl: null,
        sellerName: null,
        firstSeenAt,
        lastError: toErrorMessage(error)
      })
    )
    log("product_failed", { workerId, productUrl: item.productUrl, reason: toErrorMessage(error) })
    await saveState(ctx.config, ctx.state)
  }
}

const sellerWorker = async (ctx: WorkerContext, workerId: number): Promise<void> => {
  const page = await ctx.browserContext.newPage()
  try {
    while (canContinue(ctx) && ctx.runCounters.sellersProcessed < ctx.config.maxSellersPerRun) {
      const item = ctx.state.pendingSellers.shift()
      if (item === undefined) {
        await page.waitForTimeout(500)
        if (ctx.state.pendingSellers.length === 0 && ctx.state.pendingProducts.length === 0 && pickCategory(ctx.state) === null) {
          return
        }
        continue
      }
      await processSeller(ctx, page, workerId, item)
    }
  } finally {
    await page.close().catch(() => undefined)
  }
}

const processSeller = async (
  ctx: WorkerContext,
  page: Page,
  workerId: number,
  item: SellerQueueItem
): Promise<void> => {
  const existing = await readSellerRecord(ctx.config, item.sellerKey)
  if (existing !== null && existing.status === "legal_extracted") {
    ctx.runCounters.sellersProcessed += 1
    return
  }
  try {
    await ctx.delayGate.wait(`seller:${item.sellerKey}`)
    log("seller_started", { workerId, sellerUrl: item.sellerUrl })
    const fields = await extractSellerAboutWithPage({
      page,
      sellerUrl: item.sellerUrl,
      config: ctx.config
    })
    const now = nowIso()
    const hasLegal = fields.sellerLegalIdentifier !== null || fields.sellerLegalName !== null
    await writeSellerRecord(ctx.config, {
      ...(existing ?? {
        sellerKey: item.sellerKey,
        sellerUrl: item.sellerUrl,
        sellerName: item.sellerName,
        sourceUrl: item.sourceUrl,
        firstSeenAt: item.discoveredAt,
        attempts: 0
      }),
      ...fields,
      sellerKey: item.sellerKey,
      sellerUrl: item.sellerUrl,
      sellerName: existing?.sellerName ?? item.sellerName,
      sourceUrl: existing?.sourceUrl ?? item.sourceUrl,
      attempts: (existing?.attempts ?? 0) + 1,
      firstSeenAt: existing?.firstSeenAt ?? item.discoveredAt,
      updatedAt: now,
      lastError: null,
      status: hasLegal ? "legal_extracted" : "legal_missing"
    })
    ctx.runCounters.sellersProcessed += 1
    ctx.state.stats.sellersProcessed += 1
    if (hasLegal) {
      ctx.state.stats.sellersWithLegalDetails += 1
    } else {
      ctx.state.stats.sellersWithoutLegalDetails += 1
    }
    log("seller_completed", {
      workerId,
      sellerUrl: item.sellerUrl,
      legalIdentifier: fields.sellerLegalIdentifier,
      legalName: fields.sellerLegalName
    })
    await saveState(ctx.config, ctx.state)
  } catch (error) {
    if (error instanceof OzonBlockError) {
      ctx.state.pendingSellers.unshift(item)
      await setBlocked(ctx, error.message)
      return
    }
    const now = nowIso()
    await writeSellerRecord(ctx.config, {
      ...(existing ?? createPendingSellerRecordForFailure(item)),
      sellerKey: item.sellerKey,
      sellerUrl: item.sellerUrl,
      sellerName: existing?.sellerName ?? item.sellerName,
      sourceUrl: existing?.sourceUrl ?? item.sourceUrl,
      attempts: (existing?.attempts ?? 0) + 1,
      updatedAt: now,
      lastError: toErrorMessage(error),
      status: "failed"
    })
    ctx.state.stats.sellersFailed += 1
    log("seller_failed", { workerId, sellerUrl: item.sellerUrl, reason: toErrorMessage(error) })
    await saveState(ctx.config, ctx.state)
  }
}

const createPendingSellerRecordForFailure = (item: SellerQueueItem) => ({
  sellerKey: item.sellerKey,
  sellerUrl: item.sellerUrl,
  sellerName: item.sellerName,
  sourceUrl: item.sourceUrl,
  attempts: 0,
  firstSeenAt: item.discoveredAt,
  updatedAt: item.discoveredAt,
  lastError: null,
  status: "pending" as const,
  sellerLegalName: null,
  sellerLegalPersonName: null,
  sellerLegalIdentifier: null,
  sellerLegalIdentifierType: null,
  sellerAboutText: null,
  sellerAboutRawJson: null,
  sellerAboutExtractedAt: null
})

const runPool = async (count: number, run: (workerId: number) => Promise<void>): Promise<void> => {
  const workers = Array.from({ length: count }, (_, index) => run(index + 1))
  await Promise.all(workers)
}

const hasUnfinishedWork = (state: IndexerState): boolean =>
  state.pendingProducts.length > 0 ||
  state.pendingSellers.length > 0 ||
  state.categories.some((category) => category.status !== "done" && category.nextPagePath !== null)

const buildReport = (input: {
  readonly config: IndexerConfig
  readonly state: IndexerState
  readonly startedAt: string
  readonly startedAtMs: number
  readonly stopReason: string
}): RunReport => {
  const finishedAt = nowIso()
  const unfinishedCategories = input.state.categories.filter((category) =>
    category.status !== "done" && category.nextPagePath !== null
  ).length
  return {
    runId: `${input.startedAt.replaceAll(/[^0-9]/g, "").slice(0, 14)}-${sha1(finishedAt).slice(0, 8)}`,
    startedAt: input.startedAt,
    finishedAt,
    durationMs: Date.now() - input.startedAtMs,
    shouldContinue: hasUnfinishedWork(input.state),
    stopReason: input.stopReason,
    blockReason: input.state.blockReason,
    blockedUntil: input.state.blockedUntil,
    stats: input.state.stats,
    queue: {
      pendingProducts: input.state.pendingProducts.length,
      pendingSellers: input.state.pendingSellers.length,
      unfinishedCategories
    }
  }
}

export const runTimedIndexer = async (config: IndexerConfig): Promise<RunReport> => {
  await ensureOutputDirectories(config)
  const state = await loadState(config)
  const startedAt = nowIso()
  const startedAtMs = Date.now()
  const runCounters: RunCounters = {
    pagesProcessed: 0,
    productsProcessed: 0,
    sellersProcessed: 0
  }
  let stopReason = "time_budget_exhausted"
  const stillCoolingDown = await waitForExistingCooldown(config, state, startedAtMs)
  if (stillCoolingDown) {
    const report = buildReport({
      config,
      state,
      startedAt,
      startedAtMs,
      stopReason: "cooldown_wait_budget_exhausted"
    })
    await writeReport(config, report)
    log("indexer_finished", report as unknown as Record<string, unknown>)
    return report
  }
  const browser = await openBrowser(config)
  try {
    const browserContext = await openContext(browser, config)
    const workerContext: WorkerContext = {
      config,
      state,
      browserContext,
      delayGate: new DelayGate(config),
      startedAtMs,
      runCounters,
      blocked: false,
      stopReason
    }
    log("indexer_started", {
      durationMinutes: config.durationMinutes,
      categoryWorkers: config.maxCategoryWorkers,
      productWorkers: config.maxProductWorkers,
      sellerWorkers: config.maxSellerWorkers
    })
    await Promise.all([
      runPool(config.maxCategoryWorkers, (workerId) => categoryWorker(workerContext, workerId)),
      runPool(config.maxProductWorkers, (workerId) => productWorker(workerContext, workerId)),
      runPool(config.maxSellerWorkers, (workerId) => sellerWorker(workerContext, workerId))
    ])
    stopReason = workerContext.stopReason === "time_budget_exhausted" && !hasUnfinishedWork(state)
      ? "completed"
      : workerContext.stopReason
    await browserContext.close().catch(() => undefined)
  } finally {
    await browser.close().catch(() => undefined)
  }
  const report = buildReport({
    config,
    state,
    startedAt,
    startedAtMs,
    stopReason
  })
  await saveState(config, state)
  await writeReport(config, report)
  log("indexer_finished", report as unknown as Record<string, unknown>)
  return report
}
