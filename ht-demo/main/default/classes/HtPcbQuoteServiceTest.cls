@IsTest
private class HtPcbQuoteServiceTest {
    @IsTest
    static void startQuote_createsQuoteConversationAndLink() {
        HtPcbQuoteService.QuoteRequest req = new HtPcbQuoteService.QuoteRequest();
        req.name = 'Alex Rivera';
        req.company = 'Aero Circuits LLC';
        req.email = 'alex.rivera@aerocircuits.example';
        req.phone = '+1 512 555 0142';
        req.boardType = 'Rigid PCB';
        req.singleUpOrArray = 'Single Up';
        req.unitOfMeasure = 'mm';
        req.width = 50;
        req.length = 80;
        req.layers = 4;
        req.leadTimeDays = 10;
        req.quantity = 25;
        req.itarClassification = 'Commercial';
        req.comment = 'Needs ENIG finish';
        req.message = 'Please quote hard gold on the edge connectors.';

        Test.startTest();
        HtPcbQuoteResult res = HtPcbQuoteService.startQuote(req);
        Test.stopTest();

        System.assertEquals(true, res.success, res.errorMessage == null ? 'ok' : res.errorMessage);
        System.assertNotEquals(null, res.quoteId);
        System.assertNotEquals(null, res.conversationId);

        Quote quote = [
            SELECT PCB_Board_Type__c, PCB_Quantity__c, PCB_Conversation_Id__c, Email
            FROM Quote
            WHERE Id = :res.quoteId
        ];
        System.assertEquals('Rigid PCB', quote.PCB_Board_Type__c);
        System.assertEquals(25, quote.PCB_Quantity__c);
        System.assertEquals(res.conversationId, quote.PCB_Conversation_Id__c);

        System.assertEquals(
            2,
            [SELECT COUNT() FROM ConversationMessage__c WHERE Conversation__c = :res.conversationId]
        );
        System.assertEquals(
            1,
            [
                SELECT COUNT()
                FROM ConversationLink__c
                WHERE Conversation__c = :res.conversationId AND RelatedRecordId__c = :res.quoteId
            ]
        );
    }

    @IsTest
    static void appendMessage_addsConversationMessageAndKeepsFormComment() {
        HtPcbQuoteService.QuoteRequest startReq = new HtPcbQuoteService.QuoteRequest();
        startReq.name = 'Jordan Lee';
        startReq.company = 'Beacon Boards';
        startReq.email = 'jordan.lee@beaconboards.example';
        startReq.boardType = 'Flex PCB';
        startReq.quantity = 10;
        startReq.itarClassification = 'Commercial';
        startReq.comment = 'Prototype run first';
        HtPcbQuoteResult started = HtPcbQuoteService.startQuote(startReq);
        System.assertEquals(true, started.success, started.errorMessage == null ? 'ok' : started.errorMessage);

        HtPcbQuoteService.QuoteRequest appendReq = new HtPcbQuoteService.QuoteRequest();
        appendReq.conversationId = started.conversationId;
        appendReq.quoteId = started.quoteId;
        appendReq.message = 'Can you also support 0.5mm pitch BGA?';

        Test.startTest();
        HtPcbQuoteResult appended = HtPcbQuoteService.appendMessage(appendReq);
        Test.stopTest();

        System.assertEquals(true, appended.success, appended.errorMessage == null ? 'ok' : appended.errorMessage);
        System.assertEquals(
            2,
            [SELECT COUNT() FROM ConversationMessage__c WHERE Conversation__c = :started.conversationId]
        );
        System.assertEquals(started.quoteId, appended.quoteId);
        Quote quote = [SELECT PCB_Customer_Comment__c FROM Quote WHERE Id = :started.quoteId];
        System.assertEquals('Prototype run first', quote.PCB_Customer_Comment__c);
    }

