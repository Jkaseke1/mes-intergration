-- PostInventoryTxV2 - Direct inventory transaction posting for Sage 200 Evolution
-- Deploy: run entire script in SSMS against company DB
-- FIX: pass ABS(quantity) to _bspPostStTrans. Negative qty was stored as QtyOut=-N
-- which INCREASES QtyOnHand (Sage does QtyOnHand += QtyIn - QtyOut).

USE [Hyperfeeds 2024 Live];
GO

IF OBJECT_ID(N'[dbo].[PostInventoryTxV2]', N'P') IS NOT NULL
    DROP PROCEDURE [dbo].[PostInventoryTxV2];
GO

CREATE PROCEDURE [dbo].[PostInventoryTxV2]
    @ItemCode varchar(50),
    @InventoryTransactionCode varchar(50),
    @Quantity float,
    @WHCode varchar(50),
    @LotNumber varchar(50),
    @UnitCost float,
    @ProjectID int,
    @GLAccountCode varchar(100)='',
    @Reference varchar(50)='',
    @Reference2 varchar(50)='',
    @TransactionDate datetime,
    @Description varchar(255),
    @UserName varchar(50)
AS
BEGIN
    SET NOCOUNT ON;

    declare @AutoIdxStockTrans bigint;
    declare @AutoIdxLotTrans bigint;
    declare @AutoIdxDebitTrans bigint;
    declare @AutoIdxCreditTrans bigint;
    declare @RC int;
    declare @AuditNo varchar(20);
    declare @IsBranch bit;
    declare @TxBranchID int;
    declare @AuditTemp float;
    declare @Period int;
    declare @Amount float;
    declare @StockDebit float;
    declare @StockCredit float;
    declare @ContraDebit float;
    declare @ContraCredit float;
    declare @Id varchar(10);
    declare @AutoIdx bigint;
    declare @StockInventoryAccountLink bigint;
    declare @ContraAccountLink bigint;
    declare @UOMID int;
    declare @LotID int;
    declare @HarvestItemID int;
    declare @WarehouseID int;
    declare @TransactionCodeID int;
    declare @isLotItem bit;
    declare @AbsQuantity float;

    SELECT @HarvestItemID = COALESCE((SELECT StockLink FROM StkItem WHERE Code = @ItemCode),0);
    SELECT @WarehouseID = COALESCE((SELECT WhseLink FROM Whsemst WHERE Code = @WHCode),0);
    SELECT @TransactionCodeID = COALESCE((SELECT idTrCodes FROM TrCodes WHERE iModule = 11 AND Code = @InventoryTransactionCode),0);
    SELECT @isLotItem = (SELECT bLotItem FROM StkItem WHERE StockLink = @HarvestItemID);

    DECLARE @PassedGLAccountLink bigint;
    SELECT @PassedGLAccountLink = NULLIF((SELECT AccountLink FROM Accounts WHERE Master_Sub_Account = @GLAccountCode), 0);

    IF @PassedGLAccountLink IS NOT NULL
        SELECT @ContraAccountLink = @PassedGLAccountLink;
    ELSE
    BEGIN
        IF @Quantity >= 0
            SELECT @ContraAccountLink = (SELECT Account2Link FROM TrCodes WHERE idTrCodes = @TransactionCodeID);
        ELSE
            SELECT @ContraAccountLink = (SELECT Account1Link FROM TrCodes WHERE idTrCodes = @TransactionCodeID);

        IF @ContraAccountLink IS NULL OR @ContraAccountLink = 0
            SELECT @ContraAccountLink = COALESCE(
                (SELECT Account2Link FROM TrCodes WHERE idTrCodes = @TransactionCodeID),
                (SELECT Account1Link FROM TrCodes WHERE idTrCodes = @TransactionCodeID)
            );
    END

    IF (@HarvestItemID = 0) BEGIN RaisError('Stock Code %s not found!',17,1, @ItemCode); RETURN -1; END
    IF (@WarehouseID = 0) BEGIN RaisError('WH Code %s not found!',17,1, @WHCode); RETURN -1; END
    IF (@ContraAccountLink = 0 OR @ContraAccountLink IS NULL) BEGIN RaisError('Contra account could not be resolved for transaction code %s!',17,1, @InventoryTransactionCode); RETURN -1; END
    IF (@TransactionCodeID = 0) BEGIN RaisError('Transaction Code %s not found!',17,1, @InventoryTransactionCode); RETURN -1; END
    IF ((@LotNumber = '') AND (@isLotItem = 1)) BEGIN RaisError('Stock item %s is a lot item, but no lot number was passed!',17,1, @ItemCode); RETURN -1; END
    IF (@UnitCost < 0) BEGIN RaisError('Unit cost is below zero!',17,1); RETURN -1; END

    SELECT @AbsQuantity = ABS(@Quantity),
           @Amount = CASE WHEN @UnitCost > 0 THEN ABS(@Quantity) * @UnitCost ELSE 0 END,
           @Id = 'HYPER',
           @TxBranchID = 0;

    IF @Quantity >= 0
        SELECT @StockDebit = @Amount, @StockCredit = 0, @ContraDebit = 0, @ContraCredit = @Amount;
    ELSE
        SELECT @StockDebit = 0, @StockCredit = @Amount, @ContraDebit = @Amount, @ContraCredit = 0;

    SELECT @StockInventoryAccountLink = COALESCE(
        (SELECT G.StockAccLink
         FROM _etblStockDetails SD
         LEFT JOIN GrpTbl G ON G.idGrpTbl = SD.GroupID
         WHERE SD.StockID = @HarvestItemID AND SD.WhseID = @WarehouseID),
        (SELECT G.StockAccLink
         FROM _etblStockDetails SD
         LEFT JOIN GrpTbl G ON G.idGrpTbl = SD.GroupID
         WHERE SD.StockID = @HarvestItemID AND SD.WhseID = -1),
        (CASE
            WHEN @Quantity >= 0 THEN (SELECT Account1Link FROM TrCodes WHERE idTrCodes = @TransactionCodeID)
            ELSE (SELECT Account2Link FROM TrCodes WHERE idTrCodes = @TransactionCodeID)
        END)
    );

    SELECT @UOMID = iUOMStockingUnitID FROM StkItem WHERE StockLink = @HarvestItemID;

    EXEC @AuditTemp = _bspNextAuditNo;
    SELECT @AuditNo = CASE WHEN @IsBranch = 1 THEN Cast(@TxBranchID as varchar(20)) + '.' + CAST(@AuditTemp as varchar) + '.0001' ELSE CAST(@AuditTemp as varchar) + '.0001' END;

    SELECT @Period = (SELECT MAX(idPeriod) + 1 FROM _etblPeriod WHERE dPeriodDate < @TransactionDate);

    IF((@LotNumber != '') AND (@isLotItem = 1))
    BEGIN
        EXECUTE @LotID = _espLTPostLots
            @WarehouseID,
            @LotNumber,
            @HarvestItemID,
            '9999-01-01',
            @AbsQuantity,
            5,
            @TransactionDate,
            0,
            @Reference,
            @Reference2,
            @TransactionCodeID,
            @AuditNo,
            -1,
            0,
            0,
            @TxBranchID
    END
    ELSE
        SELECT @LotID = 0

    -- CRITICAL: ABS quantity only. Direction via StockDebit/StockCredit.
    EXECUTE @RC = _bspPostStTrans
        @AutoIdxStockTrans OUTPUT,
        @TransactionDate,
        @Id,
        @HarvestItemID,
        @TransactionCodeID,
        @StockDebit,
        @StockCredit,
        @Description,
        0,
        @Reference,
        '',
        '',
        @AuditNo,
        0,
        @ProjectID,
        @AbsQuantity,
        @UnitCost,
        @WarehouseID,
        0,
        0,
        0,
        @UserName,
        1,
        1,
        0,
        @Reference2,
        0,
        @LotID,
        0,
        1,
        @StockDebit,
        @StockCredit,
        0,
        0,
        0,
        0,
        1,
        0,
        @ContraAccountLink,
        0,
        '',
        @TxBranchID,
        0,
        0,
        0,
        '',
        0,
        0,
        0;

    SELECT @AutoIdx = 0;
    EXECUTE @RC = _bspPostGLTrans
        @AutoIdx OUTPUT,
        @TransactionDate,
        @Id,
        @ContraAccountLink,
        @TransactionCodeID,
        @ContraDebit,
        @ContraCredit,
        0,
        0,
        0,
        0,
        @Description,
        0,
        @Reference,
        '',
        '',
        @AuditNo,
        0,
        0,
        @ProjectID,
        @Period,
        0,
        0,
        0,
        0,
        @UserName,
        '',
        0,
        @Reference2,
        @TxBranchID,
        0,
        0,
        0,
        0,
        0,
        '',
        0,
        0,
        '';

    SELECT @AutoIdx = 0;
    EXECUTE @RC = _bspPostGLTrans
        @AutoIdx OUTPUT,
        @TransactionDate,
        @Id,
        @StockInventoryAccountLink,
        @TransactionCodeID,
        @StockDebit,
        @StockCredit,
        0,
        0,
        0,
        0,
        @Description,
        0,
        @Reference,
        '',
        '',
        @AuditNo,
        0,
        0,
        @ProjectID,
        @Period,
        0,
        0,
        0,
        0,
        @UserName,
        '',
        0,
        @Reference2,
        @TxBranchID,
        0,
        0,
        0,
        0,
        0,
        '',
        0,
        0,
        '';

    RETURN 0;
END;
GO
