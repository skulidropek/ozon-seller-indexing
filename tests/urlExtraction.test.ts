import { describe, expect, it } from "vitest"

import { extractNextPagePath, extractProductUrls, extractSellerCandidates } from "../src/ozon.js"

describe("Ozon JSON extraction", () => {
  it("extracts product URLs, seller URLs and next page token", () => {
    const json = {
      nextPage: "/category/electronics-15500/?page=2&sorting=rating",
      widgetStates: {
        products: JSON.stringify({
          items: [
            {
              link: "/product/test-product-123/",
              seller: {
                link: "/seller/worldofsport/",
                title: "WorldOfSport"
              }
            }
          ]
        })
      }
    }

    expect(extractProductUrls(json)).toEqual(["https://www.ozon.ru/product/test-product-123/"])
    expect(extractSellerCandidates(json)).toEqual([
      {
        sellerUrl: "https://www.ozon.ru/seller/worldofsport/",
        sellerKey: "worldofsport",
        sellerName: "WorldOfSport"
      }
    ])
    expect(extractNextPagePath(json)).toBe("/category/electronics-15500/?page=2&sorting=rating")
  })
})