    private static HtPcbQuoteResult startForPolling(String email) {
        HtPcbQuoteService.QuoteRequest req = new HtPcbQuoteService.QuoteRequest();
        req.name = 'Poll Tester';
        req.company = 'Poll Co';
        req.email = email;
        req.boardType = 'Rigid PCB';
        req.quantity = 5;
        req.itarClassification = 'Commercial';
        req.message = 'Hello from the visitor';
        HtPcbQuoteResult started = HtPcbQuoteService.startQuote(req);
        System.assertEquals(true, started.success, started.errorMessage == null ? 'ok' : started.errorMessage);
        return started;
    }

    private static ConversationMessage__c outbound(Id conversationId, String body, Boolean internal, Boolean human) {
        ConversationMessage__c m = new ConversationMessage__c(
            Conversation__c = conversationId,
            Body__c = body,
            IsInbound__c = false,
            IsAgentMessage__c = !human,
            IsHumanMessage__c = human,
            IsInternal__c = internal,
            IsSystemMessage__c = false,
            SenderDisplayName__c = human ? 'HT Global team' : 'HT Global assistant',
            SentDate__c = System.now()
        );
        insert m;
        return m;
    }

    @IsTest
    static void getMessages_returnsTeamReplyOnly() {
        HtPcbQuoteResult s = startForPolling('poll1@example.com');
        ConversationMessage__c team = outbound(s.conversationId, 'We can do hard gold.', false, true);
        outbound(s.conversationId, 'INTERNAL: margin note', true, true);
        insert new ConversationMessage__c(
            Conversation__c = s.conversationId, Body__c = 'system text', IsInbound__c = false,
            IsSystemMessage__c = true, SentDate__c = System.now()
        );

        HtPcbQuoteMessagesResult r = HtPcbQuoteService.getMessages(s.conversationId, s.quoteId, null);

        System.assertEquals(true, r.success);
        System.assertNotEquals(null, r.serverTime);
        // inbound visitor messages, internal notes and system messages are excluded
        System.assertEquals(1, r.messages.size());
        System.assertEquals(team.Id, r.messages[0].id);
        System.assertEquals('We can do hard gold.', r.messages[0].body);
        System.assertEquals('HT Global team', r.messages[0].sender);
        System.assertEquals(true, r.messages[0].fromTeam);
        System.assertEquals(false, r.messages[0].fromAgent);
    }

    @IsTest
    static void getMessages_returnsPlainTextNotStoredHtml() {
        // Sellium stores Body__c as escaped HTML (It's -> It&#39;s, & -> &amp;); the website shows plain text.
        HtPcbQuoteResult s = startForPolling('poll-html@example.com');
        outbound(s.conversationId, 'It\'s <b>ready</b> & "done".', false, true);
        outbound(s.conversationId, 'Line one<br>Line two', false, true);

        HtPcbQuoteMessagesResult r = HtPcbQuoteService.getMessages(s.conversationId, s.quoteId, null);

        System.assertEquals(2, r.messages.size());
        System.assertEquals('It\'s ready & "done".', r.messages[0].body);
        System.assertEquals('Line one\nLine two', r.messages[1].body);
    }

    @IsTest
    static void getMessages_marksAgentMessages() {
        HtPcbQuoteResult s = startForPolling('poll2@example.com');
        outbound(s.conversationId, 'Agent answer', false, false);
        HtPcbQuoteMessagesResult r = HtPcbQuoteService.getMessages(s.conversationId, s.quoteId, null);
        System.assertEquals(1, r.messages.size());
        System.assertEquals(true, r.messages[0].fromAgent);
        System.assertEquals(false, r.messages[0].fromTeam);
    }

