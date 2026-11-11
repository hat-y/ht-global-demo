/**
 * Agent replies written through the Sellium /message API carry no sender name. Give blank agent
 * messages the HT Global assistant name so the console and the website show the same sender.
 */
public with sharing class HtConversationMessageSender {
    public static final String ASSISTANT_NAME = 'HT Global assistant';

    public static void nameAgentMessages(List<ConversationMessage__c> rows) {
        for (ConversationMessage__c m : rows) {
            if (m.IsAgentMessage__c == true && String.isBlank(m.SenderDisplayName__c)) {
                m.SenderDisplayName__c = ASSISTANT_NAME;
            }
        }
    }
}
