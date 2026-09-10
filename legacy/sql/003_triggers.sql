-- Triggers hold business rules nobody documented. The migration has to find and move them.
-- Both triggers stand down when the session is the modern -> legacy reverse sync
-- (SESSION_CONTEXT 'sync_origin' = 'modern'), otherwise their own UPDATEs would be
-- recorded by Change Tracking without the sync context and echo back to PostgreSQL.

CREATE OR ALTER TRIGGER dbo.TRG_CUST_AUDIT ON dbo.TBL_CUST
AFTER INSERT, UPDATE
AS
BEGIN
  SET NOCOUNT ON;
  IF CAST(SESSION_CONTEXT(N'sync_origin') AS NVARCHAR(20)) = N'modern' RETURN;

  UPDATE c
     SET LAST_UPD = GETDATE()
    FROM dbo.TBL_CUST c
    JOIN inserted i ON i.CUST_ID = c.CUST_ID;

  -- Keep the denormalized customer name on invoices in sync.
  IF UPDATE(CUST_NAME)
    UPDATE inv
       SET CUST_NAME = i.CUST_NAME,
           LAST_UPD = GETDATE()
      FROM dbo.TBL_INV inv
      JOIN inserted i ON i.CUST_ID = inv.CUST_ID
      JOIN deleted d ON d.CUST_ID = i.CUST_ID
     WHERE ISNULL(d.CUST_NAME, N'') <> ISNULL(i.CUST_NAME, N'');
END
GO

CREATE OR ALTER TRIGGER dbo.TRG_INV_PAID ON dbo.TBL_INV
AFTER UPDATE
AS
BEGIN
  SET NOCOUNT ON;
  IF CAST(SESSION_CONTEXT(N'sync_origin') AS NVARCHAR(20)) = N'modern' RETURN;

  -- Stamp the payment date when an invoice flips to paid without one.
  UPDATE inv
     SET PAY_DT = CONVERT(NVARCHAR(8), GETDATE(), 112),
         LAST_UPD = GETDATE()
    FROM dbo.TBL_INV inv
    JOIN inserted i ON i.INV_ID = inv.INV_ID
    JOIN deleted d ON d.INV_ID = i.INV_ID
   WHERE i.INV_STAT = 1 AND d.INV_STAT <> 1
     AND (i.PAY_DT IS NULL OR i.PAY_DT IN (N'', N'00000000'));

  -- Hidden rule: a blocked customer is unblocked once no overdue invoice remains.
  -- This writes to TBL_CUST from an invoice operation (see risk R-03 in the risk register).
  UPDATE c
     SET CUST_STAT = 'A',
         LAST_UPD_BY = N'TRG_INV_PAID'
    FROM dbo.TBL_CUST c
   WHERE c.CUST_STAT = 'B'
     AND c.CUST_ID IN (SELECT i.CUST_ID FROM inserted i WHERE i.INV_STAT = 1)
     AND NOT EXISTS (SELECT 1 FROM dbo.TBL_INV o WHERE o.CUST_ID = c.CUST_ID AND o.INV_STAT = 2);
END
GO