    @IsTest
    static void getMessages_afterFiltersOlderMessages() {
        HtPcbQuoteResult s = startForPolling('poll3@example.com');
        ConversationMessage__c oldMsg = outbound(s.conversationId, 'old', false, true);
        ConversationMessage__c newMsg = outbound(s.conversationId, 'new', false, true);
        Test.setCreatedDate(oldMsg.Id, Datetime.newInstanceGmt(2026, 1, 1, 10, 0, 0));
        Test.setCreatedDate(newMsg.Id, Datetime.newInstanceGmt(2026, 1, 1, 12, 0, 0));

        HtPcbQuoteMessagesResult r = HtPcbQuoteService.getMessages(
            s.conversationId, s.quoteId, '2026-01-01T11:00:00.000Z'
        );
        System.assertEquals(true, r.success);
        System.assertEquals(1, r.messages.size());
        System.assertEquals('new', r.messages[0].body);

        HtPcbQuoteMessagesResult all = HtPcbQuoteService.getMessages(s.conversationId, s.quoteId, 'not-a-date');
        System.assertEquals(2, all.messages.size());
    }

    @IsTest
    static void getMessages_mismatchedPairIsRejected() {
        HtPcbQuoteResult a = startForPolling('poll4@example.com');
        HtPcbQuoteResult b = startForPolling('poll5@example.com');
        outbound(a.conversationId, 'private to A', false, true);

        HtPcbQuoteMessagesResult r = HtPcbQuoteService.getMessages(a.conversationId, b.quoteId, null);
        System.assertEquals(false, r.success);
        System.assertEquals(0, r.messages.size());
        System.assertEquals('Conversation not found', r.errorMessage);

        System.assertEquals(false, HtPcbQuoteService.getMessages(a.conversationId, null, null).success);
        System.assertEquals(false, HtPcbQuoteService.getMessages('bogus', a.quoteId, null).success);
    }

    // ---------- records hygiene (S17) ----------

    private static String errOf(HtPcbQuoteResult r) {
        return r.errorMessage == null ? 'ok' : r.errorMessage;
    }

    private static void seedPcbProduct() {
        Product2 p = new Product2(Name = 'PCB Fabrication', ProductCode = 'HT-PCB-FAB', IsActive = true);
        insert p;
        insert new PricebookEntry(
            Pricebook2Id = Test.getStandardPricebookId(), Product2Id = p.Id, UnitPrice = 0, IsActive = true
        );
    }

    private static HtPcbQuoteService.QuoteRequest fullRequest(String email) {
        HtPcbQuoteService.QuoteRequest req = new HtPcbQuoteService.QuoteRequest();
        req.name = 'Alex Rivera';
        req.company = 'Records Co';
        req.email = email;
        req.phone = '+1 512 555 0142';
        req.boardType = 'Rigid PCB';
        req.unitOfMeasure = 'mm';
        req.width = 100;
        req.length = 80;
        req.layers = 4;
        req.leadTimeDays = 10;
        req.quantity = 120;
        req.itarClassification = 'Commercial';
        return req;
    }

    @IsTest
    static void startQuote_existingContactIsNeverModified() {
        Account other = new Account(Name = 'Other Corp');
        insert other;
        Contact existing = new Contact(
            FirstName = 'Pat', LastName = 'Original', Email = 'same@example.com',
            Phone = '111', AccountId = other.Id
        );
        insert existing;

        HtPcbQuoteService.QuoteRequest req = fullRequest('same@example.com');
        req.name = 'Someone Else';
        HtPcbQuoteResult res = HtPcbQuoteService.startQuote(req);

        System.assertEquals(true, res.success, errOf(res));
        System.assertEquals(existing.Id, res.contactId);
        Contact after = [SELECT FirstName, LastName, Phone, AccountId FROM Contact WHERE Id = :existing.Id];
        System.assertEquals('Pat', after.FirstName);
        System.assertEquals('Original', after.LastName);
        System.assertEquals('111', after.Phone);
        System.assertEquals(other.Id, after.AccountId);
        System.assertEquals(1, [SELECT COUNT() FROM Contact WHERE Email = 'same@example.com']);
        System.assertEquals(existing.Id, [SELECT ContactId FROM Quote WHERE Id = :res.quoteId].ContactId);
    }

