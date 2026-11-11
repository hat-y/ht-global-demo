@IsTest
private class HtConversationMessageSenderTest {
    private static ConversationMessage__c msg(Id convId, Boolean agent, Boolean human, String sender) {
        return new ConversationMessage__c(
            Conversation__c = convId, Body__c = 'hi', IsInbound__c = false,
            IsAgentMessage__c = agent, IsHumanMessage__c = human, IsInternal__c = false,
            IsSystemMessage__c = false, SenderDisplayName__c = sender, SentDate__c = System.now()
        );
    }

    @IsTest
    static void agentMessageWithBlankNameGetsAssistantName() {
        Conversation__c c = new Conversation__c(DisplayName__c = 'X', ExternalContactId__c = 'x@example.com');
        insert c;
        List<ConversationMessage__c> rows = new List<ConversationMessage__c>();
        for (Integer i = 0; i < 200; i++) {
            rows.add(msg(c.Id, true, false, i == 0 ? '   ' : null));
        }
        insert rows;
        System.assertEquals(
            200,
            [SELECT COUNT() FROM ConversationMessage__c WHERE SenderDisplayName__c = 'HT Global assistant']
        );
    }

    @IsTest
    static void namedAndNonAgentMessagesAreUntouched() {
        Conversation__c c = new Conversation__c(DisplayName__c = 'X', ExternalContactId__c = 'x@example.com');
        insert c;
        ConversationMessage__c named = msg(c.Id, true, false, 'Custom Bot');
        ConversationMessage__c human = msg(c.Id, false, true, null);
        ConversationMessage__c inbound = msg(c.Id, false, false, null);
        inbound.IsInbound__c = true;
        insert new List<ConversationMessage__c>{ named, human, inbound };
        System.assertEquals('Custom Bot', [SELECT SenderDisplayName__c FROM ConversationMessage__c WHERE Id = :named.Id].SenderDisplayName__c);
        System.assertEquals(null, [SELECT SenderDisplayName__c FROM ConversationMessage__c WHERE Id = :human.Id].SenderDisplayName__c);
        System.assertEquals(null, [SELECT SenderDisplayName__c FROM ConversationMessage__c WHERE Id = :inbound.Id].SenderDisplayName__c);
    }
}
