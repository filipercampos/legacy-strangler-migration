CREATE OR ALTER PROCEDURE dbo.usp_GetCustomer
  @CustId INT,
  @CoCode NVARCHAR(10)
AS
BEGIN
  SET NOCOUNT ON;
  SELECT CUST_ID, CO_CODE, CUST_NAME, EMAIL, DOC_NUM, CUST_STAT, DT_REG, CITY, UF,
         PLAN_CD, PLAN_PRICE, LAST_UPD
    FROM dbo.TBL_CUST
   WHERE CUST_ID = @CustId AND CO_CODE = @CoCode AND CUST_STAT <> 'X';
END
GO

CREATE OR ALTER PROCEDURE dbo.usp_ListCustomers
  @CoCode NVARCHAR(10),
  @AfterId INT = 0,
  @Top INT = 50
AS
BEGIN
  SET NOCOUNT ON;
  SELECT TOP (@Top) CUST_ID, CO_CODE, CUST_NAME, EMAIL, DOC_NUM, CUST_STAT, DT_REG, CITY, UF,
         PLAN_CD, PLAN_PRICE, LAST_UPD
    FROM dbo.TBL_CUST
   WHERE CO_CODE = @CoCode AND CUST_ID > @AfterId AND CUST_STAT <> 'X'
   ORDER BY CUST_ID;
END
GO

CREATE OR ALTER PROCEDURE dbo.usp_SaveCustomer
  @CustId INT = NULL,
  @CoCode NVARCHAR(10),
  @Name NVARCHAR(200),
  @Email NVARCHAR(200) = NULL,
  @Doc NVARCHAR(20) = NULL,
  @Stat CHAR(1) = 'A',
  @City NVARCHAR(100) = NULL,
  @Uf CHAR(2) = NULL,
  @PlanCd NVARCHAR(20) = NULL,
  @PlanPrice MONEY = NULL,
  @User NVARCHAR(50) = N'legacy-app'
AS
BEGIN
  SET NOCOUNT ON;
  IF @CustId IS NULL
  BEGIN
    INSERT dbo.TBL_CUST (CO_CODE, CUST_NAME, EMAIL, DOC_NUM, CUST_STAT, DT_REG, CITY, UF,
                         PLAN_CD, PLAN_PRICE, LAST_UPD_BY)
    VALUES (@CoCode, @Name, @Email, @Doc, @Stat, CONVERT(NVARCHAR(10), GETDATE(), 103), @City, @Uf,
            @PlanCd, @PlanPrice, @User);
    SET @CustId = CAST(SCOPE_IDENTITY() AS INT);
  END
  ELSE
  BEGIN
    UPDATE dbo.TBL_CUST
       SET CUST_NAME = @Name, EMAIL = @Email, DOC_NUM = @Doc, CUST_STAT = @Stat, CITY = @City,
           UF = @Uf, PLAN_CD = @PlanCd, PLAN_PRICE = @PlanPrice, LAST_UPD_BY = @User
     WHERE CUST_ID = @CustId AND CO_CODE = @CoCode AND CUST_STAT <> 'X';
    IF @@ROWCOUNT = 0 THROW 50404, 'customer not found', 1;
  END
  EXEC dbo.usp_GetCustomer @CustId = @CustId, @CoCode = @CoCode;
END
GO

CREATE OR ALTER PROCEDURE dbo.usp_GetCustomerInvoices
  @CustId INT,
  @CoCode NVARCHAR(10)
AS
BEGIN
  SET NOCOUNT ON;
  SELECT INV_ID, CUST_ID, CO_CODE, CUST_NAME, REF_MONTH, DUE_DT, AMT, INV_STAT, PAY_DT, NOTES
    FROM dbo.TBL_INV
   WHERE CUST_ID = @CustId AND CO_CODE = @CoCode
   ORDER BY INV_ID;
END
GO

CREATE OR ALTER PROCEDURE dbo.usp_CreateInvoice
  @CustId INT,
  @CoCode NVARCHAR(10),
  @RefMonth NVARCHAR(7),
  @DueDt NVARCHAR(8),
  @Amt MONEY,
  @Notes NVARCHAR(MAX) = NULL
AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @Name NVARCHAR(200);
  -- No existence check: this is how orphan invoices got into production.
  SELECT @Name = CUST_NAME FROM dbo.TBL_CUST WHERE CUST_ID = @CustId;
  INSERT dbo.TBL_INV (CUST_ID, CO_CODE, CUST_NAME, REF_MONTH, DUE_DT, AMT, INV_STAT, NOTES, LAST_UPD)
  VALUES (@CustId, @CoCode, @Name, @RefMonth, @DueDt, @Amt, 0, @Notes, GETDATE());
  DECLARE @InvId INT = CAST(SCOPE_IDENTITY() AS INT);
  SELECT INV_ID, CUST_ID, CO_CODE, CUST_NAME, REF_MONTH, DUE_DT, AMT, INV_STAT, PAY_DT, NOTES
    FROM dbo.TBL_INV WHERE INV_ID = @InvId;
END
GO

CREATE OR ALTER PROCEDURE dbo.usp_PayInvoice
  @InvId INT,
  @CoCode NVARCHAR(10),
  @PayDt NVARCHAR(8) = NULL
AS
BEGIN
  SET NOCOUNT ON;
  UPDATE dbo.TBL_INV
     SET INV_STAT = 1, PAY_DT = @PayDt, LAST_UPD = GETDATE()
   WHERE INV_ID = @InvId AND CO_CODE = @CoCode AND INV_STAT IN (0, 2);
  IF @@ROWCOUNT = 0 THROW 50409, 'invoice not payable', 1;
  SELECT INV_ID, CUST_ID, CO_CODE, CUST_NAME, REF_MONTH, DUE_DT, AMT, INV_STAT, PAY_DT, NOTES
    FROM dbo.TBL_INV WHERE INV_ID = @InvId;
END
GO

-- Nightly job (SQL Agent in production): marks overdue invoices and blocks customers
-- with an invoice more than 30 days late.
CREATE OR ALTER PROCEDURE dbo.usp_MarkOverdue
  @Today NVARCHAR(8) = NULL
AS
BEGIN
  SET NOCOUNT ON;
  SET @Today = COALESCE(@Today, CONVERT(NVARCHAR(8), GETDATE(), 112));
  UPDATE dbo.TBL_INV SET INV_STAT = 2, LAST_UPD = GETDATE()
   WHERE INV_STAT = 0 AND DUE_DT < @Today;
  UPDATE c SET CUST_STAT = 'B', LAST_UPD_BY = N'usp_MarkOverdue'
    FROM dbo.TBL_CUST c
   WHERE c.CUST_STAT = 'A'
     AND EXISTS (SELECT 1 FROM dbo.TBL_INV i
                  WHERE i.CUST_ID = c.CUST_ID AND i.INV_STAT = 2
                    AND i.DUE_DT < CONVERT(NVARCHAR(8), DATEADD(DAY, -30, CONVERT(DATE, @Today, 112)), 112));
END
GO
