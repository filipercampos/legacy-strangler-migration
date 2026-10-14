-- Reverse sync (modern -> legacy). Only used while the modern service owns customer writes
-- for a tenant (ADR 0003). Deployed with the reverse-sync worker, removed at decommission.

CREATE OR ALTER PROCEDURE dbo.usp_SyncCustomerFromModern
  @CustId INT,
  @CoCode NVARCHAR(10),
  @Name NVARCHAR(200),
  @Email NVARCHAR(200) = NULL,
  @Doc NVARCHAR(20) = NULL,
  @Stat CHAR(1),
  @DtReg NVARCHAR(10) = NULL,
  @City NVARCHAR(100) = NULL,
  @Uf CHAR(2) = NULL,
  @PlanCd NVARCHAR(20) = NULL,
  @PlanPrice MONEY = NULL
AS
BEGIN
  SET NOCOUNT ON;
  SET XACT_ABORT ON;
  DECLARE @ctx VARBINARY(128) = CAST('modern-sync' AS VARBINARY(128));
  EXEC sp_set_session_context @key = N'sync_origin', @value = N'modern';
  BEGIN TRY
    BEGIN TRANSACTION;
    IF EXISTS (SELECT 1 FROM dbo.TBL_CUST WITH (UPDLOCK, HOLDLOCK) WHERE CUST_ID = @CustId)
    BEGIN
      WITH CHANGE_TRACKING_CONTEXT (@ctx)
      UPDATE dbo.TBL_CUST
         SET CO_CODE = @CoCode, CUST_NAME = @Name, EMAIL = @Email, DOC_NUM = @Doc,
             CUST_STAT = @Stat, CITY = @City, UF = @Uf, PLAN_CD = @PlanCd,
             PLAN_PRICE = @PlanPrice, LAST_UPD = GETDATE(), LAST_UPD_BY = N'modern-sync'
       WHERE CUST_ID = @CustId;
    END
    ELSE
    BEGIN
      -- Explicit ids come from the modern id range. IDENTITY_INSERT bumps the identity
      -- seed to the inserted value, so the seed is restored under a table lock to keep
      -- legacy inserts in the legacy range.
      DECLARE @seed INT;
      SELECT @seed = MAX(CUST_ID) FROM dbo.TBL_CUST WITH (TABLOCKX, HOLDLOCK) WHERE CUST_ID < 50000000;
      SET IDENTITY_INSERT dbo.TBL_CUST ON;
      WITH CHANGE_TRACKING_CONTEXT (@ctx)
      INSERT dbo.TBL_CUST (CUST_ID, CO_CODE, CUST_NAME, EMAIL, DOC_NUM, CUST_STAT, DT_REG, CITY, UF,
                           PLAN_CD, PLAN_PRICE, LAST_UPD, LAST_UPD_BY)
      VALUES (@CustId, @CoCode, @Name, @Email, @Doc, @Stat, @DtReg, @City, @Uf, @PlanCd, @PlanPrice,
              GETDATE(), N'modern-sync');
      SET IDENTITY_INSERT dbo.TBL_CUST OFF;
      SET @seed = COALESCE(@seed, 0);
      DBCC CHECKIDENT ('dbo.TBL_CUST', RESEED, @seed) WITH NO_INFOMSGS;
    END;

    -- The audit trigger stands down for this session, so propagate the name here.
    WITH CHANGE_TRACKING_CONTEXT (@ctx)
    UPDATE dbo.TBL_INV SET CUST_NAME = @Name, LAST_UPD = GETDATE()
     WHERE CUST_ID = @CustId AND ISNULL(CUST_NAME, N'') <> ISNULL(@Name, N'');
    COMMIT TRANSACTION;
  END TRY
  BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    EXEC sp_set_session_context @key = N'sync_origin', @value = NULL;
    THROW;
  END CATCH;
  EXEC sp_set_session_context @key = N'sync_origin', @value = NULL;
END
GO
