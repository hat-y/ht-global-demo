// Idempotent backfill of the 5 original web quotes: Standard Price Book + one PCB Fabrication line
// item, a Contact conversation link and a primary Decision Maker contact role (only when missing).
// Needs scripts/seed-ht-pcb-product.apex to have run. A second run creates nothing.
// Run: sf apex run -o ht-global -f scripts/backfill-ht-quote-records.apex
Set<String> names = new Set<String>{
    'PCB RFQ - Aero Circuits LLC', 'PCB RFQ - Summit Avionics', 'PCB RFQ - Lakeview Robotics',
    'PCB RFQ - Cascade Sensors', 'PCB RFQ - Ventix'
};
Id standardId = HtPcbQuoteLines.standardPricebookId();
List<Quote> quotes = [
    SELECT Id, Name, OpportunityId, ContactId, Pricebook2Id, PCB_Conversation_Id__c, PCB_Quantity__c,
           PCB_Board_Type__c, PCB_Layer_Count__c, PCB_Board_Width__c, PCB_Board_Length__c,
           PCB_Unit_Of_Measure__c, PCB_Lead_Time_Days__c, PCB_ITAR_Classification__c
    FROM Quote WHERE Name IN :names
];
PricebookEntry entry = HtPcbQuoteLines.pcbEntry(standardId);
Integer pricebooks = 0, lines = 0, links = 0, roles = 0;
List<String> nullQuantity = new List<String>();
for (Quote q : quotes) {
    if (q.Pricebook2Id == null) {
        q.Pricebook2Id = standardId;
        update q;
        pricebooks++;
    }
    if (entry != null && q.Pricebook2Id == standardId
        && [SELECT COUNT() FROM QuoteLineItem WHERE QuoteId = :q.Id AND Product2Id = :entry.Product2Id] == 0) {
        Decimal qty = q.PCB_Quantity__c;
        if (qty == null || qty < 1) {
            nullQuantity.add(q.Name);
            qty = 1;
        }
        insert new QuoteLineItem(
            QuoteId = q.Id, PricebookEntryId = entry.Id, Product2Id = entry.Product2Id,
            Quantity = qty, UnitPrice = 0, Description = HtPcbQuoteLines.specSummary(q)
        );
        lines++;
    }
    if (q.ContactId == null) {
        continue;
    }
    Contact c = [SELECT Id, FirstName, LastName, AccountId FROM Contact WHERE Id = :q.ContactId];
    if (q.PCB_Conversation_Id__c != null
        && [SELECT COUNT() FROM ConversationLink__c
            WHERE Conversation__c = :q.PCB_Conversation_Id__c
              AND RelatedObjectApiName__c = 'Contact' AND RelatedRecordId__c = :String.valueOf(c.Id)] == 0) {
        insert new ConversationLink__c(
            Conversation__c = q.PCB_Conversation_Id__c, Account__c = c.AccountId,
            RelatedObjectApiName__c = 'Contact', RelatedRecordId__c = String.valueOf(c.Id),
            RelatedRecordName__c = ((c.FirstName == null ? '' : c.FirstName + ' ') + c.LastName).trim(),
            LinkType__c = 'Secondary'
        );
        links++;
    }
    if (q.OpportunityId != null
        && [SELECT COUNT() FROM OpportunityContactRole WHERE OpportunityId = :q.OpportunityId AND IsPrimary = true] == 0) {
        insert new OpportunityContactRole(
            OpportunityId = q.OpportunityId, ContactId = c.Id, IsPrimary = true, Role = 'Decision Maker'
        );
        roles++;
    }
}
System.debug('RESULT quotes=' + quotes.size() + ' pricebookSet=' + pricebooks + ' lineItems=' + lines
    + ' contactLinks=' + links + ' contactRoles=' + roles + ' productFound=' + (entry != null)
    + ' quantityWasNull=' + nullQuantity);
