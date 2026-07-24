-- PostGRVV2 - GRV-specific posting with Trade Payables credit + cost revaluation
-- Also creates a posted GRV document in InvNum + _btblInvoiceLines so QtyOnHand
-- survives Sage stock rebuilds / relinks.
-- Deployable version: drops existing SP then creates via sp_executesql to avoid GO batch separator issues

USE [Hyperfeeds 2024 Live];

IF OBJECT_ID('[dbo].[PostGRVV2]', 'P') IS NOT NULL
    DROP PROCEDURE [dbo].[PostGRVV2];

DECLARE @sql NVARCHAR(MAX) = N'CREATE PROCEDURE [dbo].[PostGRVV2]
    @ItemCode varchar(50),
    @InventoryTransactionCode varchar(50),
    @Quantity float,
    @WHCode varchar(50),
    @LotNumber varchar(50),
    @UnitCost float,
    @ProjectID int,
    @TradePayablesAccountCode varchar(100)='''',
    @VarianceAccountCode varchar(100)='''',
    @Reference varchar(50)='''',
    @Reference2 varchar(50)='''',
    @TransactionDate datetime,
    @Description varchar(255),
    @UserName varchar(50),
    @SupplierCode varchar(50)
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

    -- GRV document variables (InvNum / _btblInvoiceLines)
    declare @NewInvID bigint;
    declare @NewLineID bigint;
    declare @GrvDocNumber varchar(50);
    declare @LineTotExcl float;
    declare @IsWhseItem bit;
    declare @UOMCategoryID int;
    declare @AgentID int;
    declare @SupplierID int = 0;

    -- Prefetch data
    SELECT @HarvestItemID = COALESCE((SELECT StockLink FROM StkItem WHERE Code = @ItemCode),0);
    SELECT @WarehouseID = COALESCE((SELECT WhseLink FROM Whsemst WHERE Code = @WHCode),0);
    SELECT @TransactionCodeID = COALESCE((SELECT idTrCodes FROM TrCodes WHERE iModule = 11 AND Code = @InventoryTransactionCode),0);
    SELECT @isLotItem = (SELECT bLotItem FROM StkItem WHERE StockLink = @HarvestItemID);
    SELECT @IsWhseItem = COALESCE((SELECT WhseItem FROM StkItem WHERE StockLink = @HarvestItemID), 0);
    -- StkItem has no iUOMCategoryID in this company DB; line default is 0
    SELECT @UOMCategoryID = 0;
    -- No Agents table in this company DB; leave agent unset
    SELECT @AgentID = 0;

    -- Resolve supplier (creditor) link for the GRV document
    IF LEN(LTRIM(RTRIM(@SupplierCode))) > 0
    BEGIN
        SELECT @SupplierID = COALESCE(
            (SELECT DCLink FROM Vendor WHERE Account = LTRIM(RTRIM(@SupplierCode))),
            0
        );
    END

    -- Resolve Trade Payables (contra) account:
    DECLARE @PassedPayablesLink bigint;
    SELECT @PassedPayablesLink = NULLIF((SELECT AccountLink FROM Accounts WHERE Master_Sub_Account = @TradePayablesAccountCode), 0);

    IF @PassedPayablesLink IS NOT NULL
    BEGIN
        SELECT @ContraAccountLink = @PassedPayablesLink;
    END
    ELSE
    BEGIN
        SELECT @ContraAccountLink = (SELECT Account2Link FROM TrCodes WHERE idTrCodes = @TransactionCodeID);
        IF @ContraAccountLink IS NULL OR @ContraAccountLink = 0
            SELECT @ContraAccountLink = COALESCE(
                (SELECT Account1Link FROM TrCodes WHERE idTrCodes = @TransactionCodeID),
                0
            );
    END

    -- Resolve Variance account (Purchase Cost Variance)
    DECLARE @PassedVarianceLink bigint;
    SELECT @PassedVarianceLink = NULLIF((SELECT AccountLink FROM Accounts WHERE Master_Sub_Account = @VarianceAccountCode), 0);

    IF @PassedVarianceLink IS NOT NULL
    BEGIN
        SELECT @VarianceAccountLink = @PassedVarianceLink;
    END
    ELSE
    BEGIN
        SELECT @VarianceAccountLink = 0;
    END

    -- Early outs
    IF (@HarvestItemID = 0) BEGIN RaisError(''Stock Code %s not found!'',17,1, @ItemCode); RETURN -1; END
    IF (@WarehouseID = 0) BEGIN RaisError(''WH Code %s not found!'',17,1, @WHCode); RETURN -1; END
    IF (@ContraAccountLink = 0 OR @ContraAccountLink IS NULL) BEGIN RaisError(''Trade Payables account could not be resolved!'',17,1); RETURN -1; END
    IF (@TransactionCodeID = 0) BEGIN RaisError(''Transaction Code %s not found!'',17,1, @InventoryTransactionCode); RETURN -1; END
    IF ((@LotNumber = '''') AND (@isLotItem = 1)) BEGIN RaisError(''Stock item %s is a lot item, but no lot number was passed!'',17,1, @ItemCode); RETURN -1; END
    IF (@UnitCost < 0) BEGIN RaisError(''Unit cost is below zero!'',17,1); RETURN -1; END

    -- ========================================================================
    -- STEP 1: Capture old stock state for cost revaluation
    -- ========================================================================
    SELECT
        @OldTotalQty = COALESCE(SUM(QtyOnHand), 0)
    FROM _etblStockQtys
    WHERE StockID = @HarvestItemID
      AND QtyOnHand > 0;

    SELECT @OldWeightedAvg = COALESCE(
        (SELECT TOP 1 AverageCost FROM _etblStockCosts WHERE StockID = @HarvestItemID AND WhseID = 0),
        0
    );

    IF @OldTotalQty > 0 AND @OldWeightedAvg > 0
        SELECT @OldTotalValue = @OldTotalQty * @OldWeightedAvg;
    ELSE
    BEGIN
        SELECT @OldTotalQty = 0;
        SELECT @OldTotalValue = 0;
        SELECT @OldWeightedAvg = @UnitCost;
    END

    -- ========================================================================
    -- STEP 2: Post stock receipt
    -- ========================================================================
    SELECT @AbsQuantity = ABS(@Quantity),
           @Amount = CASE WHEN @UnitCost > 0 THEN ABS(@Quantity) * @UnitCost ELSE 0 END,
           @Id = ''HYPER'',
           @TxBranchID = 0,
           @LineTotExcl = CASE WHEN @UnitCost > 0 THEN ABS(@Quantity) * @UnitCost ELSE 0 END;

    SELECT @StockDebit = @Amount, @StockCredit = 0, @ContraDebit = 0, @ContraCredit = @Amount;

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

    EXEC @AuditTemp = _bspNextAuditNo;
    SELECT @AuditNo = CASE WHEN @IsBranch = 1 THEN Cast(@TxBranchID as varchar(20)) + ''.'' + CAST(@AuditTemp as varchar) + ''.0001'' ELSE CAST(@AuditTemp as varchar) + ''.0001'' END;

    SELECT @Period = (SELECT MAX(idPeriod) + 1 FROM _etblPeriod WHERE dPeriodDate < @TransactionDate);

    IF((@LotNumber != '''') AND (@isLotItem = 1))
    BEGIN
        EXECUTE @LotID = _espLTPostLots
            @WarehouseID,
            @LotNumber,
            @HarvestItemID,
            ''9999-01-01'',
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
        '''',
        '''',
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
        '''',
        @TxBranchID,
        0,
        0,
        0,
        '''',
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
        '''',
        '''',
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
        '''',
        0,
        @Reference2,
        @TxBranchID,
        0,
        0,
        0,
        0,
        0,
        '''',
        0,
        0,
        '''';

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
        '''',
        '''',
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
        '''',
        0,
        @Reference2,
        @TxBranchID,
        0,
        0,
        0,
        0,
        0,
        '''',
        0,
        0,
        '''';

    -- ========================================================================
    -- STEP 2b: Create posted GRV document (InvNum + _btblInvoiceLines)
    -- Document trail only — does NOT re-post stock (already done above).
    -- ========================================================================
    BEGIN TRY
        SELECT @GrvDocNumber = CASE
            WHEN NULLIF(LTRIM(RTRIM(@Reference)), '''') IS NOT NULL THEN LEFT(LTRIM(RTRIM(@Reference)), 50)
            ELSE ''HFGRV'' + RIGHT(''000000'' + CAST(ABS(CHECKSUM(NEWID())) % 1000000 AS varchar(6)), 6)
        END;

        IF EXISTS (SELECT 1 FROM InvNum WHERE InvNumber = @GrvDocNumber AND DocType = 2)
            SELECT @GrvDocNumber = LEFT(@GrvDocNumber, 40) + ''-'' + RIGHT(''000'' + CAST(ABS(CHECKSUM(NEWID())) % 1000 AS varchar(3)), 3);

        INSERT INTO InvNum (
            DocType, DocVersion, DocState, DocFlag, OrigDocID,
            InvNumber, GrvNumber, GrvID, AccountID, Description,
            InvDate, OrderDate, DueDate, DeliveryDate,
            TaxInclusive, Email_Sent,
            DelMethodID, DocRepID, OrderNum, DeliveryNote,
            InvDisc, InvDiscReasonID,
            Message1, Message2, Message3,
            ProjectID, TillID, POSAmntTendered, POSChange,
            GrvSplitFixedCost, GrvSplitFixedAmnt,
            OrderStatusID, OrderPriorityID, ExtOrderNum, ForeignCurrencyID,
            InvDiscAmnt, InvDiscAmntEx,
            InvTotExclDEx, InvTotTaxDEx, InvTotInclDEx,
            InvTotExcl, InvTotTax, InvTotIncl,
            OrdDiscAmnt, OrdDiscAmntEx,
            OrdTotExclDEx, OrdTotTaxDEx, OrdTotInclDEx,
            OrdTotExcl, OrdTotTax, OrdTotIncl,
            bUseFixedPrices, iDocPrinted, iINVNUMAgentID, fExchangeRate,
            InvNum_dCreatedDate, InvNum_dModifiedDate
        )
        VALUES (
            2, 1, 4, 2, 0,
            @GrvDocNumber, @GrvDocNumber, 0, COALESCE(@SupplierID, 0),
            LEFT(COALESCE(@Description, @ItemCode), 50),
            @TransactionDate, @TransactionDate, @TransactionDate, @TransactionDate,
            0, 0,
            0, 0, '''', '''',
            0, 0,
            '''', '''', '''',
            COALESCE(@ProjectID, 0), 0, 0, 0,
            0, 0,
            0, 0, LEFT(COALESCE(@Reference2, ''''), 50), 0,
            0, 0,
            @LineTotExcl, 0, @LineTotExcl,
            @LineTotExcl, 0, @LineTotExcl,
            0, 0,
            @LineTotExcl, 0, @LineTotExcl,
            @LineTotExcl, 0, @LineTotExcl,
            0, 0, @AgentID, 1,
            GETDATE(), GETDATE()
        );

        SELECT @NewInvID = SCOPE_IDENTITY();

        -- Set GrvID to own AutoIndex (matches existing Sage GRV pattern)
        IF @NewInvID IS NOT NULL AND @NewInvID > 0
        BEGIN
            UPDATE InvNum SET GrvID = @NewInvID WHERE AutoIndex = @NewInvID;

            INSERT INTO _btblInvoiceLines (
                iInvoiceID, iOrigLineID, iGrvLineID, iLineDocketMode,
                cDescription,
                iUnitsOfMeasureStockingID, iUnitsOfMeasureCategoryID, iUnitsOfMeasureID,
                fQuantity, fQtyChange, fQtyToProcess, fQtyLastProcess, fQtyProcessed,
                fQtyReserved, fQtyReservedChange,
                cLineNotes,
                fUnitPriceExcl, fUnitPriceIncl, iUnitPriceOverrideReasonID,
                fUnitCost, fLineDiscount, iLineDiscountReasonID, iReturnReasonID,
                fTaxRate, bIsSerialItem, bIsWhseItem, fAddCost, cTradeinItem,
                iStockCodeID, iJobID, iWarehouseID, iTaxTypeID, iPriceListNameID,
                fQuantityLineTotIncl, fQuantityLineTotExcl,
                fQuantityLineTotInclNoDisc, fQuantityLineTotExclNoDisc,
                fQuantityLineTaxAmount, fQuantityLineTaxAmountNoDisc,
                fQtyChangeLineTotIncl, fQtyChangeLineTotExcl,
                fQtyChangeLineTotInclNoDisc, fQtyChangeLineTotExclNoDisc,
                fQtyChangeLineTaxAmount, fQtyChangeLineTaxAmountNoDisc,
                fQtyToProcessLineTotIncl, fQtyToProcessLineTotExcl,
                fQtyToProcessLineTotInclNoDisc, fQtyToProcessLineTotExclNoDisc,
                fQtyToProcessLineTaxAmount, fQtyToProcessLineTaxAmountNoDisc,
                fQtyLastProcessLineTotIncl, fQtyLastProcessLineTotExcl,
                fQtyLastProcessLineTotInclNoDisc, fQtyLastProcessLineTotExclNoDisc,
                fQtyLastProcessLineTaxAmount, fQtyLastProcessLineTaxAmountNoDisc,
                fQtyProcessedLineTotIncl, fQtyProcessedLineTotExcl,
                fQtyProcessedLineTotInclNoDisc, fQtyProcessedLineTotExclNoDisc,
                fQtyProcessedLineTaxAmount, fQtyProcessedLineTaxAmountNoDisc,
                iLineRepID, iLineProjectID, iLedgerAccountID, iModule,
                bChargeCom, bIsLotItem, iMFPID, iLineID,
                fQuantityUR, fQtyChangeUR, fQtyToProcessUR, fQtyLastProcessUR, fQtyProcessedUR,
                _btblInvoiceLines_dCreatedDate, _btblInvoiceLines_dModifiedDate
            )
            VALUES (
                @NewInvID, 0, 0, 0,
                LEFT(COALESCE(@Description, @ItemCode), 100),
                COALESCE(@UOMID, 0), COALESCE(@UOMCategoryID, 0), COALESCE(@UOMID, 0),
                @AbsQuantity, 0, 0, 0, @AbsQuantity,
                0, 0,
                LEFT(COALESCE(@Reference2, ''''), 255),
                @UnitCost, @UnitCost, 0,
                @UnitCost, 0, 0, 0,
                0, 0, @IsWhseItem, 0, '''',
                @HarvestItemID, 0, @WarehouseID, 0, 0,
                @LineTotExcl, @LineTotExcl,
                @LineTotExcl, @LineTotExcl,
                0, 0,
                0, 0,
                0, 0,
                0, 0,
                0, 0,
                0, 0,
                0, 0,
                0, 0,
                0, 0,
                0, 0,
                @LineTotExcl, @LineTotExcl,
                @LineTotExcl, @LineTotExcl,
                0, 0,
                0, COALESCE(@ProjectID, 0), @StockInventoryAccountLink, 0,
                0, COALESCE(@isLotItem, 0), 0, 1,
                @AbsQuantity, 0, 0, 0, @AbsQuantity,
                GETDATE(), GETDATE()
            );

            SELECT @NewLineID = SCOPE_IDENTITY();
        END
    END TRY
    BEGIN CATCH
        DECLARE @DocErr nvarchar(4000) = ERROR_MESSAGE();
        RAISERROR(''PostGRVV2 warning: GRV document create failed (stock already posted): %s'', 10, 1, @DocErr);
    END CATCH

    -- ========================================================================
    -- STEP 3: Calculate and post cost revaluation
    -- ========================================================================
    IF @VarianceAccountLink > 0 AND @OldTotalQty > 0
    BEGIN
        SELECT
            @NewTotalQty = @OldTotalQty + @AbsQuantity,
            @NewTotalValue = @OldTotalValue + @Amount,
            @NewWeightedAvg = CASE WHEN @NewTotalQty > 0 THEN @NewTotalValue / @NewTotalQty ELSE @UnitCost END;

        SELECT @VarianceAmount = @OldTotalQty * (@NewWeightedAvg - @OldWeightedAvg);
        SELECT @AbsVariance = ABS(@VarianceAmount);

        IF @AbsVariance > 0.01
        BEGIN
            EXEC @AuditTemp = _bspNextAuditNo;
            SELECT @AuditNo = CAST(@AuditTemp as varchar) + ''.0001'';

            IF @VarianceAmount > 0
            BEGIN
                SELECT @VarianceDebit = 0, @VarianceCredit = @AbsVariance;
                SELECT @StockDebit = @AbsVariance, @StockCredit = 0;
            END
            ELSE
            BEGIN
                SELECT @VarianceDebit = @AbsVariance, @VarianceCredit = 0;
                SELECT @StockDebit = 0, @StockCredit = @AbsVariance;
            END

            DECLARE @VarianceDesc varchar(255);
            SET @VarianceDesc = @Description + '' (Cost Revaluation)'';
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
                @VarianceDesc,
                0,
                @Reference,
                '''', '''',
                @AuditNo,
                0, 0,
                @ProjectID,
                @Period,
                0, 0, 0, 0,
                @UserName,
                '''', 0,
                @Reference2,
                @TxBranchID,
                0, 0, 0, 0, 0,
                '''', 0, 0, '''';

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
                @VarianceDesc,
                0,
                @Reference,
                '''', '''',
                @AuditNo,
                0, 0,
                @ProjectID,
                @Period,
                0, 0, 0, 0,
                @UserName,
                '''', 0,
                @Reference2,
                @TxBranchID,
                0, 0, 0, 0, 0,
                '''', 0, 0, '''';
        END
    END

    -- ========================================================================
    -- STEP 4: Update LastGRVCost for global and receiving warehouse
    -- ========================================================================
    UPDATE _etblStockCosts
    SET LastGRVCost = @UnitCost
    WHERE StockID = @HarvestItemID
      AND WhseID IN (0, @WarehouseID);

    IF @@ROWCOUNT = 0 OR NOT EXISTS (
        SELECT 1 FROM _etblStockCosts
        WHERE StockID = @HarvestItemID AND WhseID = @WarehouseID
    )
    BEGIN
        INSERT INTO _etblStockCosts (StockID, WhseID, AverageCost, LastGRVCost)
        SELECT
            @HarvestItemID,
            @WarehouseID,
            COALESCE((SELECT AverageCost FROM _etblStockCosts WHERE StockID = @HarvestItemID AND WhseID = 0), @UnitCost),
            @UnitCost;
    END

    RETURN 0;
END;
';


EXEC sp_executesql @sql;
