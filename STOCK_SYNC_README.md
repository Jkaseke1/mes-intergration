# Stock Sync System

## Overview
Keeps MES warehouse stock balances synchronized with Sage live quantities by syncing **immediately after every Sage posting operation**.

## How It Works

### **Sync After Every Operation (Real-Time)**
- **File**: `events/lib/syncStock.js` → `syncAfterPosting()`
- **Trigger**: Automatically after posting to Sage
- **What**: Syncs only the materials that were just posted
- **When**: Immediately after GRN, Material Issue, Production Complete, Dispatch

### **Operations That Trigger Sync:**
1. **GRN (Goods Receipt)** → Posts to Sage → Syncs received materials
2. **Material Issue** → Posts to Sage → Syncs issued materials  
3. **Production Complete** → Posts to Sage → Syncs finished goods
4. **Dispatch** → Posts to Sage → Syncs dispatched products

### **Optional Background Sync (Fallback)**
- **File**: `events/stockSyncScheduler.js`
- **Frequency**: Every 60 minutes (configurable)
- **What**: Syncs all materials as a safety net
- **When**: Only needed if you make manual Sage adjustments

## Stock Freshness Guarantee

| Operation | Stock Freshness | How |
|-----------|----------------|-----|
| **GRN (Goods Receipt)** | **Real-time** | Syncs immediately after Sage posting ✅ |
| **Material Issue** | **Real-time** | Syncs immediately after Sage posting ✅ |
| **Production Complete** | **Real-time** | Syncs immediately after Sage posting ✅ |
| **Dispatch** | **Real-time** | Syncs immediately after Sage posting ✅ |
| **Manual Sage Changes** | Max 1 hour | Background scheduler (optional) |

## Configuration

### Change Sync Frequency
Edit `.env` file:
```env
# Sync every 15 minutes (default: 60)
STOCK_SYNC_INTERVAL_MINUTES=15
```

### Sage Warehouse ID
```env
# RM warehouse in Sage (default: 18)
SAGE_RM_WAREHOUSE_ID=18
```

## Running the Services

### **Just Run Bridge Worker (Recommended)**
```bash
# Stock sync happens automatically after every operation
cd hyper-integration/events
node bridgeworker.js
```

### **Optional: Add Background Sync (for manual Sage changes)**
```bash
# Windows - runs both bridge worker and hourly sync
hyper-integration\start-bridge-with-sync.bat

# Or manually in separate terminals:
# Terminal 1: Bridge Worker
cd hyper-integration/events
node bridgeworker.js

# Terminal 2: Background Sync (optional)
cd hyper-integration/events
node stockSyncScheduler.js
```

### **Manual One-Time Sync (if needed)**
```bash
# Sync all materials once
node hyper-integration/scripts/syncStockFromSage.js
```

## What Gets Synced

- **Source**: Sage `_bvWarehouseStockFull` table (WhseID 18)
- **Destination**: MES `warehouse_stock_balances` table (RM warehouse)
- **Materials**: All active raw materials with `sage_code` (424 total)
- **Data**: `QtyOnHand` from Sage → `quantity` in MES

## Monitoring

### Finance Posting with Auto-Sync Output
```
[2026-07-23T09:00:00.000Z] Found 12 approved review(s) to post

  Posting: MAY0001 MFDR -518kg @ $0.45 (WhseID 18)
  ✅ Sage posted: MAY0001 MFDR
  ✅ Stock synced: MAY0001 → 5102.5kg in WhseID 18
  
  Posting: SOS0001 MFDR -175kg @ $0.52 (WhseID 18)
  ✅ Sage posted: SOS0001 MFDR
  ✅ Stock synced: SOS0001 → 3485.702kg in WhseID 18
  
  🔄 Syncing 12 materials after Finance Posting...
  ✅ Stock synced: 12 materials now match Sage
     MAY0001: 5,102.5 kg
     SOS0001: 3,485.702 kg
     ...
  
  ✅ Sync event abc123 fully processed
```

## Benefits

✅ **Perfect Synchronization**: MES always matches Sage (real-time)  
✅ **No Stale Stock Errors**: Syncs immediately after every Sage posting  
✅ **Automatic**: Zero manual intervention required  
✅ **Efficient**: Only syncs materials that were actually posted  
✅ **Transparent**: Logs every sync with before/after quantities  
✅ **Reliable**: Works even if background scheduler is not running  

## Troubleshooting

### Stock Still Out of Sync?
1. Check if bridge worker is running (stock sync is built-in)
2. Check logs for sync errors after postings
3. Run manual sync: `node hyper-integration/scripts/syncStockFromSage.js`

### Sync Errors in Logs?
- Verify Sage database connection
- Check network connectivity
- Verify `sage_code` exists in `raw_materials` table
- Verify material exists in Sage `_bvWarehouseStockFull`

### Manual Sage Changes Not Reflected?
- Run background scheduler: `node events/stockSyncScheduler.js`
- Or run one-time sync: `node scripts/syncStockFromSage.js`

## Files

| File | Purpose |
|------|---------|
| `events/lib/syncStock.js` | Real-time sync after Sage postings |
| `events/postApprovedReviews.js` | Posts to Sage + syncs stock |
| `events/stockSyncScheduler.js` | Optional background scheduler |
| `scripts/syncStockFromSage.js` | Manual one-time sync |
| `start-bridge-with-sync.bat` | Startup script (bridge + optional scheduler) |

## Summary

**After every Sage posting**: MES stock syncs immediately (real-time) ✅  
**Manual Sage changes**: Use optional background scheduler or manual sync  
**Result**: MES and Sage are always perfectly synchronized - no delays, no stale data
