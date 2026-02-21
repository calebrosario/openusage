# Grok

> Track xAI API usage and prepaid credits balance.

## Overview

- **Protocol:** HTTPS (JSON)
- **Auth modes:**
  - **Full mode:** Management API key + Team ID → shows credits balance and usage
  - **Limited mode:** API key only → shows connectivity status and available models

## Configuration

### Option 1: Full Mode (Recommended)

Shows prepaid credits balance and usage spend.

```bash
export XAI_MANAGEMENT_KEY="your-management-key"
export XAI_TEAM_ID="your-team-id"
```

#### Getting Your Management Key

1. Go to [xAI Console](https://console.x.ai/)
2. Navigate to **Settings** → **Management Keys**
3. Ensure your account has `Management Keys` Read permission
4. Create or copy your management key

#### Finding Your Team ID

Your team ID can be found:
- In the xAI Console URL: `https://console.x.ai/team/{team_id}/...`
- On the billing page

### Option 2: Limited Mode

Shows connectivity status and model availability. No billing data.

```bash
export XAI_API_KEY="your-api-key"
```

Get your API key from [xAI Console](https://console.x.ai/) → **API Keys**.

## Output

### Full Mode (Management API)

- **Credits** (progress bar): Shows prepaid credits balance as dollars (used vs limit)
- **Team** (text): Team name if available
- **Mode** (text): Shows "Full (Management API)" with green indicator

### Limited Mode (API Key)

- **Status** (badge): Shows "Connected" if API key is valid
- **Models** (text): Number of available models
- **Mode** (text): Shows "Limited (API Key only)" with yellow indicator
- **Note** (text): Reminder to add Management Key for billing data

## Data Sources

### Management API

- Base URL: `https://management-api.x.ai`
- `/v1/billing/teams/{team_id}/prepaid/balance` — remaining prepaid credits
- `/v1/billing/teams/{team_id}/usage` — usage spend

### Inference API (Limited Mode)

- Base URL: `https://api.x.ai`
- `/v1/models` — list available models (used for connectivity check)

## Priority

When both `XAI_API_KEY` and `XAI_MANAGEMENT_KEY` + `XAI_TEAM_ID` are set, the plugin uses Management API (full mode).

## Limitations

- Management API requires separate key (not the same as inference API key)
- Team admin must enable Management Keys permission
- Usage tracking may not be available for all account types
- Limited mode only shows connectivity, not billing data
