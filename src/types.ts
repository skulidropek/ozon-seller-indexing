export type JsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue }

export type LegalIdentifierType = "inn" | "ogrn" | "ogrnip" | "unknown"

export type SellerAboutFields = {
  readonly sellerLegalName: string | null
  readonly sellerLegalPersonName: string | null
  readonly sellerLegalIdentifier: string | null
  readonly sellerLegalIdentifierType: LegalIdentifierType | null
  readonly sellerAboutText: string | null
  readonly sellerAboutRawJson: string | null
  readonly sellerAboutExtractedAt: string | null
}

export type CategorySeed = {
  readonly id: string
  readonly title: string
  readonly url: string
}

export type CategoryState = CategorySeed & {
  status: "pending" | "running" | "done" | "blocked"
  nextPagePath: string | null
  lastPageToken: string | null
  pagesVisited: number
  updatedAt: string
}

export type ProductQueueItem = {
  readonly productUrl: string
  readonly categoryId: string
  readonly discoveredAt: string
}

export type SellerQueueItem = {
  readonly sellerUrl: string
  readonly sellerKey: string
  readonly sellerName: string | null
  readonly sourceUrl: string | null
  readonly discoveredAt: string
}

export type IndexerStats = {
  categoryPagesVisited: number
  categoryPagesFailed: number
  productsDiscovered: number
  productsProcessed: number
  productsFailed: number
  sellersDiscovered: number
  sellersProcessed: number
  sellersWithLegalDetails: number
  sellersWithoutLegalDetails: number
  sellersFailed: number
  blocksDetected: number
}

export type IndexerState = {
  readonly version: 1
  readonly createdAt: string
  updatedAt: string
  categories: Array<CategoryState>
  pendingProducts: Array<ProductQueueItem>
  pendingSellers: Array<SellerQueueItem>
  seenProductUrls: Array<string>
  seenSellerKeys: Array<string>
  blockReason: string | null
  blockedUntil: string | null
  stats: IndexerStats
}

export type SellerRecord = SellerAboutFields & {
  readonly sellerKey: string
  readonly sellerUrl: string
  readonly sellerName: string | null
  readonly status: "pending" | "legal_extracted" | "legal_missing" | "failed"
  readonly sourceUrl: string | null
  readonly attempts: number
  readonly firstSeenAt: string
  readonly updatedAt: string
  readonly lastError: string | null
}

export type ProductRecord = {
  readonly productKey: string
  readonly productUrl: string
  readonly categoryId: string
  readonly status: "seller_extracted" | "seller_missing" | "failed"
  readonly sellerUrl: string | null
  readonly sellerName: string | null
  readonly firstSeenAt: string
  readonly updatedAt: string
  readonly lastError: string | null
}

export type RunReport = {
  readonly runId: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly durationMs: number
  readonly shouldContinue: boolean
  readonly stopReason: string
  readonly blockReason: string | null
  readonly blockedUntil: string | null
  readonly stats: IndexerStats
  readonly queue: {
    readonly pendingProducts: number
    readonly pendingSellers: number
    readonly unfinishedCategories: number
  }
}

export type IndexerConfig = {
  readonly dataDirectory: string
  readonly stateFile: string
  readonly reportsDirectory: string
  readonly durationMinutes: number
  readonly maxCategoryWorkers: number
  readonly maxProductWorkers: number
  readonly maxSellerWorkers: number
  readonly maxPagesPerRun: number
  readonly maxProductsPerRun: number
  readonly maxSellersPerRun: number
  readonly minActionDelayMs: number
  readonly maxActionDelayMs: number
  readonly blockCooldownMs: number
  readonly navigationTimeoutMs: number
  readonly headless: boolean
  readonly categories: ReadonlyArray<CategorySeed>
  readonly seedSellerUrls: ReadonlyArray<string>
}
