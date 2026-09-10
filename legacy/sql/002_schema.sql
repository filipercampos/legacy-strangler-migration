-- Legacy billing schema, reproduced with its smells on purpose:
--   * dates stored as nvarchar in two different formats,
--   * magic status codes (CHAR(1) for customers, TINYINT for invoices),
--   * customer name denormalized into invoices and kept in sync by a trigger,
--   * no foreign key between invoices and customers (orphans exist),
--   * plan price copied into the customer row from a plan table that no longer exists.

IF OBJECT_ID(N'dbo.TBL_CUST', N'U') IS NULL
CREATE TABLE dbo.TBL_CUST (
  CUST_ID      INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_TBL_CUST PRIMARY KEY,
  CO_CODE      NVARCHAR(10)  NOT NULL,              -- tenant (company) code
  CUST_NAME    NVARCHAR(200) NULL,
  EMAIL        NVARCHAR(200) NULL,
  DOC_NUM      NVARCHAR(20)  NULL,                  -- CPF/CNPJ, with or without punctuation
  CUST_STAT    CHAR(1)       NOT NULL CONSTRAINT DF_CUST_STAT DEFAULT ('A'),
                                                    -- A active, B blocked (non-payment),
                                                    -- S suspended (customer request), C cancelled, X deleted
  DT_REG       NVARCHAR(10)  NULL,                  -- 'DD/MM/YYYY' (older rows: 'YYYY-MM-DD' or '')
  CITY         NVARCHAR(100) NULL,
  UF           CHAR(2)       NULL,
  PLAN_CD      NVARCHAR(20)  NULL,
  PLAN_PRICE   MONEY         NULL,
  LAST_UPD     DATETIME      NULL,                  -- maintained by TRG_CUST_AUDIT
  LAST_UPD_BY  NVARCHAR(50)  NULL
);
GO

IF OBJECT_ID(N'dbo.TBL_INV', N'U') IS NULL
CREATE TABLE dbo.TBL_INV (
  INV_ID       INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_TBL_INV PRIMARY KEY,
  CUST_ID      INT           NOT NULL,              -- no FK: orphan invoices exist in production
  CO_CODE      NVARCHAR(10)  NOT NULL,
  CUST_NAME    NVARCHAR(200) NULL,                  -- denormalized copy of TBL_CUST.CUST_NAME
  REF_MONTH    NVARCHAR(7)   NOT NULL,              -- 'MM/YYYY'
  DUE_DT       NVARCHAR(8)   NOT NULL,              -- 'YYYYMMDD'
  AMT          MONEY         NOT NULL,
  INV_STAT     TINYINT       NOT NULL CONSTRAINT DF_INV_STAT DEFAULT (0),
                                                    -- 0 open, 1 paid, 2 overdue (nightly job),
                                                    -- 7 written off, 9 cancelled
  PAY_DT       NVARCHAR(8)   NULL,                  -- 'YYYYMMDD'; unpaid is NULL, '' or '00000000'
  NOTES        NVARCHAR(MAX) NULL,
  LAST_UPD     DATETIME      NULL
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_TBL_INV_CUST')
  CREATE INDEX IX_TBL_INV_CUST ON dbo.TBL_INV (CUST_ID);
GO

IF NOT EXISTS (SELECT 1 FROM sys.change_tracking_tables WHERE object_id = OBJECT_ID(N'dbo.TBL_CUST'))
  ALTER TABLE dbo.TBL_CUST ENABLE CHANGE_TRACKING WITH (TRACK_COLUMNS_UPDATED = OFF);
GO

IF NOT EXISTS (SELECT 1 FROM sys.change_tracking_tables WHERE object_id = OBJECT_ID(N'dbo.TBL_INV'))
  ALTER TABLE dbo.TBL_INV ENABLE CHANGE_TRACKING WITH (TRACK_COLUMNS_UPDATED = OFF);
GO
