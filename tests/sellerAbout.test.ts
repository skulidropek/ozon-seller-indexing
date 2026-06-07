import { describe, expect, it } from "vitest"

import { extractSellerAboutFieldsFromText } from "../src/sellerAbout.js"

describe("extractSellerAboutFieldsFromText", () => {
  it("extracts individual entrepreneur name and OGRNIP from Ozon seller modal text", () => {
    const extracted = extractSellerAboutFieldsFromText({
      rawText: [
        "О магазине",
        "Заказов",
        "61,6 K",
        "Работает с Ozon",
        "3 года",
        "Оригинальные товары брендов",
        "ИП Шевелев Иван Алексеевич",
        "319861700007028",
        "Работает согласно графику Ozon"
      ].join("\n"),
      rawJson: "{\"data\":\"sample\"}",
      extractedAt: "2026-06-06T00:00:00.000Z"
    })

    expect(extracted.sellerLegalName).toBe("ИП Шевелев Иван Алексеевич")
    expect(extracted.sellerLegalPersonName).toBe("Шевелев Иван Алексеевич")
    expect(extracted.sellerLegalIdentifier).toBe("319861700007028")
    expect(extracted.sellerLegalIdentifierType).toBe("ogrnip")
    expect(extracted.sellerAboutRawJson).toBe("{\"data\":\"sample\"}")
  })

  it("extracts legal details from modal HTML with br separators", () => {
    const extracted = extractSellerAboutFieldsFromText({
      rawText: [
        "<div>О магазине</div>",
        "<span class=\"tsBody400Small\">ИП Шевелев Иван Алексеевич<br>319861700007028</span>",
        "<div>Работает согласно графику Ozon</div>"
      ].join(""),
      rawJson: null,
      extractedAt: "2026-06-06T00:00:00.000Z"
    })

    expect(extracted.sellerLegalName).toBe("ИП Шевелев Иван Алексеевич")
    expect(extracted.sellerLegalPersonName).toBe("Шевелев Иван Алексеевич")
    expect(extracted.sellerLegalIdentifier).toBe("319861700007028")
    expect(extracted.sellerLegalIdentifierType).toBe("ogrnip")
  })

  it("does not treat CMS JSON ids as legal details", () => {
    const extracted = extractSellerAboutFieldsFromText({
      rawText: [
        "{\"name\":\"cms.separator\",\"component\":\"cms.text\",\"title\":\"ИП Шевелев Иван Алексеевич\"}",
        "319861700007028",
        "О магазине"
      ].join("\n"),
      rawJson: null,
      extractedAt: "2026-06-06T00:00:00.000Z"
    })

    expect(extracted.sellerLegalName).toBeNull()
    expect(extracted.sellerLegalIdentifier).toBeNull()
  })
})
