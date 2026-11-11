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
    static void appendMessage_updatesConversationAndQuoteComment() {
        HtPcbQuoteService.QuoteRequest startReq = new HtPcbQuoteService.QuoteRequest();
        startReq.name = 'Jordan Lee';
        startReq.company = 'Beacon Boards';
        startReq.email = 'jordan.lee@beaconboards.example';
        startReq.boardType = 'Flex PCB';
        startReq.quantity = 10;
        startReq.itarClassification = 'Commercial';
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
        Quote quote = [SELECT PCB_Customer_Comment__c FROM Quote WHERE Id = :started.quoteId];
        System.assert(
            quote.PCB_Customer_Comment__c != null &&
            quote.PCB_Customer_Comment__c.contains('0.5mm pitch BGA')
        );
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
}
