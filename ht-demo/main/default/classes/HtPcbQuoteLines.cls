/**
 * PCB Fabrication quote line support: finds the product entry, builds the one-line spec summary
 * and keeps the line item in sync when the PCB fields of a Quote change (the n8n agent PATCHes the
 * Quote directly). Bulk-safe and recursion-safe: only lines whose values differ are written.
 */
public with sharing class HtPcbQuoteLines {
    public static final String PRODUCT_CODE = 'HT-PCB-FAB';
    private static Boolean running = false;

    public static Id standardPricebookId() {
        if (Test.isRunningTest()) {
            return Test.getStandardPricebookId();
        }
        List<Pricebook2> rows = [SELECT Id FROM Pricebook2 WHERE IsStandard = true LIMIT 1];
        return rows.isEmpty() ? null : rows[0].Id;
    }

    public static PricebookEntry pcbEntry(Id pricebookId) {
        if (pricebookId == null) {
            return null;
        }
        List<PricebookEntry> rows = [
            SELECT Id, Product2Id
            FROM PricebookEntry
            WHERE Pricebook2Id = :pricebookId
              AND Product2.ProductCode = :PRODUCT_CODE
              AND IsActive = true
              AND Product2.IsActive = true
            LIMIT 1
        ];
        return rows.isEmpty() ? null : rows[0];
    }

    public static String fmt(Decimal value) {
        return value == null ? null : value.stripTrailingZeros().toPlainString();
    }

    /** Example: "Rigid PCB · 4 layers · 100 × 80 mm · 10 days · Commercial" (blank parts are skipped). */
    public static String specSummary(Quote q) {
        List<String> parts = new List<String>();
        if (String.isNotBlank(q.PCB_Board_Type__c)) {
            parts.add(q.PCB_Board_Type__c);
        }
        if (q.PCB_Layer_Count__c != null) {
            parts.add(fmt(q.PCB_Layer_Count__c) + ' layers');
        }
        String unit = String.isBlank(q.PCB_Unit_Of_Measure__c) ? '' : ' ' + q.PCB_Unit_Of_Measure__c;
        if (q.PCB_Board_Width__c != null && q.PCB_Board_Length__c != null) {
            parts.add(fmt(q.PCB_Board_Width__c) + ' \u00d7 ' + fmt(q.PCB_Board_Length__c) + unit);
        }
        if (q.PCB_Lead_Time_Days__c != null) {
            parts.add(fmt(q.PCB_Lead_Time_Days__c) + ' days');
        }
        if (String.isNotBlank(q.PCB_ITAR_Classification__c)) {
            parts.add(q.PCB_ITAR_Classification__c);
        }
        String summary = String.join(parts, ' \u00b7 ');
        return summary.length() > 255 ? summary.substring(0, 255) : summary;
    }

    private static Boolean specChanged(Quote n, Quote o) {
        return n.PCB_Quantity__c != o.PCB_Quantity__c
            || n.PCB_Board_Type__c != o.PCB_Board_Type__c
            || n.PCB_Layer_Count__c != o.PCB_Layer_Count__c
            || n.PCB_Board_Width__c != o.PCB_Board_Width__c
            || n.PCB_Board_Length__c != o.PCB_Board_Length__c
            || n.PCB_Unit_Of_Measure__c != o.PCB_Unit_Of_Measure__c
            || n.PCB_Lead_Time_Days__c != o.PCB_Lead_Time_Days__c
            || n.PCB_ITAR_Classification__c != o.PCB_ITAR_Classification__c;
    }

    public static void syncLineItems(List<Quote> updated, Map<Id, Quote> oldMap) {
        if (running) {
            return;
        }
        Map<Id, Quote> changed = new Map<Id, Quote>();
        for (Quote q : updated) {
            Quote o = oldMap.get(q.Id);
            if (o != null && specChanged(q, o)) {
                changed.put(q.Id, q);
            }
        }
        if (changed.isEmpty()) {
            return;
        }
        List<QuoteLineItem> toUpdate = new List<QuoteLineItem>();
        for (QuoteLineItem line : [
            SELECT Id, QuoteId, Quantity, Description
            FROM QuoteLineItem
            WHERE QuoteId IN :changed.keySet() AND Product2.ProductCode = :PRODUCT_CODE
        ]) {
            Quote q = changed.get(line.QuoteId);
            QuoteLineItem patch = new QuoteLineItem(Id = line.Id);
            Boolean dirty = false;
            if (q.PCB_Quantity__c != null && q.PCB_Quantity__c >= 1 && line.Quantity != q.PCB_Quantity__c) {
                patch.Quantity = q.PCB_Quantity__c;
                dirty = true;
            }
            String description = specSummary(q);
            if (line.Description != description) {
                patch.Description = description;
                dirty = true;
            }
            if (dirty) {
                toUpdate.add(patch);
            }
        }
        if (toUpdate.isEmpty()) {
            return;
        }
        running = true;
        try {
            update toUpdate;
        } finally {
            running = false;
        }
    }
}
