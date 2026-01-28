# YNAB MCP Server

[![npm version](https://img.shields.io/npm/v/ynab-mcp)](https://www.npmjs.com/package/ynab-mcp)
[![Docker](https://img.shields.io/badge/docker-ghcr.io%2Fauzroz%2Fynab--mcp-blue)](https://github.com/auzroz/ynab-mcp/pkgs/container/ynab-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js 20+](https://img.shields.io/badge/node-20%2B-brightgreen)](https://nodejs.org)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-blue)](https://modelcontextprotocol.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)](https://www.typescriptlang.org/)

A comprehensive [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for **YNAB (You Need A Budget)** that enables AI assistants like **Claude Desktop** to read your budget, analyze spending patterns, detect subscriptions, and provide personalized financial insights—all through natural conversation.

## Why YNAB MCP?

Traditional YNAB integrations require manual API calls or custom scripting. This MCP server lets you:

- **Talk to your budget naturally** — Ask Claude "Am I overspending on dining out?" and get instant insights
- **Get AI-powered financial analysis** — Subscription detection, spending trends, savings recommendations, and budget health scores
- **Stay safe by default** — Read-only mode protects against accidental changes
- **Access everything** — 55 tools covering 100% of the YNAB API plus 22 custom analytics tools

## Features

| Feature | Description |
|---------|-------------|
| **Complete API Coverage** | 55 MCP tools spanning all YNAB API endpoints |
| **Advanced Analytics** | 22 tools for spending analysis, trend detection, and financial insights |
| **Read-Only by Default** | Write operations require explicit opt-in (`YNAB_READ_ONLY=false`) |
| **Smart Rate Limiting** | Token bucket algorithm with 180 req/hour budget (10% safety margin) |
| **Intelligent Caching** | Reduces API calls for infrequently changing data |
| **Type-Safe** | Full TypeScript implementation with Zod schema validation |

## Quick Start

### Prerequisites

- A YNAB account with API access
- A YNAB Personal Access Token ([get one here](https://app.ynab.com/settings/developer))

### Installation Options

#### Option 1: npx (Easiest)

No installation required—run directly:

```bash
npx ynab-mcp
```

#### Option 2: Docker

```bash
docker run -e YNAB_ACCESS_TOKEN=your_token ghcr.io/auzroz/ynab-mcp:latest
```

#### Option 3: Install from Source

```bash
# Clone the repository
git clone https://github.com/auzroz/ynab-mcp.git
cd ynab-mcp

# Install dependencies and build
npm install
npm run build

# Run the server
npm start
```

### Configuration

The server is configured via environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `YNAB_ACCESS_TOKEN` | Yes | Your YNAB Personal Access Token |
| `YNAB_BUDGET_ID` | No | Default budget UUID (uses "last-used" if not set) |
| `YNAB_READ_ONLY` | No | Set to `false` to enable write operations (default: `true`) |

### Claude Desktop Integration

Add to your Claude Desktop configuration:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

#### Using npx (Recommended)

```json
{
  "mcpServers": {
    "ynab": {
      "command": "npx",
      "args": ["ynab-mcp"],
      "env": {
        "YNAB_ACCESS_TOKEN": "your_token_here"
      }
    }
  }
}
```

#### Using Docker

```json
{
  "mcpServers": {
    "ynab": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "YNAB_ACCESS_TOKEN",
        "ghcr.io/auzroz/ynab-mcp:latest"
      ],
      "env": {
        "YNAB_ACCESS_TOKEN": "your_token_here"
      }
    }
  }
}
```

#### Using Local Build

```json
{
  "mcpServers": {
    "ynab": {
      "command": "node",
      "args": ["/path/to/ynab-mcp/dist/index.js"],
      "env": {
        "YNAB_ACCESS_TOKEN": "your_token_here"
      }
    }
  }
}
```

## Example Conversations

Once connected, try asking Claude:

| Question | Tool Used |
|----------|-----------|
| "What's my current net worth?" | `ynab_net_worth` |
| "How much did I spend on dining out this month?" | `ynab_list_category_transactions` |
| "What subscriptions do I have?" | `ynab_detect_recurring` |
| "Is my budget in good shape?" | `ynab_budget_health` |
| "Where can I cut back on spending?" | `ynab_savings_opportunities` |
| "Am I on track this month?" | `ynab_spending_pace` |
| "Compare this month to last month" | `ynab_monthly_comparison` |

## Available Tools (55 Total)

### Analytics Tools (22)

These tools provide AI-powered financial insights beyond basic YNAB functionality:

| Tool | Description |
|------|-------------|
| `ynab_detect_recurring` | Find subscription patterns and recurring payments |
| `ynab_spending_analysis` | Analyze spending trends by category |
| `ynab_budget_health` | Assess overall budget health with score and alerts |
| `ynab_savings_opportunities` | Identify potential areas to save money |
| `ynab_budget_vs_actuals` | Compare budgeted vs actual spending |
| `ynab_quick_summary` | At-a-glance budget status overview |
| `ynab_income_expense` | Income vs expense breakdown and trends |
| `ynab_net_worth` | Calculate total net worth from all accounts |
| `ynab_goal_progress` | Track goal funding progress with projections |
| `ynab_spending_by_payee` | Analyze spending by merchant/payee |
| `ynab_unused_categories` | Find inactive or unused categories |
| `ynab_monthly_comparison` | Month-over-month spending comparison |
| `ynab_spending_trends` | Multi-month trend analysis with projections |
| `ynab_cash_flow_forecast` | Project future cash flow based on scheduled transactions |
| `ynab_reconciliation_helper` | Help with account reconciliation |
| `ynab_budget_suggestions` | Get budget suggestions based on history |
| `ynab_overspending_alerts` | Quick check for overspent categories |
| `ynab_transaction_search` | Powerful multi-filter transaction search |
| `ynab_spending_pace` | Track daily spending rate vs target |
| `ynab_category_balances` | Quick category balance lookup |
| `ynab_credit_card_status` | Credit card balances vs payment categories |
| `ynab_age_of_money` | Age of money metric with explanation |

### Core YNAB API Tools (33)

Complete coverage of all YNAB API endpoints:

<details>
<summary><strong>User Tools (1)</strong></summary>

- `ynab_get_user` — Get authenticated user information
</details>

<details>
<summary><strong>Budget Tools (3)</strong></summary>

- `ynab_list_budgets` — List all accessible budgets
- `ynab_get_budget` — Get detailed budget information
- `ynab_get_budget_settings` — Get budget settings (currency format, etc.)
</details>

<details>
<summary><strong>Account Tools (3)</strong></summary>

- `ynab_list_accounts` — List all accounts with balances
- `ynab_get_account` — Get specific account details
- `ynab_create_account` — Create a new account *(write mode)*
</details>

<details>
<summary><strong>Category Tools (4)</strong></summary>

- `ynab_list_categories` — List all category groups and categories
- `ynab_get_category` — Get category details
- `ynab_get_month_category` — Get category budget for specific month
- `ynab_update_category` — Update category budgeted amount *(write mode)*
</details>

<details>
<summary><strong>Payee Tools (5)</strong></summary>

- `ynab_list_payees` — List all payees (merchants/vendors)
- `ynab_get_payee` — Get specific payee details
- `ynab_list_payee_locations` — List all payee locations for mapping
- `ynab_get_payee_location` — Get specific payee location
- `ynab_list_payee_locations_by_payee` — List locations for a specific payee
</details>

<details>
<summary><strong>Month Tools (2)</strong></summary>

- `ynab_list_months` — List all budget months
- `ynab_get_month` — Get detailed month summary with categories
</details>

<details>
<summary><strong>Transaction Tools (10)</strong></summary>

- `ynab_list_transactions` — List transactions with filters
- `ynab_get_transaction` — Get transaction details
- `ynab_create_transaction` — Create a new transaction *(write mode)*
- `ynab_create_transactions` — Bulk create transactions *(write mode)*
- `ynab_update_transaction` — Update a transaction *(write mode)*
- `ynab_delete_transaction` — Delete a transaction *(write mode)*
- `ynab_list_account_transactions` — List transactions for a specific account
- `ynab_list_category_transactions` — List transactions for a specific category
- `ynab_list_payee_transactions` — List transactions for a specific payee
- `ynab_import_transactions` — Trigger import from linked banks *(write mode)*
</details>

<details>
<summary><strong>Scheduled Transaction Tools (2)</strong></summary>

- `ynab_list_scheduled_transactions` — List scheduled/recurring transactions
- `ynab_get_scheduled_transaction` — Get scheduled transaction details
</details>

<details>
<summary><strong>System Tools (3)</strong></summary>

- `ynab_rate_limit_status` — Check API rate limit status
- `ynab_audit_log` — View write operation audit log
- `ynab_health_check` — Test API connectivity
</details>

## Development

```bash
# Run with hot reload
npm run dev

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Lint code
npm run lint

# Fix lint issues
npm run lint:fix

# Type check only
npm run typecheck
```

### Testing with MCP Inspector

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

## Architecture

```
src/
├── index.ts              # Entry point (stdio server)
├── server.ts             # Tool registration
├── config/               # Environment configuration
├── services/             # Core services
│   ├── ynab-client.ts    # YNAB API wrapper with rate limiting
│   ├── rate-limiter.ts   # Token bucket rate limiter
│   └── cache.ts          # In-memory TTL cache
├── tools/                # MCP tool implementations
│   ├── user/
│   ├── budgets/
│   ├── accounts/
│   ├── categories/
│   ├── payees/
│   ├── months/
│   ├── transactions/
│   ├── scheduled-transactions/
│   └── analytics/
└── utils/                # Helpers (currency, dates, errors)
```

## Security

| Feature | Description |
|---------|-------------|
| **Read-Only Default** | Write operations disabled unless `YNAB_READ_ONLY=false` |
| **Token Security** | Never commit your `YNAB_ACCESS_TOKEN`; use environment variables |
| **Input Validation** | All tool parameters validated with Zod schemas |
| **Rate Limiting** | Built-in protection against API quota exhaustion |
| **Audit Logging** | All write operations logged for review |

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run tests and linting: `npm test && npm run lint`
5. Commit your changes (`git commit -m 'Add amazing feature'`)
6. Push to the branch (`git push origin feature/amazing-feature`)
7. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- [YNAB](https://www.ynab.com/) for their excellent budgeting platform and API
- [Anthropic](https://www.anthropic.com/) for Claude and the Model Context Protocol
- [Model Context Protocol](https://modelcontextprotocol.io/) for the MCP specification

## Related Projects

- [YNAB API Documentation](https://api.ynab.com/)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Claude Desktop](https://claude.ai/download)

---

<p align="center">
  <strong>Built with ❤️ for the YNAB community</strong>
</p>