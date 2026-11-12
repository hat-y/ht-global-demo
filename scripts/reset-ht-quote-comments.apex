// One-off, idempotent: reset Quote.PCB_Customer_Comment__c to the comment the customer typed in the web
// form (the "Comment:" line of the original-submission Description). Chat messages used to be appended
// to the comment; the conversation keeps the full history, so nothing is lost. Only touches PCB web quotes.
// Run once: sf apex run -o ht-global -f scripts/reset-ht-quote-comments.apex
List<Quote> quotes = [
    SELECT Id, Name, Description, PCB_Customer_Comment__c FROM Quote
    WHERE PCB_Conversation_Id__c != null
];
List<Quote> changes = new List<Quote>();
for (Quote q : quotes) {
    String formComment = null;
    for (String line : (q.Description == null ? '' : q.Description).split('\n')) {
        if (line.startsWith('Comment:')) {
            String v = line.substringAfter('Comment:').trim();
            formComment = String.isBlank(v) ? null : v;
        }
    }
    if (q.PCB_Customer_Comment__c != formComment) {
        System.debug(LoggingLevel.ERROR, 'CHANGE ' + q.Id + ' ' + q.Name + ' | from: '
            + JSON.serialize(q.PCB_Customer_Comment__c) + ' | to: ' + JSON.serialize(formComment));
        q.PCB_Customer_Comment__c = formComment;
        changes.add(q);
    }
}
if (!changes.isEmpty()) {
    update changes;
}
System.debug(LoggingLevel.ERROR, 'RESULT quotes=' + quotes.size() + ' updated=' + changes.size());
