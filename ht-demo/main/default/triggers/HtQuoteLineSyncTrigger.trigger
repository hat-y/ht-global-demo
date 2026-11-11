trigger HtQuoteLineSyncTrigger on Quote (after update) {
    HtPcbQuoteLines.syncLineItems(Trigger.new, Trigger.oldMap);
}
