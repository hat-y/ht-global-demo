@IsTest
private class HtQuoteLineSyncTest {
    private static Id pcbEntryId;
    private static Id otherEntryId;

    private static void seed() {
        Product2 pcb = new Product2(Name = 'PCB Fabrication', ProductCode = 'HT-PCB-FAB', IsActive = true);
        Product2 other = new Product2(Name = 'Other Thing', ProductCode = 'OTHER-1', IsActive = true);
        insert new List<Product2>{ pcb, other };
        PricebookEntry e1 = new PricebookEntry(Pricebook2Id = Test.getStandardPricebookId(), Product2Id = pcb.Id, UnitPrice = 0, IsActive = true);
        PricebookEntry e2 = new PricebookEntry(Pricebook2Id = Test.getStandardPricebookId(), Product2Id = other.Id, UnitPrice = 5, IsActive = true);
        insert new List<PricebookEntry>{ e1, e2 };
        pcbEntryId = e1.Id;
        otherEntryId = e2.Id;
    }

    private static List<Quote> makeQuotes(Integer n) {
        List<Opportunity> opps = new List<Opportunity>();
        for (Integer i = 0; i < n; i++) {
            opps.add(new Opportunity(Name = 'Opp ' + i, StageName = 'Prospecting', CloseDate = Date.today().addDays(10)));
        }
        insert opps;
        List<Quote> quotes = new List<Quote>();
        for (Integer i = 0; i < n; i++) {
            quotes.add(new Quote(
                Name = 'Q ' + i, OpportunityId = opps[i].Id, Pricebook2Id = Test.getStandardPricebookId(),
                PCB_Quantity__c = 10, PCB_Board_Type__c = 'Rigid PCB', PCB_Layer_Count__c = 4,
                PCB_Board_Width__c = 100, PCB_Board_Length__c = 80, PCB_Unit_Of_Measure__c = 'mm',
                PCB_Lead_Time_Days__c = 10, PCB_ITAR_Classification__c = 'Commercial'
            ));
        }
        insert quotes;
        return quotes;
    }

    private static void addLines(List<Quote> quotes, Id entryId, Id productId, Decimal qty) {
        List<QuoteLineItem> lines = new List<QuoteLineItem>();
        for (Quote q : quotes) {
            lines.add(new QuoteLineItem(
                QuoteId = q.Id, PricebookEntryId = entryId, Product2Id = productId, Quantity = qty, UnitPrice = 0
            ));
        }
        insert lines;
    }

    private static Id productId(String code) {
        return [SELECT Id FROM Product2 WHERE ProductCode = :code].Id;
    }

    @IsTest
    static void quantityChangeUpdatesPcbLine() {
        seed();
        List<Quote> quotes = makeQuotes(1);
        addLines(quotes, pcbEntryId, productId('HT-PCB-FAB'), 10);

        quotes[0].PCB_Quantity__c = 250;
        update quotes;

        QuoteLineItem line = [SELECT Quantity, Description FROM QuoteLineItem WHERE QuoteId = :quotes[0].Id];
        System.assertEquals(250, line.Quantity);
        System.assertEquals('Rigid PCB \u00b7 4 layers \u00b7 100 \u00d7 80 mm \u00b7 10 days \u00b7 Commercial', line.Description);
    }

    @IsTest
    static void specChangeUpdatesDescription() {
        seed();
        List<Quote> quotes = makeQuotes(1);
        addLines(quotes, pcbEntryId, productId('HT-PCB-FAB'), 10);

        quotes[0].PCB_Layer_Count__c = 6;
        update quotes;

        System.assert(
            [SELECT Description FROM QuoteLineItem WHERE QuoteId = :quotes[0].Id].Description.contains('6 layers')
        );
    }

    @IsTest
    static void quoteWithoutPcbLineIsIgnoredAndOtherLinesUntouched() {
        seed();
        List<Quote> noLines = makeQuotes(1);
        List<Quote> otherLine = makeQuotes(1);
        addLines(otherLine, otherEntryId, productId('OTHER-1'), 3);

        noLines[0].PCB_Quantity__c = 99;
        otherLine[0].PCB_Quantity__c = 99;
        update new List<Quote>{ noLines[0], otherLine[0] };

        System.assertEquals(0, [SELECT COUNT() FROM QuoteLineItem WHERE QuoteId = :noLines[0].Id]);
        QuoteLineItem other = [SELECT Quantity, Description FROM QuoteLineItem WHERE QuoteId = :otherLine[0].Id];
        System.assertEquals(3, other.Quantity);
        System.assertEquals(null, other.Description);
    }

    @IsTest
    static void unrelatedQuoteChangeLeavesLineAlone() {
        seed();
        List<Quote> quotes = makeQuotes(1);
        addLines(quotes, pcbEntryId, productId('HT-PCB-FAB'), 7);
        quotes[0].PCB_Customer_Comment__c = 'hello';
        update quotes;
        System.assertEquals(7, [SELECT Quantity FROM QuoteLineItem WHERE QuoteId = :quotes[0].Id].Quantity);
    }

    @IsTest
    static void bulk200Quotes() {
        seed();
        List<Quote> quotes = makeQuotes(200);
        addLines(quotes, pcbEntryId, productId('HT-PCB-FAB'), 10);
        for (Quote q : quotes) {
            q.PCB_Quantity__c = 77;
        }
        Test.startTest();
        update quotes;
        Test.stopTest();
        System.assertEquals(200, [SELECT COUNT() FROM QuoteLineItem WHERE Quantity = 77]);
    }
}
