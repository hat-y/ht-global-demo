/**
 * @description Resolves the Sellium conversation linked to a Quote and returns its
 * customer-visible messages in chronological order. Read-only, runs as the user.
 */
public with sharing class HtQuoteConversationController {
    public class Message {
        @AuraEnabled public Id id;
        @AuraEnabled public String body;
        @AuraEnabled public Boolean isInbound;
        @AuraEnabled public String authorType;
        @AuraEnabled public String senderName;
        @AuraEnabled public Datetime sentAt;
    }

    public class Thread {
        @AuraEnabled public Id conversationId;
        @AuraEnabled public List<Message> messages = new List<Message>();
    }

    @AuraEnabled(cacheable=false)
    public static Thread getThread(Id quoteId) {
        Thread t = new Thread();
        if (quoteId == null) {
            return t;
        }
        // Visibility of the quote itself is enforced by sharing + USER_MODE.
        List<Quote> quotes = [SELECT Id FROM Quote WHERE Id = :quoteId WITH USER_MODE LIMIT 1];
        if (quotes.isEmpty()) {
            return t;
        }
        List<ConversationLink__c> links = [
            SELECT Conversation__c
            FROM ConversationLink__c
            WHERE RelatedObjectApiName__c = 'Quote' AND RelatedRecordId__c = :String.valueOf(quoteId)
            AND Conversation__c != null
            WITH USER_MODE
            ORDER BY CreatedDate DESC
            LIMIT 1
        ];
        if (links.isEmpty()) {
            return t;
        }
        t.conversationId = links[0].Conversation__c;
        for (ConversationMessage__c m : [
            SELECT Id, Body__c, IsInbound__c, AuthorType__c, SenderDisplayName__c, SentDate__c
            FROM ConversationMessage__c
            WHERE Conversation__c = :t.conversationId AND IsInternal__c = false
            WITH USER_MODE
            ORDER BY SentDate__c ASC, CreatedDate ASC
            LIMIT 500
        ]) {
            Message o = new Message();
            o.id = m.Id;
            o.body = m.Body__c == null ? '' : m.Body__c.stripHtmlTags();
            o.isInbound = m.IsInbound__c == true;
            o.authorType = m.AuthorType__c;
            o.senderName = m.SenderDisplayName__c;
            o.sentAt = m.SentDate__c;
            t.messages.add(o);
        }
        return t;
    }
}
