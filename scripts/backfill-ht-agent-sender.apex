// Idempotent: agent messages without a sender name get "HT Global assistant".
// Run: sf apex run -o ht-global -f scripts/backfill-ht-agent-sender.apex
List<ConversationMessage__c> rows = [
    SELECT Id FROM ConversationMessage__c
    WHERE IsAgentMessage__c = true AND (SenderDisplayName__c = null OR SenderDisplayName__c = '')
    LIMIT 10000
];
for (ConversationMessage__c m : rows) {
    m.SenderDisplayName__c = 'HT Global assistant';
}
update rows;
System.debug('RESULT agent messages updated: ' + rows.size());
