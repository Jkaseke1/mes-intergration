# Real-Time Stock Sync Flow

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│  USER ACTION (e.g., Approve Material Issue)                 │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  Bridge Worker Queues Transaction for Finance Review        │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  Finance Approves Transaction                                │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  postApprovedReviews.js                                      │
│  ├─ Posts transaction to Sage                                │
│  ├─ Sage updates stock (e.g., -518kg MAY0001)               │
│  └─ ✅ Sage posting complete                                 │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│  🔄 IMMEDIATE STOCK SYNC (syncAfterPosting)                  │
│  ├─ Queries Sage for fresh quantities                        │
│  ├─ Updates MES warehouse_stock_balances                     │
│  └─ ✅ MES now matches Sage (real-time)                      │
└─────────────────────────────────────────────────────────────┘
```

## Example: Material Issue for BATCH-2026-220

### Step 1: User Approves Material Issue
```
12 materials marked as "issued" in MES
```

### Step 2: Bridge Queues for Finance Review
```
→ Event 2: Goods Issue (Auto) — Review Queue Mode
  Batch: BATCH-2026-220
  Issued lines: 12 (single finance approval package)
  Material: MAY0001 — 518kg
  Material: SOS0001 — 175kg
  ...
  ✅ Queued 12 lines for finance review
```

### Step 3: Finance Approves
```
Finance user clicks "Approve" in MES
```

### Step 4: Post to Sage + Sync Stock
```
[2026-07-23T09:00:00.000Z] Found 12 approved review(s) to post

  Posting: MAY0001 MFDR -518kg @ $0.45 (WhseID 18)
  ✅ Sage posted: MAY0001 MFDR
  ✅ Stock synced: MAY0001 → 5102.5kg in WhseID 18
  
  Posting: SOS0001 MFDR -175kg @ $0.52 (WhseID 18)
  ✅ Sage posted: SOS0001 MFDR
  ✅ Stock synced: SOS0001 → 3485.702kg in WhseID 18
  
  ... (10 more materials)
  
  🔄 Syncing 12 materials after Finance Posting...
  ✅ Stock synced: 12 materials now match Sage
     MAY0001: 5,102.5 kg
     SOS0001: 3,485.702 kg
     MAB0001: 2,889.9 kg
     WHB0001: 110,684.08 kg
     ...
  
  ✅ Sync event abc123 fully processed
```

## Result

✅ **Sage Stock**: Updated with -518kg MAY0001, -175kg SOS0001, etc.  
✅ **MES Stock**: Immediately synced to match Sage  
✅ **No Delay**: Sync happens in same operation  
✅ **No Stale Data**: MES always shows current Sage quantities  

## All Operations That Auto-Sync

| Operation | Sage Transaction | Auto-Sync |
|-----------|------------------|-----------|
| **GRN** | GRV (Goods Receipt) | ✅ After posting |
| **Material Issue** | MFDR (Stock Out) | ✅ After posting |
| **Production Complete** | MFMF (Stock In) | ✅ After posting |
| **Dispatch** | MFDR + MFMF (Transfer) | ✅ After posting |

## No Hourly Sync Needed!

The background scheduler (`stockSyncScheduler.js`) is **optional** and only needed if:
- You make manual adjustments directly in Sage
- You want a safety net to catch any missed syncs

For normal MES operations, the real-time sync-after-posting is sufficient.