    @IsTest
    static void startQuote_existingContactOnlyFillsBlanks() {
        Contact existing = new Contact(LastName = 'Blanky', Email = 'blank@example.com');
        insert existing;

        HtPcbQuoteResult res = HtPcbQuoteService.startQuote(fullRequest('blank@example.com'));

        System.assertEquals(true, res.success, errOf(res));
        Contact after = [SELECT LastName, Phone, AccountId FROM Contact WHERE Id = :existing.Id];
        System.assertEquals('Blanky', after.LastName);
        System.assertEquals('+1 512 555 0142', after.Phone);
        System.assertEquals(res.accountId, after.AccountId);
    }

    @IsTest
    static void startQuote_existingAccountKeepsPhoneAndBlankIsFilled() {
        Account keep = new Account(Name = 'Keep Phone Inc', Phone = '999');
        Account blank = new Account(Name = 'Blank Phone Inc');
        insert new List<Account>{ keep, blank };

        HtPcbQuoteService.QuoteRequest a = fullRequest('a1@example.com');
        a.company = 'Keep Phone Inc';
        HtPcbQuoteService.QuoteRequest b = fullRequest('b1@example.com');
        b.company = 'Blank Phone Inc';
        b.name = 'Bob Distinct';
        HtPcbQuoteResult ra = HtPcbQuoteService.startQuote(a);
        System.assertEquals(true, ra.success, errOf(ra));
        HtPcbQuoteResult rb = HtPcbQuoteService.startQuote(b);
        System.assertEquals(true, rb.success, errOf(rb));

        System.assertEquals('999', [SELECT Phone FROM Account WHERE Id = :keep.Id].Phone);
        System.assertEquals('+1 512 555 0142', [SELECT Phone FROM Account WHERE Id = :blank.Id].Phone);
        System.assertEquals(1, [SELECT COUNT() FROM Account WHERE Name = 'Keep Phone Inc']);
    }

    @IsTest
    static void startQuote_newRecordsAreCreatedAsBefore() {
        HtPcbQuoteResult res = HtPcbQuoteService.startQuote(fullRequest('new.person@example.com'));
        System.assertEquals(true, res.success, errOf(res));
        Contact c = [SELECT FirstName, LastName, Phone, AccountId FROM Contact WHERE Id = :res.contactId];
        System.assertEquals('Alex', c.FirstName);
        System.assertEquals('Rivera', c.LastName);
        System.assertEquals('+1 512 555 0142', c.Phone);
        System.assertEquals(res.accountId, c.AccountId);
        System.assertEquals('+1 512 555 0142', [SELECT Phone FROM Account WHERE Id = :res.accountId].Phone);
    }

    @IsTest
    static void formSummary_omitsBlankLinesAndNeverPrintsNull() {
        HtPcbQuoteService.QuoteRequest req = new HtPcbQuoteService.QuoteRequest();
        req.name = 'Sparse Sam';
        req.company = 'Sparse Co';
        req.email = 'sparse@example.com';
        req.quantity = 120;
        req.boardType = 'Rigid PCB';
        HtPcbQuoteResult res = HtPcbQuoteService.startQuote(req);
        System.assertEquals(true, res.success, errOf(res));

        ConversationMessage__c m = [
            SELECT Body__c FROM ConversationMessage__c WHERE Conversation__c = :res.conversationId LIMIT 1
        ];
        System.assert(!m.Body__c.containsIgnoreCase('null'), m.Body__c);
        System.assert(!m.Body__c.contains('Phone:'), m.Body__c);
        System.assert(!m.Body__c.contains('Comment:'), m.Body__c);
        System.assert(!m.Body__c.contains('Width:'), m.Body__c);
        System.assert(m.Body__c.startsWith('PCB Instant Quote request\n'), m.Body__c);
        System.assert(m.Body__c.contains('Quantity: 120'), m.Body__c);
        System.assert(m.Body__c.contains('Board Type: Rigid PCB'), m.Body__c);
        for (String line : m.Body__c.split('\n')) {
            System.assert(String.isNotBlank(line) && !line.endsWith(': '), 'blank line: ' + line);
        }
    }

