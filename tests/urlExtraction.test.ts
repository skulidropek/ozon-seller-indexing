import { describe, expect, it } from "vitest"

import {
  extractNextPagePath,
  extractProductUrls,
  extractSellerCandidates,
  extractSellerFeedPage,
  redactCookieHeader
} from "../src/ozon.js"

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

  it("extracts seller feed cards with names and paginator next page", () => {
    const json = {
      widgetStates: {
        "mallFeed-10178658-default-16": JSON.stringify({
          cards: [
            {
              header: {
                title: {
                  text: "Княгиня"
                },
                badges: [
                  {
                    text: "Магазин",
                    common: {
                      action: {
                        link: "/seller/knyaginya/"
                      }
                    }
                  }
                ]
              },
              action: {
                link: "/seller/knyaginya/"
              }
            },
            {
              header: {
                title: {
                  text: "Мир Хобби"
                },
                badges: [
                  {
                    text: "Магазин",
                    common: {
                      action: {
                        link: "/seller/mir-hobbi/"
                      }
                    }
                  }
                ]
              }
            }
          ]
        }),
        "paginator-10178657-default-16": JSON.stringify({
          nextPage: "/seller/?layout_container=default&layout_page_index=17&offset=121"
        })
      }
    }

    expect(extractSellerFeedPage(json)).toEqual({
      sellers: [
        {
          sellerUrl: "https://www.ozon.ru/seller/knyaginya/",
          sellerKey: "knyaginya",
          sellerName: "Княгиня"
        },
        {
          sellerUrl: "https://www.ozon.ru/seller/mir-hobbi/",
          sellerKey: "mir-hobbi",
          sellerName: "Мир Хобби"
        }
      ],
      nextPagePath: "/seller/?layout_container=default&layout_page_index=17&offset=121"
    })
  })

  it("redacts cookie values for diagnostics", () => {
    expect(redactCookieHeader("__Secure-access-token=abc; abt_data=def; guest=true")).toBe(
      "__Secure-access-token=<redacted>; abt_data=<redacted>; guest=<redacted>"
    )
  })
})
