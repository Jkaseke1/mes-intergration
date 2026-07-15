-- PostGRVV2 - GRV-specific posting with Trade Payables credit + cost revaluation
-- Matches pre-MES Sage GRV pattern:
--   1. Debit Stock Account, Credit Trade Payables (stock receipt at GRN cost)
--   2. Debit/Credit Purchase Cost Variance, Credit/Debit Stock Account (cost revaluation)
--
-- Based on PostInventoryTxV2 but adds:
--   - Trade Payables as contra (instead of generic GRN Accrual)
--   - Cost revaluation across all warehouses holding the item
--   - Updates fAverageCost for all warehouses

CREATE PROCEDURE [dbo].[PostGRVV2]
    @ItemCode varchar(50),
    @InventoryTransactionCode varchar(50),
    @Quantity float,
    @WHCode varchar(50),
    @LotNumber varchar(50),
    @UnitCost float,
    @ProjectID int,
    @TradePayablesAccountCode varchar(100)='',
    @VarianceAccountCode varchar(100)='',
    @Reference varchar(50)='',
    @Reference2 varchar(50)='',
    @TransactionDate datetime,
    @Description varchar(255),
    @UserName varchar(50)
AS
BEGIN
    SET NOCOUNT ON;

    -- Declares
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
    declare @VarianceDebit float;
    declare @VarianceCredit float;
    declare @Id varchar(10);
    declare @AutoIdx bigint;
    declare @StockInventoryAccountLink bigint;
    declare @ContraAccountLink bigint;
    declare @VarianceAccountLink bigint;
    declare @UOMID int;
    declare @LotID int;
    declare @HarvestItemID int;
    declare @WarehouseID int;
    declare @TransactionCodeID int;
    declare @isLotItem bit;
    declare @AbsQuantity float;

    -- Cost revaluation variables
    declare @OldTotalQty float;
    declare @OldTotalValue float;
    declare @OldWeightedAvg float;
    declare @NewTotalQty float;
    declare @NewTotalValue float;
    declare @NewWeightedAvg float;
    declare @VarianceAmount float;
    declare @AbsVariance float;

    -- Prefetch data
    SELECT @HarvestItemID = COALESCE((SELECT StockLink FROM StkItem WHERE Code = @ItemCode),0);
    SELECT @WarehouseID = COALESCE((SELECT WhseLink FROM Whsemst WHERE Code = @WHCode),0);
    SELECT @TransactionCodeID = COALESCE((SELECT idTrCodes FROM TrCodes WHERE iModule = 11 AND Code = @InventoryTransactionCode),0);
    SELECT @isLotItem = (SELECT bLotItem FROM StkItem WHERE StockLink = @HarvestItemID);

    -- Resolve Trade Payables (contra) account:
    -- 1. If explicit TradePayablesAccountCode provided and exists, use it
    -- 2. Fall back to TrCodes.Account2Link (GRN Accrual)
    DECLARE @PassedPayablesLink bigint;
    SELECT @PassedPayablesLink = NULLIF((SELECT AccountLink FROM Accounts WHERE Master_Sub_Account = @TradePayablesAccountCode), 0);

    IF @PassedPayablesLink IS NOT NULL
    BEGIN
        SELECT @ContraAccountLink = @PassedPayablesLink;
    END
    ELSE
    BEGIN
        -- Fall back to TrCodes Account2Link (original GRN Accrual behavior)
        SELECT @ContraAccountLink = (SELECT Account2Link FROM TrCodes WHERE idTrCodes = @TransactionCodeID);
        IF @ContraAccountLink IS NULL OR @ContraAccountLink = 0
            SELECT @ContraAccountLink = COALESCE(
                (SELECT Account1Link FROM TrCodes WHERE idTrCodes = @TransactionCodeID),
                0
            );
    END

    -- Resolve Variance account (Purchase Cost Variance):
    -- 1. If explicit VarianceAccountCode provided and exists, use it
    -- 2. Fall back to TrCodes.Account1Link (stock account — not ideal but safe)
    DECLARE @PassedVarianceLink bigint;
    SELECT @PassedVarianceLink = NULLIF((SELECT AccountLink FROM Accounts WHERE Master_Sub_Account = @VarianceAccountCode), 0);

    IF @PassedVarianceLink IS NOT NULL
    BEGIN
        SELECT @VarianceAccountLink = @PassedVarianceLink;
    END
    ELSE
    BEGIN
        -- No variance account specified — skip variance posting
        SELECT @VarianceAccountLink = 0;
    END

    -- Early outs
    IF (@HarvestItemID = 0) BEGIN RaisError('Stock Code %s not found!',17,1, @ItemCode); RETURN -1; END
    IF (@WarehouseID = 0) BEGIN RaisError('WH Code %s not found!',17,1, @WHCode); RETURN -1; END
    IF (@ContraAccountLink = 0 OR @ContraAccountLink IS NULL) BEGIN RaisError('Trade Payables account could not be resolved!',17,1); RETURN -1; END
    IF (@TransactionCodeID = 0) BEGIN RaisError('Transaction Code %s not found!',17,1, @InventoryTransactionCode); RETURN -1; END
    IF ((@LotNumber = '') AND (@isLotItem = 1)) BEGIN RaisError('Stock item %s is a lot item, but no lot number was passed!',17,1, @ItemCode); RETURN -1; END
    IF (@UnitCost < 0) BEGIN RaisError('Unit cost is below zero!',17,1); RETURN -1; END

    -- ========================================================================
    -- STEP 1: Capture old stock state for cost revaluation
    -- ========================================================================
    SELECT
        @OldTotalQty = COALESCE(SUM(QtyOnHand), 0),
        @OldTotalValue = COALESCE(SUM(QtyOnHand * fAverageCost), 0)
    FROM WhseStk
    WHERE WHStockLink = @HarvestItemID
      AND QtyOnHand > 0;

    IF @OldTotalQty > 0
        SELECT @OldWeightedAvg = @OldTotalValue / @OldTotalQty;
    ELSE
        SELECT @OldWeightedAvg = @UnitCost;

    -- ========================================================================
    -- STEP 2: Post stock receipt (same as PostInventoryTxV2)
    -- ========================================================================
    SELECT @AbsQuantity = ABS(@Quantity),
           @Amount = CASE WHEN @UnitCost > 0 THEN ABS(@Quantity) * @UnitCost ELSE 0 END,
           @Id = 'HYPER',
           @TxBranchID = 0;

    -- Stock IN: debit stock, credit contra (Trade Payables)
    SELECT @StockDebit = @Amount, @StockCredit = 0, @ContraDebit = 0, @ContraCredit = @Amount;

    -- Get Stock Account Link for Item from warehouse-specific stock group
    SELECT @StockInventoryAccountLink = COALESCE(
        (SELECT G.StockAccLink
         FROM _etblStockDetails SD
         LEFT JOIN GrpTbl G ON G.idGrpTbl = SD.GroupID
         WHERE SD.StockID = @HarvestItemID AND SD.WhseID = @WarehouseID),
        (SELECT G.StockAccLink
         FROM _etblStockDetails SD
         LEFT JOIN GrpTbl G ON G.idGrpTbl = SD.GroupID
         WHERE SD.StockID = @HarvestItemID AND SD.WhseID = -1),
        (SELECT Account1Link FROM TrCodes WHERE idTrCodes = @TransactionCodeID)
    );

    SELECT @UOMID = iUOMStockingUnitID FROM StkItem WHERE StockLink = @HarvestItemID;

    -- Get audit number
    EXEC @AuditTemp = _bspNextAuditNo;
    SELECT @AuditNo = CASE WHEN @IsBranch = 1 THEN Cast(@TxBranchID as varchar(20)) + '.' + CAST(@AuditTemp as varchar) + '.0001' ELSE CAST(@AuditTemp as varchar) + '.0001' END;

    -- Get period
    SELECT @Period = (SELECT MAX(idPeriod) + 1 FROM _etblPeriod WHERE dPeriodDate < @TransactionDate);

    -- Book Lot adjustment
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
    BEGIN
        SELECT @LotID = 0
    END

    -- Book stock adjustment (updates QtyOnHand + fAverageCost for receiving warehouse)
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
        @Quantity,
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

    -- Book Trade Payables (contra) GL entry — Credit Trade Payables
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

    -- Book Stock inventory GL entry — Debit Stock Account
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

    -- ========================================================================
    -- STEP 3: Calculate and post cost revaluation
    -- ========================================================================
    IF @VarianceAccountLink > 0 AND @OldTotalQty > 0
    BEGIN
        -- Calculate new weighted average cost
        SELECT
            @NewTotalQty = @OldTotalQty + @AbsQuantity,
            @NewTotalValue = @OldTotalValue + @Amount,
            @NewWeightedAvg = CASE WHEN @NewTotalQty > 0 THEN @NewTotalValue / @NewTotalQty ELSE @UnitCost END;

        -- Variance = old stock revalued from old avg to new avg
        -- Positive = stock value increased (new cost > old cost) → Debit Stock, Credit Variance
        -- Negative = stock value decreased (new cost < old cost) → Debit Variance, Credit Stock
        SELECT @VarianceAmount = @OldTotalQty * (@NewWeightedAvg - @OldWeightedAvg);
        SELECT @AbsVariance = ABS(@VarianceAmount);

        IF @AbsVariance > 0.01  -- Only post if variance is material
        BEGIN
            -- Get a new audit number for variance entries
            EXEC @AuditTemp = _bspNextAuditNo;
            SELECT @AuditNo = CAST(@AuditTemp as varchar) + '.0001';

            IF @VarianceAmount > 0
            BEGIN
                -- Stock value increased: Debit Stock, Credit Variance
                SELECT @VarianceDebit = 0, @VarianceCredit = @AbsVariance;
                SELECT @StockDebit = @AbsVariance, @StockCredit = 0;
            END
            ELSE
            BEGIN
                -- Stock value decreased: Debit Variance, Credit Stock
                SELECT @VarianceDebit = @AbsVariance, @VarianceCredit = 0;
                SELECT @StockDebit = 0, @StockCredit = @AbsVariance;
            END

            -- Post Variance GL entry (Purchase Cost Variance)
            SELECT @AutoIdx = 0;
            EXECUTE @RC = _bspPostGLTrans
                @AutoIdx OUTPUT,
                @TransactionDate,
                @Id,
                @VarianceAccountLink,
                @TransactionCodeID,
                @VarianceDebit,
                @VarianceCredit,
                0, 0, 0, 0,
                @Description + ' (Cost Revaluation)',
                0,
                @Reference,
                '', '',
                @AuditNo,
                0, 0,
                @ProjectID,
                @Period,
                0, 0, 0, 0,
                @UserName,
                '', 0,
                @Reference2,
                @TxBranchID,
                0, 0, 0, 0, 0,
                '', 0, 0, '';

            -- Post Stock adjustment GL entry (revaluation of existing stock)
            SELECT @AutoIdx = 0;
            EXECUTE @RC = _bspPostGLTrans
                @AutoIdx OUTPUT,
                @TransactionDate,
                @Id,
                @StockInventoryAccountLink,
                @TransactionCodeID,
                @StockDebit,
                @StockCredit,
                0, 0, 0, 0,
                @Description + ' (Cost Revaluation)',
                0,
                @Reference,
                '', '',
                @AuditNo,
                0, 0,
                @ProjectID,
                @Period,
                0, 0, 0, 0,
                @UserName,
                '', 0,
                @Reference2,
                @TxBranchID,
                0, 0, 0, 0, 0,
                '', 0, 0, '';

            -- Update fAverageCost for ALL warehouses holding this item
            UPDATE WhseStk
            SET fAverageCost = @NewWeightedAvg,
                fWhseLastGRVCost = @UnitCost
            WHERE WHStockLink = @HarvestItemID
              AND WHQtyOnHand > 0;

            -- Also update the item-level average cost
            UPDATE StkItem
            SET fItemLastGRVCost = @UnitCost
            WHERE StockLink = @HarvestItemID;
        END
    END

    RETURN 0;
END;