    @IsTest
    static void startQuote_createsPricebookAndLineItem() {
        seedPcbProduct();
        HtPcbQuoteResult res = HtPcbQuoteService.startQuote(fullRequest('line@example.com'));
        System.assertEquals(true, res.success, errOf(res));

        System.assertEquals(
            Test.getStandardPricebookId(), [SELECT Pricebook2Id FROM Quote WHERE Id = :res.quoteId].Pricebook2Id
        );
        List<QuoteLineItem> items = [
            SELECT Quantity, UnitPrice, Description, Product2.ProductCode FROM QuoteLineItem WHERE QuoteId = :res.quoteId
        ];
        System.assertEquals(1, items.size());
        System.assertEquals('HT-PCB-FAB', items[0].Product2.ProductCode);
        System.assertEquals(120, items[0].Quantity);
        System.assertEquals(0, items[0].UnitPrice);
        System.assertEquals('Rigid PCB \u00b7 4 layers \u00b7 100 \u00d7 80 mm \u00b7 10 days \u00b7 Commercial', items[0].Description);
    }

    @IsTest
    static void startQuote_withoutProductStillSucceedsWithoutLineItem() {
        HtPcbQuoteResult res = HtPcbQuoteService.startQuote(fullRequest('noprod@example.com'));
        System.assertEquals(true, res.success, errOf(res));
        System.assertEquals(0, [SELECT COUNT() FROM QuoteLineItem WHERE QuoteId = :res.quoteId]);
        System.assertEquals(1, [SELECT COUNT() FROM Quote WHERE Id = :res.quoteId]);
    }

    @IsTest
    static void startQuote_linksContactAndCreatesPrimaryContactRole() {
        HtPcbQuoteResult res = HtPcbQuoteService.startQuote(fullRequest('roles@example.com'));
        System.assertEquals(true, res.success, errOf(res));

        List<ConversationLink__c> links = [
            SELECT LinkType__c, RelatedRecordId__c, Account__c
            FROM ConversationLink__c
            WHERE Conversation__c = :res.conversationId AND RelatedObjectApiName__c = 'Contact'
        ];
        System.assertEquals(1, links.size());
        System.assertEquals(String.valueOf(res.contactId), links[0].RelatedRecordId__c);
        System.assertNotEquals('Primary', links[0].LinkType__c);
        // the Quote link stays the single Primary link
        System.assertEquals(
            1,
            [SELECT COUNT() FROM ConversationLink__c WHERE Conversation__c = :res.conversationId AND LinkType__c = 'Primary']
        );

        List<OpportunityContactRole> roles = [
            SELECT ContactId, IsPrimary, Role FROM OpportunityContactRole WHERE OpportunityId = :res.opportunityId
        ];
        System.assertEquals(1, roles.size());
        System.assertEquals(res.contactId, roles[0].ContactId);
        System.assertEquals(true, roles[0].IsPrimary);
        System.assertEquals('Decision Maker', roles[0].Role);
    }

    @IsTest
    static void startQuote_requiresQuantity() {
        for (Decimal q : new List<Decimal>{ null, 0, -3 }) {
            HtPcbQuoteService.QuoteRequest req = fullRequest('qty@example.com');
            req.quantity = q;
            HtPcbQuoteResult res = HtPcbQuoteService.startQuote(req);
            System.assertEquals(false, res.success);
            System.assertEquals('Quantity is required.', errOf(res));
        }
        System.assertEquals(0, [SELECT COUNT() FROM Quote]);
        System.assertEquals(0, [SELECT COUNT() FROM Contact WHERE Email = 'qty@example.com']);
    }
}
