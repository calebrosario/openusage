import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const TEAM_ID = "test-team-123"

const loadPlugin = async () => {
  await import("./plugin.js")
  return globalThis.__openusage_plugin
}

function mockEnvConfig(ctx, opts = {}) {
  const { apiKey = null, managementKey = "test-mgmt-key", teamId = TEAM_ID } = opts
  ctx.host.env.get.mockImplementation((name) => {
    if (name === "XAI_API_KEY") return apiKey
    if (name === "XAI_MANAGEMENT_KEY") return managementKey
    if (name === "XAI_TEAM_ID") return teamId
    return null
  })
}

function mockBalanceApi(ctx, balance, usageTimeSeries = null) {
  ctx.host.http.request.mockImplementation((req) => {
    if (req.url.includes("/prepaid/balance")) {
      return {
        status: 200,
        headers: {},
        bodyText: JSON.stringify({
          total: { val: String(-balance) },
          changes: [],
        }),
      }
    }
    if (req.method === "POST" && req.url.includes("/usage")) {
      return {
        status: 200,
        headers: {},
        bodyText: JSON.stringify(usageTimeSeries || { timeSeries: [] }),
      }
    }
    return { status: 404, headers: {}, bodyText: "{}" }
  })
}

describe("grok plugin", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin
    if (vi.resetModules) vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("throws when no env vars set", async () => {
    const ctx = makeCtx()
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Not configured")
  })

  it("throws when only XAI_MANAGEMENT_KEY set (missing team ID)", async () => {
    const ctx = makeCtx()
    ctx.host.env.get.mockImplementation((name) => {
      if (name === "XAI_MANAGEMENT_KEY") return "test-key"
      return null
    })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Not configured")
  })

  it("throws when only XAI_TEAM_ID set (missing management key)", async () => {
    const ctx = makeCtx()
    ctx.host.env.get.mockImplementation((name) => {
      if (name === "XAI_TEAM_ID") return TEAM_ID
      return null
    })
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Not configured")
  })

  it("returns credits progress bar with balance (management API)", async () => {
    const ctx = makeCtx()
    mockEnvConfig(ctx, { managementKey: "test-mgmt-key", teamId: TEAM_ID })
    mockBalanceApi(ctx, 2550) // Balance API returns cents

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(Array.isArray(result.lines)).toBe(true)

    const creditsLine = result.lines[0]
    expect(creditsLine.type).toBe("progress")
    expect(creditsLine.label).toBe("Credits")
    expect(creditsLine.format.kind).toBe("dollars")
    expect(creditsLine.limit).toBe(25.5) // 2550 cents / 100 = $25.50 prepaid
    expect(creditsLine.used).toBe(0) // no usage
  })

  it("returns credits with used amount from timeSeries", async () => {
    const ctx = makeCtx()
    mockEnvConfig(ctx)
    ctx.host.http.request.mockImplementation((req) => {
      if (req.url.includes("/prepaid/balance")) {
        return {
          status: 200,
          headers: {},
          bodyText: JSON.stringify({
            total: { val: "-10000" }, // Balance API returns cents
            changes: [],
          }),
        }
      }
      if (req.method === "POST" && req.url.includes("/usage")) {
        return {
          status: 200,
          headers: {},
          bodyText: JSON.stringify({
            timeSeries: [
              {
                group: [],
                groupLabels: [],
                dataPoints: [
                  { timestamp: "2026-01-01T00:00:00Z", values: [0.08241995] }, // Usage returns dollars
                  { timestamp: "2026-02-01T00:00:00Z", values: [2.9379162] },
                ],
              },
            ],
          }),
        }
      }
      return { status: 404, headers: {}, bodyText: "{}" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.lines[0].label).toBe("Credits")
    expect(result.lines[0].used).toBe(3.02033615) // 0.08241995 + 2.9379162 = usage amount
    expect(result.lines[0].limit).toBe(100) // 10000 cents / 100 = $100.00 prepaid
  })

  it("shows $0 badge when balance is zero", async () => {
    const ctx = makeCtx()
    mockEnvConfig(ctx)
    mockBalanceApi(ctx, 0)

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.lines[0].type).toBe("badge")
    expect(result.lines[0].text).toBe("$0")
    expect(result.lines[0].color).toBe("#ef4444")
  })

  it("shows team name when available", async () => {
    const ctx = makeCtx()
    mockEnvConfig(ctx)
    ctx.host.http.request.mockImplementation((req) => {
      if (req.url.includes("/prepaid/balance")) {
        return {
          status: 200,
          headers: {},
          bodyText: JSON.stringify({
            total: { val: "-50" },
            changes: [],
            team_name: "My Team",
          }),
        }
      }
      if (req.method === "POST" && req.url.includes("/usage")) {
        return {
          status: 200,
          headers: {},
          bodyText: JSON.stringify({ timeSeries: [] }),
        }
      }
      return { status: 404, headers: {}, bodyText: "{}" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    const teamLine = result.lines.find((l) => l.label === "Team")
    expect(teamLine).toBeDefined()
    expect(teamLine.type).toBe("text")
    expect(teamLine.value).toBe("My Team")
  })

  it("throws on auth error (management API)", async () => {
    const ctx = makeCtx()
    mockEnvConfig(ctx)
    ctx.host.http.request.mockReturnValue({ status: 401, headers: {}, bodyText: "" })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Invalid credentials")
  })

  it("throws on network error", async () => {
    const ctx = makeCtx()
    mockEnvConfig(ctx)
    ctx.host.http.request.mockImplementation(() => {
      throw new Error("network fail")
    })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Network error")
  })

  it("continues when usage endpoint fails", async () => {
    const ctx = makeCtx()
    mockEnvConfig(ctx)
    ctx.host.http.request.mockImplementation((req) => {
      if (req.url.includes("/prepaid/balance")) {
        return {
          status: 200,
          headers: {},
          bodyText: JSON.stringify({
            total: { val: "-1000" }, // Balance API returns cents
            changes: [],
          }),
        }
      }
      if (req.method === "POST" && req.url.includes("/usage")) {
        return { status: 500, headers: {}, bodyText: "error" }
      }
      return { status: 404, headers: {}, bodyText: "{}" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.lines[0].label).toBe("Credits")
    expect(result.lines[0].used).toBe(0) // no usage data available
    expect(result.lines[0].limit).toBe(10) // 1000 cents / 100 = $10.00 prepaid
  })

  it("calculates usage from usage response changes when timeSeries missing", async () => {
    const ctx = makeCtx()
    mockEnvConfig(ctx)
    ctx.host.http.request.mockImplementation((req) => {
      if (req.url.includes("/prepaid/balance")) {
        return {
          status: 200,
          headers: {},
          bodyText: JSON.stringify({
            total: { val: "-500" },
            changes: [],
          }),
        }
      }
      if (req.method === "POST" && req.url.includes("/usage")) {
        return {
          status: 200,
          headers: {},
          bodyText: JSON.stringify({
            changes: [
              { changeOrigin: "SPEND", amount: { val: "306" } },
            ],
          }),
        }
      }
      return { status: 404, headers: {}, bodyText: "{}" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.lines[0].label).toBe("Credits")
    expect(result.lines[0].limit).toBe(5) // 500 cents / 100 = $5.00 prepaid
    expect(result.lines[0].used).toBe(3.06) // 306 cents / 100 = $3.06 usage
  })

  it("parses actual xAI API response format", async () => {
    const ctx = makeCtx()
    mockEnvConfig(ctx)
    ctx.host.http.request.mockImplementation((req) => {
      if (req.url.includes("/prepaid/balance")) {
        return {
          status: 200,
          headers: {},
          bodyText: JSON.stringify({
            changes: [
              { changeOrigin: "PURCHASE", amount: { val: "-500" } }, // Cents
              { changeOrigin: "SPEND", amount: { val: "6" } }, // Cents
            ],
            total: { val: "-494" }, // Balance API returns cents
          }),
        }
      }
      if (req.method === "POST" && req.url.includes("/usage")) {
        return {
          status: 200,
          headers: {},
          bodyText: JSON.stringify({
            timeSeries: [
              {
                group: [],
                groupLabels: [],
                dataPoints: [
                  { timestamp: "2026-01-01T00:00:00Z", values: [0.08241995] }, // Usage returns dollars
                  { timestamp: "2026-02-01T00:00:00Z", values: [2.9379162] },
                ],
              },
            ],
          }),
        }
      }
      return { status: 404, headers: {}, bodyText: "{}" }
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.lines[0].label).toBe("Credits")
    expect(result.lines[0].limit).toBe(4.94) // 494 cents / 100 = $4.94 prepaid
    expect(result.lines[0].used).toBeCloseTo(3.02033615, 10) // 0.08241995 + 2.9379162 = usage
  })

  it("sends authorization header", async () => {
    const ctx = makeCtx()
    mockEnvConfig(ctx, { managementKey: "secret-key-123", teamId: TEAM_ID })
    mockBalanceApi(ctx, 10)

    const plugin = await loadPlugin()
    plugin.probe(ctx)

    const call = ctx.host.http.request.mock.calls[0]?.[0]
    expect(call.headers.Authorization).toBe("Bearer secret-key-123")
  })

  it("uses correct team id in url", async () => {
    const ctx = makeCtx()
    mockEnvConfig(ctx, { managementKey: "key", teamId: "my-custom-team" })
    mockBalanceApi(ctx, 10)

    const plugin = await loadPlugin()
    plugin.probe(ctx)

    const call = ctx.host.http.request.mock.calls[0]?.[0]
    expect(call.url).toContain("my-custom-team")
  })

  it("sends POST request with JSON body to usage endpoint", async () => {
    const ctx = makeCtx()
    mockEnvConfig(ctx)
    ctx.host.http.request.mockImplementation((req) => {
      if (req.url.includes("/prepaid/balance")) {
        return {
          status: 200,
          headers: {},
          bodyText: JSON.stringify({
            total: { val: "-10" },
            changes: [],
          }),
        }
      }
      if (req.method === "POST" && req.url.includes("/usage")) {
        return {
          status: 200,
          headers: {},
          bodyText: JSON.stringify({ timeSeries: [] }),
        }
      }
      return { status: 404, headers: {}, bodyText: "{}" }
    })

    const plugin = await loadPlugin()
    plugin.probe(ctx)

    const usageCall = ctx.host.http.request.mock.calls.find((c) => c[0]?.url?.includes("/usage"))
    expect(usageCall).toBeDefined()
    expect(usageCall?.[0]?.method).toBe("POST")
    expect(usageCall?.[0]?.headers["Content-Type"]).toBe("application/json")
    expect(usageCall?.[0]?.body).toContain("analyticsRequest")
    expect(usageCall?.[0]?.body).toContain("usd")
  })

  describe("API key mode", () => {
    it("uses API key when management key not set", async () => {
      const ctx = makeCtx()
      mockEnvConfig(ctx, { apiKey: "test-api-key", managementKey: null, teamId: null })
      ctx.host.http.request.mockImplementation((req) => {
        if (req.url.includes("/v1/models")) {
          return {
            status: 200,
            headers: {},
            bodyText: JSON.stringify({ data: [{ id: "grok-2" }, { id: "grok-beta" }] }),
          }
        }
        return { status: 404, headers: {}, bodyText: "{}" }
      })

      const plugin = await loadPlugin()
      const result = plugin.probe(ctx)

      expect(result.lines[0].type).toBe("badge")
      expect(result.lines[0].label).toBe("Status")
      expect(result.lines[0].text).toBe("Connected")
    })

    it("shows model count when available", async () => {
      const ctx = makeCtx()
      mockEnvConfig(ctx, { apiKey: "test-api-key", managementKey: null, teamId: null })
      ctx.host.http.request.mockImplementation((req) => {
        if (req.url.includes("/v1/models")) {
          return {
            status: 200,
            headers: {},
            bodyText: JSON.stringify({ data: [{ id: "grok-2" }, { id: "grok-beta" }, { id: "grok-vision" }] }),
          }
        }
        return { status: 404, headers: {}, bodyText: "{}" }
      })

      const plugin = await loadPlugin()
      const result = plugin.probe(ctx)

      const modelsLine = result.lines.find((l) => l.label === "Models")
      expect(modelsLine).toBeDefined()
      expect(modelsLine.value).toBe("3 available")
    })

    it("shows limited mode indicator", async () => {
      const ctx = makeCtx()
      mockEnvConfig(ctx, { apiKey: "test-api-key", managementKey: null, teamId: null })
      ctx.host.http.request.mockImplementation((req) => {
        if (req.url.includes("/v1/models")) {
          return {
            status: 200,
            headers: {},
            bodyText: JSON.stringify({ data: [] }),
          }
        }
        return { status: 404, headers: {}, bodyText: "{}" }
      })

      const plugin = await loadPlugin()
      const result = plugin.probe(ctx)

      const modeLine = result.lines.find((l) => l.label === "Mode")
      expect(modeLine).toBeDefined()
      expect(modeLine.value).toBe("Limited (API Key only)")
      expect(modeLine.color).toBe("#f59e0b")
    })

    it("uses api.x.ai endpoint for API key", async () => {
      const ctx = makeCtx()
      mockEnvConfig(ctx, { apiKey: "test-api-key", managementKey: null, teamId: null })
      ctx.host.http.request.mockImplementation((req) => {
        if (req.url.includes("api.x.ai/v1/models")) {
          return {
            status: 200,
            headers: {},
            bodyText: JSON.stringify({ data: [] }),
          }
        }
        return { status: 404, headers: {}, bodyText: "{}" }
      })

      const plugin = await loadPlugin()
      plugin.probe(ctx)

      const call = ctx.host.http.request.mock.calls[0]?.[0]
      expect(call.url).toContain("api.x.ai")
      expect(call.url).toContain("/v1/models")
    })

    it("prefers management API when both keys available", async () => {
      const ctx = makeCtx()
      mockEnvConfig(ctx, { apiKey: "test-api-key", managementKey: "test-mgmt-key", teamId: TEAM_ID })
      mockBalanceApi(ctx, 10000) // Balance API returns cents

      const plugin = await loadPlugin()
      const result = plugin.probe(ctx)

    expect(result.lines[0].label).toBe("Credits")
    expect(result.lines[0].limit).toBe(100) // 10000 cents / 100 = $100.00 prepaid
    expect(result.lines[0].used).toBe(0) // no usage, so used = 0
    })

    it("throws on auth error (API key)", async () => {
      const ctx = makeCtx()
      mockEnvConfig(ctx, { apiKey: "test-api-key", managementKey: null, teamId: null })
      ctx.host.http.request.mockReturnValue({ status: 401, headers: {}, bodyText: "" })

      const plugin = await loadPlugin()
      expect(() => plugin.probe(ctx)).toThrow("Invalid credentials")
    })
  })
})
