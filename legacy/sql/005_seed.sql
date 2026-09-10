-- Deterministic seed with the data-quality problems found in the production extract:
-- mixed date formats, invalid dates, punctuated and garbage documents, padded upper-case
-- e-mails, soft-deleted rows, paid invoices without a payment date and orphan invoices.
-- $(SEED_CUSTOMERS) is substituted by the script runner.
SET NOCOUNT ON;
IF NOT EXISTS (SELECT 1 FROM dbo.TBL_CUST)
BEGIN
  DECLARE @n INT = $(SEED_CUSTOMERS);

  ;WITH nums AS (
    SELECT TOP (@n) CAST(ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS INT) AS k
      FROM sys.all_objects a CROSS JOIN sys.all_objects b
  ),
  base AS (
    SELECT k,
           RIGHT(CONCAT(N'00000000000', CAST(10000000000 + CAST(k AS BIGINT) * 7919 AS NVARCHAR(20))), 11) AS cpf,
           RIGHT(CONCAT(N'00000000000000', CAST(10000000000000 + CAST(k AS BIGINT) * 104729 AS NVARCHAR(20))), 14) AS cnpj,
           DATEADD(DAY, -(k % 3650), CAST('2026-08-31' AS DATE)) AS reg
      FROM nums
  )
  INSERT dbo.TBL_CUST (CO_CODE, CUST_NAME, EMAIL, DOC_NUM, CUST_STAT, DT_REG, CITY, UF, PLAN_CD, PLAN_PRICE, LAST_UPD_BY)
  SELECT CHOOSE(k % 3 + 1, N'ACME', N'GLOBEX', N'INITECH'),
         CONCAT(N'Customer ', k),
         CASE WHEN k % 17 = 0 THEN CONCAT(N' CUSTOMER', k, N'@EXAMPLE.COM ')
              ELSE CONCAT(N'customer', k, N'@example.com') END,
         CASE WHEN k % 97 = 0 THEN N'ISENTO'
              WHEN k % 10 = 0 THEN CONCAT(SUBSTRING(cnpj, 1, 2), N'.', SUBSTRING(cnpj, 3, 3), N'.', SUBSTRING(cnpj, 6, 3), N'/', SUBSTRING(cnpj, 9, 4), N'-', SUBSTRING(cnpj, 13, 2))
              WHEN k % 4 = 0 THEN CONCAT(SUBSTRING(cpf, 1, 3), N'.', SUBSTRING(cpf, 4, 3), N'.', SUBSTRING(cpf, 7, 3), N'-', SUBSTRING(cpf, 10, 2))
              ELSE cpf END,
         CASE WHEN k % 199 = 0 THEN 'X'
              WHEN k % 50 = 0 THEN 'C'
              WHEN k % 31 = 0 THEN 'S'
              WHEN k % 23 = 0 THEN 'B'
              ELSE 'A' END,
         CASE WHEN k % 257 = 0 THEN N'31/02/2019'
              WHEN k % 113 = 0 THEN N''
              WHEN k % 20 = 0 THEN CONVERT(NVARCHAR(10), reg, 23)
              ELSE CONVERT(NVARCHAR(10), reg, 103) END,
         CHOOSE(k % 4 + 1, N'Sao Paulo', N'Rio de Janeiro', N'Belo Horizonte', N'Curitiba'),
         CHOOSE(k % 4 + 1, 'SP', 'RJ', 'MG', 'PR'),
         CHOOSE(k % 3 + 1, N'BASIC', N'PRO', N'ENTERPRISE'),
         CHOOSE(k % 3 + 1, 49.90, 99.90, 499.00),
         N'seed'
    FROM base;

  -- Four monthly invoices per customer (05/2026 .. 08/2026).
  INSERT dbo.TBL_INV (CUST_ID, CO_CODE, CUST_NAME, REF_MONTH, DUE_DT, AMT, INV_STAT, PAY_DT, NOTES, LAST_UPD)
  SELECT c.CUST_ID, c.CO_CODE, c.CUST_NAME,
         CONCAT(N'0', 4 + m.i, N'/2026'),
         CONCAT(N'20260', 4 + m.i, N'10'),
         c.PLAN_PRICE,
         st.code,
         CASE WHEN st.code = 1 AND c.CUST_ID % 13 = 0 THEN N''
              WHEN st.code = 1 THEN CONCAT(N'20260', 4 + m.i, N'08')
              WHEN c.CUST_ID % 2 = 0 THEN N'00000000'
              ELSE NULL END,
         CASE WHEN c.CUST_ID % 29 = 0 THEN N'renegotiated by phone' ELSE NULL END,
         GETDATE()
    FROM dbo.TBL_CUST c
   CROSS JOIN (VALUES (1), (2), (3), (4)) AS m(i)
   CROSS APPLY (SELECT CASE
                  WHEN m.i = 1 AND c.CUST_ID % 41 = 0 THEN 9
                  WHEN m.i = 1 AND c.CUST_ID % 43 = 0 THEN 7
                  WHEN m.i < 4 THEN 1
                  WHEN c.CUST_STAT = 'B' THEN 2
                  ELSE 0 END AS code) AS st;

  -- Orphans: invoices whose customer never existed (no FK in the legacy schema).
  INSERT dbo.TBL_INV (CUST_ID, CO_CODE, CUST_NAME, REF_MONTH, DUE_DT, AMT, INV_STAT, LAST_UPD)
  SELECT 900000 + v.k, N'ACME', NULL, N'07/2026', N'20260710', 10.00, 0, GETDATE()
    FROM (VALUES (1), (2), (3), (4), (5)) AS v(k);
END
GO
