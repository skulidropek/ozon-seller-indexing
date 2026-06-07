import type { CategorySeed, DiscoveryMode, IndexerConfig } from "./types.js"

const categoryOrigin = "https://www.ozon.ru"

const buildSearchCategory = (title: string): string =>
  `${categoryOrigin}/search/?text=${encodeURIComponent(title)}&sorting=rating`

export const defaultCategories: ReadonlyArray<CategorySeed> = [
  {
    id: "electronics",
    title: "Электроника",
    url: "https://www.ozon.ru/category/electronics-15500/?sorting=rating"
  },
  { id: "clothes", title: "Одежда", url: buildSearchCategory("Одежда") },
  { id: "shoes", title: "Обувь", url: buildSearchCategory("Обувь") },
  { id: "home_garden", title: "Дом и сад", url: buildSearchCategory("Дом и сад") },
  { id: "kids", title: "Детские товары", url: buildSearchCategory("Детские товары") },
  { id: "beauty", title: "Красота и здоровье", url: buildSearchCategory("Красота и здоровье") },
  { id: "home_appliances", title: "Бытовая техника", url: buildSearchCategory("Бытовая техника") },
  { id: "sport", title: "Спорт и отдых", url: buildSearchCategory("Спорт и отдых") },
  { id: "repair", title: "Строительство и ремонт", url: buildSearchCategory("Строительство и ремонт") },
  { id: "food", title: "Продукты питания", url: buildSearchCategory("Продукты питания") },
  { id: "pharmacy", title: "Аптека", url: buildSearchCategory("Аптека") },
  { id: "pets", title: "Товары для животных", url: buildSearchCategory("Товары для животных") },
  { id: "books", title: "Книги", url: buildSearchCategory("Книги") },
  { id: "tourism", title: "Туризм, рыбалка, охота", url: buildSearchCategory("Туризм рыбалка охота") },
  { id: "auto_goods", title: "Автотовары", url: buildSearchCategory("Автотовары") },
  { id: "furniture", title: "Мебель", url: buildSearchCategory("Мебель") },
  { id: "hobby", title: "Хобби и творчество", url: buildSearchCategory("Хобби и творчество") },
  { id: "accessories", title: "Аксессуары", url: buildSearchCategory("Аксессуары") },
  { id: "jewelry", title: "Ювелирные украшения", url: buildSearchCategory("Ювелирные украшения") },
  { id: "music_video", title: "Музыка и видео", url: buildSearchCategory("Музыка видео") },
  { id: "office", title: "Канцелярские товары", url: buildSearchCategory("Канцелярские товары") },
  { id: "adult", title: "Товары для взрослых", url: buildSearchCategory("Товары для взрослых") },
  { id: "antiques", title: "Антиквариат и коллекционирование", url: buildSearchCategory("Антиквариат") },
  { id: "digital", title: "Цифровые товары", url: buildSearchCategory("Цифровые товары") },
  { id: "chemistry", title: "Бытовая химия и гигиена", url: buildSearchCategory("Бытовая химия") },
  { id: "games", title: "Игры и консоли", url: buildSearchCategory("Игры и консоли") },
  { id: "smoking", title: "Товары для курения и аксессуары", url: buildSearchCategory("Товары для курения") },
  { id: "cars", title: "Автомобили", url: buildSearchCategory("Автомобили") },
  { id: "travel_tickets", title: "Билеты, отели, туры", url: buildSearchCategory("Билеты отели туры") },
  { id: "gift_certificates", title: "Подарочные сертификаты OZON", url: buildSearchCategory("Подарочные сертификаты OZON") }
]

const readInt = (name: string, fallback: number, min: number): number => {
  const raw = process.env[name]
  if (raw === undefined || raw.trim().length === 0) {
    return fallback
  }
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? Math.max(min, parsed) : fallback
}

const readBool = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name]
  if (raw === undefined || raw.trim().length === 0) {
    return fallback
  }
  const normalized = raw.trim().toLowerCase()
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false
  }
  return fallback
}

const readDiscoveryMode = (): DiscoveryMode => {
  const raw = process.env.DISCOVERY_MODE?.trim().toLowerCase()
  return raw === "category" ? "category" : "seller_feed"
}

const normalizeOrigin = (rawOrigin: string | undefined): string => {
  const parsed = new URL(rawOrigin ?? "https://ozon.com")
  parsed.pathname = ""
  parsed.search = ""
  parsed.hash = ""
  return parsed.toString().replace(/\/$/g, "")
}

const normalizePagePath = (rawPath: string | undefined, fallback: string): string => {
  const value = rawPath?.trim() || fallback
  const parsed = new URL(value, "https://ozon.com")
  return `${parsed.pathname}${parsed.search}`
}

const readArgValue = (argv: ReadonlyArray<string>, option: string): string | null => {
  const index = argv.indexOf(option)
  if (index < 0) {
    return null
  }
  return argv[index + 1] ?? null
}

const readCsv = (name: string, fallback: ReadonlyArray<string>): ReadonlyArray<string> => {
  const raw = process.env[name]
  if (raw === undefined || raw.trim().length === 0) {
    return fallback
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

export const loadConfig = (argv: ReadonlyArray<string>): IndexerConfig => {
  const durationFromArg = readArgValue(argv, "--duration-minutes")
  const durationMinutes = durationFromArg === null
    ? readInt("DURATION_MINUTES", 9, 1)
    : Math.max(1, Number.parseInt(durationFromArg, 10) || 9)

  const minActionDelayMs = readInt("MIN_ACTION_DELAY_MS", 2_000, 0)
  const maxActionDelayMs = Math.max(minActionDelayMs, readInt("MAX_ACTION_DELAY_MS", 6_000, minActionDelayMs))
  const discoveryMode = readDiscoveryMode()
  const defaultSeedSellerUrls = discoveryMode === "seller_feed" ? [] : ["https://ozon.com/seller/worldofsport/"]

  return {
    dataDirectory: process.env.DATA_DIRECTORY ?? "data",
    artifactsDirectory: process.env.ARTIFACTS_DIRECTORY ?? "artifacts",
    stateFile: process.env.STATE_FILE ?? "state/indexer-state.json",
    reportsDirectory: process.env.REPORTS_DIRECTORY ?? "reports",
    durationMinutes,
    maxCategoryWorkers: readInt("MAX_CATEGORY_WORKERS", 1, 1),
    maxProductWorkers: readInt("MAX_PRODUCT_WORKERS", 2, 0),
    maxSellerWorkers: readInt("MAX_SELLER_WORKERS", 2, 0),
    maxPagesPerRun: readInt("MAX_PAGES_PER_RUN", 25, 0),
    maxProductsPerRun: readInt("MAX_PRODUCTS_PER_RUN", 300, 0),
    maxSellersPerRun: readInt("MAX_SELLERS_PER_RUN", 150, 0),
    minActionDelayMs,
    maxActionDelayMs,
    blockCooldownMs: readInt("BLOCK_COOLDOWN_MS", 180_000, 1_000),
    navigationTimeoutMs: readInt("NAVIGATION_TIMEOUT_MS", 30_000, 5_000),
    headless: readBool("HEADLESS", true),
    discoveryMode,
    ozonApiOrigin: normalizeOrigin(process.env.OZON_API_ORIGIN),
    ozonCookie: process.env.OZON_COOKIE?.trim() || null,
    sellerFeedStartPath: normalizePagePath(process.env.OZON_SELLER_FEED_START_PATH, "/seller/"),
    categories: defaultCategories,
    seedSellerUrls: readCsv("SEED_SELLER_URLS", defaultSeedSellerUrls)
  }
}
