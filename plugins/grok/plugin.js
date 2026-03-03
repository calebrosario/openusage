(function () {
  const MANAGEMENT_API_BASE = "https://management-api.x.ai"
  const INFERENCE_API_BASE = "https://api.x.ai"
  const PREPAID_BALANCE_PATH = "/v1/billing/teams/{team_id}/prepaid/balance"
  const USAGE_PATH = "/v1/billing/teams/{team_id}/usage"
  const MODELS_PATH = "/v1/models"

  function readEnvVar(ctx, name) {
    if (!ctx.host.env || typeof ctx.host.env.get !== "function") {
      return null
    }
    try {
      const value = ctx.host.env.get(name)
      if (typeof value !== "string") return null
      const trimmed = value.trim()
      return trimmed || null
    } catch (e) {
      ctx.host.log.warn("env read failed (" + name + "): " + String(e))
      return null
    }
  }

  function loadConfig(ctx) {
    const apiKey = readEnvVar(ctx, "XAI_API_KEY")
    const managementKey = readEnvVar(ctx, "XAI_MANAGEMENT_KEY")
    const teamId = readEnvVar(ctx, "XAI_TEAM_ID")

    return { apiKey, managementKey, teamId }
  }

  function fetchJson(ctx, url, authToken) {
    let resp
    try {
      resp = ctx.util.request({
        method: "GET",
        url: url,
        headers: {
          Authorization: "Bearer " + authToken,
          Accept: "application/json",
        },
        timeoutMs: 10000,
      })
    } catch (e) {
      ctx.host.log.warn("request failed (" + url + "): " + String(e))
      throw "Network error. Check your connection."
    }

    if (ctx.util.isAuthStatus(resp.status)) {
      throw "Invalid credentials. Verify your API key."
    }

    if (resp.status < 200 || resp.status >= 300) {
      ctx.host.log.warn("request returned status " + String(resp.status) + " (" + url + ")")
      throw "Request failed (HTTP " + String(resp.status) + "). Try again later."
    }

    const parsed = ctx.util.tryParseJson(resp.bodyText)
    if (!parsed || typeof parsed !== "object") {
      ctx.host.log.warn("request returned invalid JSON (" + url + ")")
      throw "Response invalid. Try again later."
    }

    return parsed
  }

  function readNumberField(obj, keys) {
    if (!obj || typeof obj !== "object") return null
    for (let i = 0; i < keys.length; i += 1) {
      const n = Number(obj[keys[i]])
      if (Number.isFinite(n)) return n
    }
    return null
  }

  function parseBalanceUsd(data) {
    if (data.total && data.total.val !== undefined) {
      const n = Number(data.total.val)
      if (Number.isFinite(n)) return Math.abs(n) / 100  // convert cents to dollars
    }

    let balance = readNumberField(data, ["balance", "balance_usd", "balanceUsd", "remaining", "credits"])
    if (balance !== null) return balance

    if (data.prepaid) {
      balance = readNumberField(data.prepaid, ["balance", "balance_usd", "balanceUsd", "remaining", "credits"])
      if (balance !== null) return balance
    }

    if (data.credits) {
      balance = readNumberField(data.credits, ["balance", "balance_usd", "balanceUsd", "remaining", "amount"])
      if (balance !== null) return balance
    }

    for (const key in data) {
      if (/(balance|credit|remaining)/i.test(key)) {
        const n = Number(data[key])
        if (Number.isFinite(n)) return n
      }
    }

    return null
  }

  function parseUsageSpend(data) {
    if (data.timeSeries && Array.isArray(data.timeSeries)) {
      let total = 0
      for (let i = 0; i < data.timeSeries.length; i += 1) {
        const series = data.timeSeries[i]
        if (series.dataPoints && Array.isArray(series.dataPoints)) {
          for (let j = 0; j < series.dataPoints.length; j += 1) {
            const dp = series.dataPoints[j]
            if (dp.values && Array.isArray(dp.values) && dp.values[0] !== undefined) {
              const n = Number(dp.values[0])
              if (Number.isFinite(n) && n > 0) {
                total += n  // usage API returns dollars, keep as is
              }
            }
          }
        }
      }
      if (total > 0) return total
    }

    if (data.changes && Array.isArray(data.changes)) {
      let total = 0
      for (let i = 0; i < data.changes.length; i += 1) {
        const change = data.changes[i]
        if (change.changeOrigin === "SPEND" && change.amount && change.amount.val !== undefined) {
          const n = Number(change.amount.val)
          if (Number.isFinite(n) && n > 0) {
            total += n / 100  // convert cents to dollars for consistency with timeSeries
          }
        }
      }
      if (total > 0) return total
    }

    let spend = readNumberField(data, ["total_cost", "totalCost", "spend", "used", "usage_cost", "usageCost"])
    if (spend !== null) return spend

    if (data.usage) {
      spend = readNumberField(data.usage, ["total_cost", "totalCost", "spend", "used", "cost"])
      if (spend !== null) return spend
    }

    if (data.summary) {
      spend = readNumberField(data.summary, ["total_cost", "totalCost", "spend", "used", "cost"])
      if (spend !== null) return spend
    }

    const items = data.items || data.usage_items
    if (Array.isArray(items)) {
      let total = 0
      let hasValue = false
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i]
        const cost = readNumberField(item, ["cost", "amount", "spend", "total_cost", "usage_cost"])
        if (cost !== null) {
          total += cost
          hasValue = true
        }
      }
      if (hasValue) return total
    }

    for (const key in data) {
      if (/(cost|spend|used|usage)/i.test(key)) {
        const n = Number(data[key])
        if (Number.isFinite(n) && n >= 0) return n
      }
    }

    return null
  }

  function fetchUsage(ctx, managementKey, teamId) {
    const usageUrl = MANAGEMENT_API_BASE + USAGE_PATH.replace("{team_id}", teamId)
    let resp
    try {
      const now = new Date()
      const yearAgo = new Date(now)
      yearAgo.setFullYear(now.getFullYear() - 1)

      const body = JSON.stringify({
        analyticsRequest: {
          timeRange: {
            startTime: yearAgo.toISOString().slice(0, 10) + " 00:00:00",
            endTime: now.toISOString().slice(0, 10) + " 23:59:59",
            timezone: "UTC",
          },
          timeUnit: "TIME_UNIT_MONTH",
          values: [
            {
              name: "usd",
              aggregation: "AGGREGATION_SUM",
            },
          ],
          groupBy: [],
          filters: [],
        },
      })

      resp = ctx.util.request({
        method: "POST",
        url: usageUrl,
        headers: {
          Authorization: "Bearer " + managementKey,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: body,
        timeoutMs: 10000,
      })
    } catch (e) {
      ctx.host.log.warn("usage request failed (" + usageUrl + "): " + String(e))
      throw null
    }

    if (resp.status < 200 || resp.status >= 300) {
      ctx.host.log.warn("usage request returned status " + String(resp.status) + " (" + usageUrl + ")")
      throw null
    }

    const parsed = ctx.util.tryParseJson(resp.bodyText)
    if (!parsed || typeof parsed !== "object") {
      ctx.host.log.warn("usage request returned invalid JSON (" + usageUrl + ")")
      throw null
    }

    return parsed
  }

  function probeWithManagementApi(ctx, managementKey, teamId) {
    const balanceUrl = MANAGEMENT_API_BASE + PREPAID_BALANCE_PATH.replace("{team_id}", teamId)
    let balanceData
    try {
      balanceData = fetchJson(ctx, balanceUrl, managementKey)
    } catch (e) {
      if (typeof e === "string") throw e
      ctx.host.log.error("balance fetch failed: " + String(e))
      throw "Balance unavailable. Try again later."
    }

    const balanceUsd = parseBalanceUsd(balanceData)
    if (balanceUsd === null) {
      ctx.host.log.warn("could not parse balance from response: " + JSON.stringify(balanceData))
      throw "Balance unavailable. Try again later."
    }

    let usedUsd = 0
    let usageData
    try {
      usageData = fetchUsage(ctx, managementKey, teamId)
      ctx.host.log.info("Grok DEBUG: usageData received: " + (usageData ? "yes" : "null"))
      if (usageData) {
        ctx.host.log.info("Grok DEBUG: usageData keys: " + Object.keys(usageData).join(", "))
        usedUsd = parseUsageSpend(usageData) || 0
        ctx.host.log.info("Grok DEBUG: parseUsageSpend returned: " + usedUsd)
      }
    } catch (e) {
      ctx.host.log.warn("Grok DEBUG: usage fetch exception: " + String(e))
    }

    ctx.host.log.info("Grok: final usedUsd=" + usedUsd + " balanceUsd=" + balanceUsd)

    const lines = []
    const prepaidUsd = Math.max(0, balanceUsd)
    ctx.host.log.info("Grok: used=" + usedUsd + " prepaid=" + prepaidUsd)

    if (prepaidUsd > 0) {
      let finalUsedUsd = usedUsd

      if (finalUsedUsd >= prepaidUsd) {
        ctx.host.log.warn("Grok: usage >= prepaid, assuming 0 usage")
        finalUsedUsd = 0
      }

      lines.push(ctx.line.progress({
        label: "Credits",
        used: finalUsedUsd,
        limit: prepaidUsd,
        format: { kind: "dollars" },
      }))
    } else {
      lines.push(ctx.line.badge({
        label: "Credits",
        text: "$0",
        color: "#ef4444",
      }))
    }

    if (balanceData.team_name || balanceData.teamName) {
      lines.push(ctx.line.text({
        label: "Team",
        value: balanceData.team_name || balanceData.teamName,
      }))
    }

    lines.push(ctx.line.text({
      label: "Mode",
      value: "Full (Management API)",
      color: "#22c55e",
    }))

    return { lines }
  }

  function probeWithApiKey(ctx, apiKey) {
    const modelsUrl = INFERENCE_API_BASE + MODELS_PATH
    let modelsData
    try {
      modelsData = fetchJson(ctx, modelsUrl, apiKey)
    } catch (e) {
      if (typeof e === "string") throw e
      ctx.host.log.error("models fetch failed: " + String(e))
      throw "API unavailable. Try again later."
    }

    const lines = []

    const models = modelsData.data || modelsData.models || []
    const modelCount = Array.isArray(models) ? models.length : 0

    lines.push(ctx.line.badge({
      label: "Status",
      text: "Connected",
      color: "#22c55e",
    }))

    if (modelCount > 0) {
      lines.push(ctx.line.text({
        label: "Models",
        value: String(modelCount) + " available",
      }))
    }

    lines.push(ctx.line.text({
      label: "Mode",
      value: "Limited (API Key only)",
      color: "#f59e0b",
    }))

    lines.push(ctx.line.text({
      label: "Note",
      value: "Add Management Key for billing data",
      color: "#6b7280",
    }))

    return { lines }
  }

  function probe(ctx) {
    const config = loadConfig(ctx)
    const { apiKey, managementKey, teamId } = config

    if (managementKey && teamId) {
      return probeWithManagementApi(ctx, managementKey, teamId)
    }

    if (apiKey) {
      return probeWithApiKey(ctx, apiKey)
    }

    throw "Not configured. Set XAI_API_KEY for basic access, or XAI_MANAGEMENT_KEY + XAI_TEAM_ID for billing data."
  }

  globalThis.__openusage_plugin = { id: "grok", probe }
})()
