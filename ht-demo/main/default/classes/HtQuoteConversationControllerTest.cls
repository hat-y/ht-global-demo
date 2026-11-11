@IsTest
private class HtQuoteConversationControllerTest {
    private static Quote makeQuote(String name) {
        Opportunity opp = new Opportunity(Name = 'Opp ' + name, StageName = 'Prospecting', CloseDate = Date.today().addDays(30));
        insert opp;
        Quote q = new Quote(Name = name, OpportunityId = opp.Id);
        insert q;
        return q;
    }

    private static Id link(Quote q) {
        Conversation__c c = new Conversation__c();
        insert c;
        insert new ConversationLink__c(Conversation__c = c.Id, RelatedObjectApiName__c = 'Quote', RelatedRecordId__c = q.Id);
        return c.Id;
    }

    private static void msg(Id conversationId, String body, Datetime sentAt, Boolean inbound, Boolean internal) {
        insert new ConversationMessage__c(
            Conversation__c = conversationId, Body__c = body, SentDate__c = sentAt,
            IsInbound__c = inbound, IsInternal__c = internal,
            SenderDisplayName__c = inbound ? 'Customer' : 'Agent'
        );
    }

    @IsTest
    static void returnsLinkedMessagesInChronologicalOrder() {
        Quote q = makeQuote('Q1');
        Id convId = link(q);
        Datetime t = Datetime.now().addHours(-3);
        msg(convId, 'second', t.addMinutes(5), false, false);
        msg(convId, 'first', t, true, false);
        msg(convId, 'internal note', t.addMinutes(6), false, true);
        msg(convId, 'third', t.addMinutes(9), true, false);

        HtQuoteConversationController.Thread r = HtQuoteConversationController.getThread(q.Id);
        Assert.areEqual(convId, r.conversationId);
        Assert.areEqual(3, r.messages.size(), 'internal notes are excluded');
        Assert.areEqual('first', r.messages[0].body);
        Assert.areEqual('second', r.messages[1].body);
        Assert.areEqual('third', r.messages[2].body);
        Assert.isTrue(r.messages[0].isInbound);
        Assert.areEqual('Customer', r.messages[0].senderName);
    }

    @IsTest
    static void quoteWithoutConversationReturnsEmptyNotError() {
        Quote q = makeQuote('Q2');
        HtQuoteConversationController.Thread r = HtQuoteConversationController.getThread(q.Id);
        Assert.isNotNull(r);
        Assert.isNull(r.conversationId);
        Assert.areEqual(0, r.messages.size());
    }

    @IsTest
    static void neverReturnsAnotherQuotesConversation() {
        Quote a = makeQuote('QA');
        Quote b = makeQuote('QB');
        Id convA = link(a);
        Id convB = link(b);
        msg(convA, 'for A', Datetime.now().addMinutes(-10), true, false);
        msg(convB, 'for B', Datetime.now().addMinutes(-5), true, false);

        HtQuoteConversationController.Thread r = HtQuoteConversationController.getThread(a.Id);
        Assert.areEqual(convA, r.conversationId);
        Assert.areEqual(1, r.messages.size());
        Assert.areEqual('for A', r.messages[0].body);
    }
}
