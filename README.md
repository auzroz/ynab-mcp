# YNAB MCP Server

A Model Context Protocol (MCP) server providing comprehensive YNAB (You Need A Budget) API coverage for integration with Claude and other MCP-compatible AI assistants.

## Features

- **55 MCP Tools**: Complete coverage of YNAB API endpoints plus advanced analytics
- **Read-Only Mode**: Safe by default (YNAB_READ_ONLY=true), write operations require explicit opt-in
- **Smart Rate Limiting**: Token bucket algorithm respecting YNAB's 200 req/hour limit
- **Intelligent Caching**: Reduces API calls for infrequently changing data
- **Advanced Analytics**:
  - Recurring transaction/subscription detection
  - Spending trend analysis
  - Budget health assessment
  - Savings opportunity identification

## Quick Start

### Prerequisites

- Node.js 20 or later
- A YNAB account with API access
- A YNAB Personal Access Token ([get one here](https://app.ynab.com/settings/developer))

### Installation

```bash
# Clone the repository
git clone https://github.com/auzroz/ynab-mcp.git
cd ynab-mcp

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env and add your YNAB_ACCESS_TOKEN
```

### Configuration

Edit `.env` with your settings:

```env
# Required: Your YNAB Personal Access Token
YNAB_ACCESS_TOKEN=your_personal_access_token

# Optional: Default budget UUID (uses "last-used" if not set)
YNAB_BUDGET_ID=optional_default_budget_uuid

# Optional: Set to false to enable write operations (default: true)
YNAB_READ_ONLY=true
```

### Build & Run

```bash
# Build TypeScript
npm run build

# Run the server
npm start
```

### Claude Desktop Integration

Add to your Claude Desktop configuration (`~/.config/claude/claude_desktop_config.json` on Linux/Mac or `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

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

## Available Tools (55 Total)

### User Tools (1)
- `ynab_get_user` - Get authenticated user information

### Budget Tools (3)
- `ynab_list_budgets` - List all accessible budgets
- `ynab_get_budget` - Get detailed budget information
- `ynab_get_budget_settings` - Get budget settings (currency format, etc.)

### Account Tools (3)
- `ynab_list_accounts` - List all accounts with balances
- `ynab_get_account` - Get specific account details
- `ynab_create_account` - Create a new account *(requires YNAB_READ_ONLY=false)*

### Category Tools (4)
- `ynab_list_categories` - List all category groups and categories
- `ynab_get_category` - Get category details
- `ynab_get_month_category` - Get category budget for specific month
- `ynab_update_category` - Update category budgeted amount *(requires YNAB_READ_ONLY=false)*

### Payee Tools (5)
- `ynab_list_payees` - List all payees (merchants/vendors)
- `ynab_get_payee` - Get specific payee details
- `ynab_list_payee_locations` - List all payee locations for mapping
- `ynab_get_payee_location` - Get specific payee location
- `ynab_list_payee_locations_by_payee` - List locations for a specific payee

### Month Tools (2)
- `ynab_list_months` - List all budget months
- `ynab_get_month` - Get detailed month summary with categories

### Transaction Tools (10)
- `ynab_list_transactions` - List transactions with filters (date, category, payee)
- `ynab_get_transaction` - Get transaction details
- `ynab_create_transaction` - Create a new transaction *(requires YNAB_READ_ONLY=false)*
- `ynab_create_transactions` - Bulk create transactions (max 100) *(requires YNAB_READ_ONLY=false)*
- `ynab_update_transaction` - Update a transaction *(requires YNAB_READ_ONLY=false)*
- `ynab_delete_transaction` - Delete a transaction *(requires YNAB_READ_ONLY=false)*
- `ynab_list_account_transactions` - List transactions for a specific account
- `ynab_list_category_transactions` - List transactions for a specific category
- `ynab_list_payee_transactions` - List transactions for a specific payee
- `ynab_import_transactions` - Trigger import from linked bank accounts *(requires YNAB_READ_ONLY=false)*

### Scheduled Transaction Tools (2)
- `ynab_list_scheduled_transactions` - List scheduled/recurring transactions
- `ynab_get_scheduled_transaction` - Get scheduled transaction details

### Analytics Tools (22)
- `ynab_detect_recurring` - Find subscription patterns and recurring payments
- `ynab_spending_analysis` - Analyze spending trends by category
- `ynab_budget_health` - Assess overall budget health with score and alerts
- `ynab_savings_opportunities` - Identify potential areas to save money
- `ynab_budget_vs_actuals` - Compare budgeted vs actual spending
- `ynab_quick_summary` - At-a-glance budget status overview
- `ynab_income_expense` - Income vs expense breakdown and trends
- `ynab_net_worth` - Calculate total net worth from all accounts
- `ynab_goal_progress` - Track goal funding progress with projections
- `ynab_spending_by_payee` - Analyze spending by merchant/payee
- `ynab_unused_categories` - Find inactive or unused categories
- `ynab_monthly_comparison` - Month-over-month spending comparison
- `ynab_spending_trends` - Multi-month trend analysis with projections
- `ynab_cash_flow_forecast` - Project future cash flow based on scheduled transactions
- `ynab_reconciliation_helper` - Help with account reconciliation
- `ynab_budget_suggestions` - Get budget suggestions based on history
- `ynab_overspending_alerts` - Quick check for overspent categories
- `ynab_transaction_search` - Powerful multi-filter transaction search
- `ynab_spending_pace` - Track daily spending rate vs target
- `ynab_category_balances` - Quick category balance lookup
- `ynab_credit_card_status` - Credit card balances vs payment categories
- `ynab_age_of_money` - Age of money metric with explanation

### System Tools (3)
- `ynab_rate_limit_status` - Check API rate limit status
- `ynab_audit_log` - View write operation audit log
- `ynab_health_check` - Test API connectivity

## Example Conversations

**Checking account balances:**
> "What's my current net worth?"
>
> Claude uses `ynab_list_accounts` and calculates total assets minus liabilities.

**Understanding spending:**
> "How much did I spend on dining out this month?"
>
> Claude uses `ynab_list_category_transactions` filtered to the dining category.

**Finding subscriptions:**
> "What subscriptions do I have?"
>
> Claude uses `ynab_detect_recurring` to identify recurring payments.

**Budget health check:**
> "Is my budget in good shape?"
>
> Claude uses `ynab_budget_health` to analyze overspending, underfunded goals, and provide a health score.

**Finding savings:**
> "Where can I cut back on spending?"
>
> Claude uses `ynab_savings_opportunities` to identify discretionary spending and potential cuts.

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

```text
src/
├── index.ts           # Entry point (stdio server)
├── server.ts          # Tool registration
├── config/            # Environment configuration
├── services/          # Core services
│   ├── ynab-client.ts # YNAB API wrapper with rate limiting
│   ├── rate-limiter.ts # Token bucket rate limiter
│   └── cache.ts       # In-memory TTL cache
├── tools/             # MCP tool implementations
│   ├── user/
│   ├── budgets/
│   ├── accounts/
│   ├── categories/
│   ├── payees/
│   ├── months/
│   ├── transactions/
│   ├── scheduled-transactions/
│   └── analytics/
└── utils/             # Helpers (currency, dates, errors)
```

## Security

- **Read-Only by Default**: Write operations are disabled unless `YNAB_READ_ONLY=false`
- **Token Security**: Never commit your `YNAB_ACCESS_TOKEN`; store only in environment variables
- **Input Validation**: All tool parameters are validated with Zod schemas
- **Rate Limiting**: Built-in protection against API quota exhaustion

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests and linting: `npm test && npm run lint`
5. Submit a pull request

## License

MIT

## Acknowledgments

- [YNAB](https://www.ynab.com/) for their excellent budgeting platform and API
- [Anthropic](https://www.anthropic.com/) for the Model Context Protocol
