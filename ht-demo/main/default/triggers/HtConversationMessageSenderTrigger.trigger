trigger HtConversationMessageSenderTrigger on ConversationMessage__c (before insert) {
    HtConversationMessageSender.nameAgentMessages(Trigger.new);
}
