import fs from "node:fs/promises"
import path from "node:path"

import type {
  CategorySeed,
  CategoryState,
  IndexerConfig,
  IndexerState,
  IndexerStats,
  JsonValue,
  ProductRecord,
  RunReport,
  SellerRecord
} from "./types.js"
import { nowIso, productKeyFromUrl, sellerKeyFromUrl, sha1, shardPath, toOzonRuUrl } from "./utils.js"

const emptyStats = (): IndexerStats => ({
  categoryPagesVisited: 0,
  categoryPagesFailed: 0,
  productsDiscovered: 0,
  productsProcessed: 0,
  productsFailed: 0,
  sellersDiscovered: 0,
  sellersProcessed: 0,
  sellersWithLegalDetails: 0,
  sellersWithoutLegalDetails: 0,
  sellersFailed: 0,
  blocksDetected: 0
})

const toInitialCategoryState = (category: CategorySeed, createdAt: string): CategoryState => {
  const parsed = new URL(category.url)
  return {
    ...category,
    status: "pending",
    nextPagePath: `${parsed.pathname}${parsed.search}`,
    lastPageToken: null,
    pagesVisited: 0,
    updatedAt: createdAt
  }
}

const createInitialState = (categories: ReadonlyArray<CategorySeed>): IndexerState => {
  const createdAt = nowIso()
  return {
    version: 1,
    createdAt,
    updatedAt: createdAt,
    categories: categories.map((category) => toInitialCategoryState(category, createdAt)),
    pendingProducts: [],
    pendingSellers: [],
    seenProductUrls: [],
    seenSellerKeys: [],
    blockReason: null,
    blockedUntil: null,
    stats: emptyStats()
  }
}

const readTextIfExists = async (filePath: string): Promise<string | null> => {
  try {
    return await fs.readFile(filePath, "utf8")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null
    }
    throw error
  }
}

export const readJsonFile = async <T>(filePath: string): Promise<T | null> => {
  const text = await readTextIfExists(filePath)
  if (text === null) {
    return null
  }
  return JSON.parse(text) as T
}

export const writeJsonFile = async (filePath: string, value: unknown): Promise<void> => {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  await fs.rename(tempPath, filePath)
}

export const loadState = async (config: IndexerConfig): Promise<IndexerState> => {
  const existing = await readJsonFile<IndexerState>(config.stateFile)
  const state = existing ?? createInitialState(config.categories)
  const categoryIds = new Set(state.categories.map((category) => category.id))
  const createdAt = state.createdAt
  for (const category of config.categories) {
    if (!categoryIds.has(category.id)) {
      state.categories.push(toInitialCategoryState(category, createdAt))
    }
  }
  for (const sellerUrl of config.seedSellerUrls) {
    const normalizedUrl = toOzonRuUrl(sellerUrl)
    const sellerKey = sellerKeyFromUrl(normalizedUrl)
    if (!state.seenSellerKeys.includes(sellerKey)) {
      const discoveredAt = nowIso()
      state.seenSellerKeys.push(sellerKey)
      state.pendingSellers.push({
        sellerUrl: normalizedUrl,
        sellerKey,
        sellerName: null,
        sourceUrl: "seed",
        discoveredAt
      })
      state.stats.sellersDiscovered += 1
    }
  }
  state.updatedAt = nowIso()
  return state
}

export const saveState = async (config: IndexerConfig, state: IndexerState): Promise<void> => {
  state.updatedAt = nowIso()
  await writeJsonFile(config.stateFile, state)
}

export const ensureOutputDirectories = async (config: IndexerConfig): Promise<void> => {
  await Promise.all([
    fs.mkdir(config.dataDirectory, { recursive: true }),
    fs.mkdir(path.dirname(config.stateFile), { recursive: true }),
    fs.mkdir(path.join(config.reportsDirectory, "runs"), { recursive: true })
  ])
}

export const categoryPagePath = (config: IndexerConfig, categoryId: string, pageToken: string): string =>
  path.join(config.dataDirectory, "category-pages", categoryId, `${sha1(pageToken)}.json`)

export const productRecordPath = (config: IndexerConfig, productUrl: string): string => {
  const key = productKeyFromUrl(productUrl)
  return path.join(config.dataDirectory, "products", shardPath(key), `${key}.json`)
}

export const sellerRecordPath = (config: IndexerConfig, sellerKey: string): string =>
  path.join(config.dataDirectory, "sellers", shardPath(sellerKey), `${sellerKey}.json`)

export const readSellerRecord = async (
  config: IndexerConfig,
  sellerKey: string
): Promise<SellerRecord | null> => readJsonFile<SellerRecord>(sellerRecordPath(config, sellerKey))

export const writeSellerRecord = async (config: IndexerConfig, record: SellerRecord): Promise<void> => {
  await writeJsonFile(sellerRecordPath(config, record.sellerKey), record)
}

export const writeProductRecord = async (config: IndexerConfig, record: ProductRecord): Promise<void> => {
  await writeJsonFile(productRecordPath(config, record.productUrl), record)
}

export const writeCategoryPageRecord = async (
  config: IndexerConfig,
  categoryId: string,
  pageToken: string,
  record: JsonValue
): Promise<void> => {
  await writeJsonFile(categoryPagePath(config, categoryId, pageToken), record)
}

export const writeReport = async (config: IndexerConfig, report: RunReport): Promise<void> => {
  await Promise.all([
    writeJsonFile(path.join(config.reportsDirectory, "latest-run.json"), report),
    writeJsonFile(path.join(config.reportsDirectory, "runs", `${report.runId}.json`), report)
  ])
}

export const createPendingSellerRecord = (input: {
  readonly sellerUrl: string
  readonly sellerName: string | null
  readonly sourceUrl: string | null
  readonly now: string
}): SellerRecord => ({
  sellerKey: sellerKeyFromUrl(input.sellerUrl),
  sellerUrl: input.sellerUrl,
  sellerName: input.sellerName,
  status: "pending",
  sourceUrl: input.sourceUrl,
  attempts: 0,
  firstSeenAt: input.now,
  updatedAt: input.now,
  lastError: null,
  sellerLegalName: null,
  sellerLegalPersonName: null,
  sellerLegalIdentifier: null,
  sellerLegalIdentifierType: null,
  sellerAboutText: null,
  sellerAboutRawJson: null,
  sellerAboutExtractedAt: null
})

export const createProductRecord = (input: {
  readonly productUrl: string
  readonly categoryId: string
  readonly status: ProductRecord["status"]
  readonly sellerUrl: string | null
  readonly sellerName: string | null
  readonly firstSeenAt: string
  readonly lastError: string | null
}): ProductRecord => ({
  productKey: productKeyFromUrl(input.productUrl),
  productUrl: input.productUrl,
  categoryId: input.categoryId,
  status: input.status,
  sellerUrl: input.sellerUrl,
  sellerName: input.sellerName,
  firstSeenAt: input.firstSeenAt,
  updatedAt: nowIso(),
  lastError: input.lastError
})
