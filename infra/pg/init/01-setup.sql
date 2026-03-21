-- pg_stat_statements extension
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================================================
-- FINANCIAL DOMAIN SCHEMA
-- ============================================================

-- 고객
CREATE TABLE customers (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  email        TEXT UNIQUE NOT NULL,
  phone        TEXT,
  birth_date   DATE,
  country      TEXT NOT NULL DEFAULT 'KR',
  tier         TEXT NOT NULL DEFAULT 'BRONZE' CHECK (tier IN ('BRONZE','SILVER','GOLD','PLATINUM','VIP')),
  kyc_verified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 계좌
CREATE TABLE accounts (
  id             SERIAL PRIMARY KEY,
  customer_id    INT NOT NULL REFERENCES customers(id),
  account_number TEXT UNIQUE NOT NULL,
  account_type   TEXT NOT NULL CHECK (account_type IN ('CHECKING','SAVINGS','INVESTMENT','LOAN')),
  currency       TEXT NOT NULL DEFAULT 'KRW',
  balance        NUMERIC(18,2) NOT NULL DEFAULT 0,
  credit_limit   NUMERIC(18,2),
  status         TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','FROZEN','CLOSED')),
  opened_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at      TIMESTAMPTZ
);

-- 거래
CREATE TABLE transactions (
  id               BIGSERIAL PRIMARY KEY,
  account_id       INT NOT NULL REFERENCES accounts(id),
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('DEPOSIT','WITHDRAWAL','TRANSFER_IN','TRANSFER_OUT','FEE','INTEREST','LOAN_REPAYMENT')),
  amount           NUMERIC(18,2) NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'KRW',
  balance_after    NUMERIC(18,2) NOT NULL,
  description      TEXT,
  reference_id     TEXT,
  channel          TEXT CHECK (channel IN ('APP','WEB','ATM','BRANCH','API')),
  status           TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('PENDING','COMPLETED','FAILED','REVERSED')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 대출
CREATE TABLE loans (
  id               SERIAL PRIMARY KEY,
  customer_id      INT NOT NULL REFERENCES customers(id),
  account_id       INT REFERENCES accounts(id),
  loan_type        TEXT NOT NULL CHECK (loan_type IN ('PERSONAL','MORTGAGE','AUTO','BUSINESS','STUDENT')),
  principal        NUMERIC(18,2) NOT NULL,
  outstanding      NUMERIC(18,2) NOT NULL,
  interest_rate    NUMERIC(5,4) NOT NULL,
  term_months      INT NOT NULL,
  monthly_payment  NUMERIC(18,2) NOT NULL,
  next_payment_due DATE,
  status           TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAID_OFF','DEFAULTED','REFINANCED')),
  originated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 투자 포트폴리오
CREATE TABLE portfolios (
  id          SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id),
  name        TEXT NOT NULL,
  strategy    TEXT CHECK (strategy IN ('CONSERVATIVE','BALANCED','AGGRESSIVE','INDEX')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 투자 종목 보유
CREATE TABLE holdings (
  id            SERIAL PRIMARY KEY,
  portfolio_id  INT NOT NULL REFERENCES portfolios(id),
  ticker        TEXT NOT NULL,
  asset_type    TEXT NOT NULL CHECK (asset_type IN ('STOCK','BOND','ETF','CRYPTO','FUND')),
  quantity      NUMERIC(18,6) NOT NULL,
  avg_cost      NUMERIC(18,4) NOT NULL,
  current_price NUMERIC(18,4) NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 이상거래 탐지 로그
CREATE TABLE fraud_alerts (
  id             BIGSERIAL PRIMARY KEY,
  transaction_id BIGINT REFERENCES transactions(id),
  customer_id    INT REFERENCES customers(id),
  rule_name      TEXT NOT NULL,
  risk_score     NUMERIC(5,4) NOT NULL,
  status         TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','INVESTIGATING','RESOLVED','FALSE_POSITIVE')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_transactions_account_id  ON transactions(account_id);
CREATE INDEX idx_transactions_created_at  ON transactions(created_at DESC);
CREATE INDEX idx_transactions_type_status ON transactions(transaction_type, status);
CREATE INDEX idx_accounts_customer_id     ON accounts(customer_id);
CREATE INDEX idx_loans_customer_id        ON loans(customer_id);
CREATE INDEX idx_loans_status             ON loans(status);
CREATE INDEX idx_customers_tier           ON customers(tier);
CREATE INDEX idx_customers_country        ON customers(country);
CREATE INDEX idx_fraud_alerts_customer    ON fraud_alerts(customer_id);
CREATE INDEX idx_fraud_alerts_created     ON fraud_alerts(created_at DESC);
CREATE INDEX idx_holdings_portfolio       ON holdings(portfolio_id);
CREATE INDEX idx_holdings_ticker          ON holdings(ticker);

-- ============================================================
-- SEED DATA
-- ============================================================

-- Customers (50,000)
INSERT INTO customers (name, email, phone, birth_date, country, tier, kyc_verified)
SELECT
  '고객_' || i,
  'customer_' || i || '@fintech.test',
  '010-' || LPAD((1000 + (i % 9000))::TEXT, 4, '0') || '-' || LPAD((i % 10000)::TEXT, 4, '0'),
  ('1960-01-01'::DATE + (i % 22000) * INTERVAL '1 day')::DATE,
  CASE (i % 10) WHEN 0 THEN 'US' WHEN 1 THEN 'JP' WHEN 2 THEN 'CN' WHEN 3 THEN 'SG' ELSE 'KR' END,
  CASE
    WHEN i % 100 < 2  THEN 'VIP'
    WHEN i % 100 < 8  THEN 'PLATINUM'
    WHEN i % 100 < 20 THEN 'GOLD'
    WHEN i % 100 < 45 THEN 'SILVER'
    ELSE 'BRONZE'
  END,
  (i % 5) > 0
FROM generate_series(1, 50000) AS i;

-- Accounts (80,000)
INSERT INTO accounts (customer_id, account_number, account_type, currency, balance, credit_limit, status)
SELECT
  (1 + ((i - 1) % 50000)),
  'ACC' || LPAD(i::TEXT, 10, '0'),
  CASE (i % 4) WHEN 0 THEN 'CHECKING' WHEN 1 THEN 'SAVINGS' WHEN 2 THEN 'INVESTMENT' ELSE 'LOAN' END,
  CASE (i % 8) WHEN 0 THEN 'USD' WHEN 1 THEN 'JPY' ELSE 'KRW' END,
  ROUND((random() * 50000000)::NUMERIC, 2),
  CASE WHEN i % 3 = 0 THEN ROUND((random() * 10000000 + 1000000)::NUMERIC, 2) ELSE NULL END,
  CASE WHEN i % 50 = 0 THEN 'FROZEN' WHEN i % 200 = 0 THEN 'CLOSED' ELSE 'ACTIVE' END
FROM generate_series(1, 80000) AS i;

-- Transactions (2,000,000 — primary perf test table)
INSERT INTO transactions (account_id, transaction_type, amount, currency, balance_after, description, channel, status, created_at)
SELECT
  (1 + (i % 80000)),
  CASE (i % 7)
    WHEN 0 THEN 'DEPOSIT'       WHEN 1 THEN 'WITHDRAWAL'
    WHEN 2 THEN 'TRANSFER_IN'   WHEN 3 THEN 'TRANSFER_OUT'
    WHEN 4 THEN 'FEE'           WHEN 5 THEN 'INTEREST'
    ELSE        'LOAN_REPAYMENT'
  END,
  ROUND((random() * 5000000 + 1000)::NUMERIC, 2),
  CASE (i % 8) WHEN 0 THEN 'USD' WHEN 1 THEN 'JPY' ELSE 'KRW' END,
  ROUND((random() * 30000000)::NUMERIC, 2),
  '거래_' || i,
  CASE (i % 5) WHEN 0 THEN 'APP' WHEN 1 THEN 'WEB' WHEN 2 THEN 'ATM' WHEN 3 THEN 'BRANCH' ELSE 'API' END,
  CASE WHEN i % 100 < 2 THEN 'FAILED' WHEN i % 500 = 0 THEN 'REVERSED' ELSE 'COMPLETED' END,
  NOW() - (random() * 730 * INTERVAL '1 day')
FROM generate_series(1, 2000000) AS i;

-- Loans (30,000)
INSERT INTO loans (customer_id, loan_type, principal, outstanding, interest_rate, term_months, monthly_payment, next_payment_due, status)
SELECT
  (1 + (i % 50000)),
  CASE (i % 5) WHEN 0 THEN 'PERSONAL' WHEN 1 THEN 'MORTGAGE' WHEN 2 THEN 'AUTO' WHEN 3 THEN 'BUSINESS' ELSE 'STUDENT' END,
  ROUND((random() * 500000000 + 1000000)::NUMERIC, 2),
  ROUND((random() * 400000000 + 500000)::NUMERIC, 2),
  ROUND((0.03 + random() * 0.15)::NUMERIC, 4),
  CASE (i % 4) WHEN 0 THEN 12 WHEN 1 THEN 24 WHEN 2 THEN 60 ELSE 120 END,
  ROUND((random() * 3000000 + 50000)::NUMERIC, 2),
  (CURRENT_DATE + (i % 30 + 1)),
  CASE WHEN i % 50 = 0 THEN 'DEFAULTED' WHEN i % 100 = 0 THEN 'PAID_OFF' ELSE 'ACTIVE' END
FROM generate_series(1, 30000) AS i;

-- Portfolios (20,000)
INSERT INTO portfolios (customer_id, name, strategy)
SELECT
  (1 + (i % 50000)),
  CASE (i % 4) WHEN 0 THEN '안정형' WHEN 1 THEN '성장형' WHEN 2 THEN '인덱스' ELSE '공격형' END,
  CASE (i % 4) WHEN 0 THEN 'CONSERVATIVE' WHEN 1 THEN 'AGGRESSIVE' WHEN 2 THEN 'INDEX' ELSE 'BALANCED' END
FROM generate_series(1, 20000) AS i;

-- Holdings (100,000)
INSERT INTO holdings (portfolio_id, ticker, asset_type, quantity, avg_cost, current_price)
SELECT
  (1 + (i % 20000)),
  CASE (i % 20)
    WHEN 0 THEN 'AAPL'     WHEN 1 THEN 'MSFT'     WHEN 2 THEN 'GOOGL'    WHEN 3 THEN 'AMZN'
    WHEN 4 THEN 'TSLA'     WHEN 5 THEN 'NVDA'     WHEN 6 THEN 'BTC'      WHEN 7 THEN 'ETH'
    WHEN 8 THEN '005930'   WHEN 9 THEN '000660'   WHEN 10 THEN 'SPY'     WHEN 11 THEN 'QQQ'
    WHEN 12 THEN 'VTI'     WHEN 13 THEN 'BND'     WHEN 14 THEN 'GLD'     WHEN 15 THEN 'SLV'
    ELSE 'STOCK_' || (i % 50)
  END,
  CASE (i % 5) WHEN 0 THEN 'STOCK' WHEN 1 THEN 'BOND' WHEN 2 THEN 'ETF' WHEN 3 THEN 'CRYPTO' ELSE 'FUND' END,
  ROUND((random() * 1000 + 1)::NUMERIC, 6),
  ROUND((random() * 1000000 + 1000)::NUMERIC, 4),
  ROUND((random() * 1000000 + 1000)::NUMERIC, 4)
FROM generate_series(1, 100000) AS i;

-- Fraud alerts (5,000)
INSERT INTO fraud_alerts (transaction_id, customer_id, rule_name, risk_score, status, created_at)
SELECT
  (1 + (i % 2000000)),
  (1 + (i % 50000)),
  CASE (i % 6)
    WHEN 0 THEN 'LARGE_TRANSACTION'         WHEN 1 THEN 'UNUSUAL_LOCATION'
    WHEN 2 THEN 'RAPID_SUCCESSION'          WHEN 3 THEN 'DORMANT_ACCOUNT_ACTIVITY'
    WHEN 4 THEN 'VELOCITY_CHECK'            ELSE        'PATTERN_ANOMALY'
  END,
  ROUND((0.5 + random() * 0.5)::NUMERIC, 4),
  CASE (i % 4) WHEN 0 THEN 'OPEN' WHEN 1 THEN 'INVESTIGATING' WHEN 2 THEN 'RESOLVED' ELSE 'FALSE_POSITIVE' END,
  NOW() - (random() * 180 * INTERVAL '1 day')
FROM generate_series(1, 5000) AS i;

ANALYZE;
