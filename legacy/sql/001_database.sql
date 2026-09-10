-- Runs against master. $(DB_NAME) is substituted by the script runner (sqlcmd-style variable).
IF DB_ID(N'$(DB_NAME)') IS NULL
  CREATE DATABASE [$(DB_NAME)];
GO

-- Change Tracking: synchronous, lightweight, no SQL Server Agent required (works on RDS).
-- Retention bounds how long the sync worker may be down before a re-backfill is needed.
IF NOT EXISTS (SELECT 1 FROM sys.change_tracking_databases WHERE database_id = DB_ID(N'$(DB_NAME)'))
  ALTER DATABASE [$(DB_NAME)] SET CHANGE_TRACKING = ON (CHANGE_RETENTION = 3 DAYS, AUTO_CLEANUP = ON);
GO

-- Snapshot isolation lets the sync worker read CHANGETABLE and the base tables consistently.
ALTER DATABASE [$(DB_NAME)] SET ALLOW_SNAPSHOT_ISOLATION ON;
GO
