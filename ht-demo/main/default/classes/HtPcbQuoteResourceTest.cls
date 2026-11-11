@IsTest
private class HtPcbQuoteResourceTest {
    private static void callWith(String method, String body) {
        RestRequest req = new RestRequest();
        req.requestUri = '/services/apexrest/htglobal/quote';
        req.httpMethod = method;
        req.requestBody = Blob.valueOf(body);
        RestContext.request = req;
        RestContext.response = new RestResponse();
    }

    @IsTest
    static void postThenPatch_createsQuoteAndAppendsMessage() {
        callWith('POST', '{"name":"Sam Ortiz","company":"Rest Boards","email":"sam@restboards.example","boardType":"Rigid PCB","quantity":5,"message":"Hello"}');
        HtPcbQuoteResult created = HtPcbQuoteResource.createQuote();
        System.assertEquals(true, created.success, created.errorMessage == null ? 'ok' : created.errorMessage);

        callWith('PATCH', JSON.serialize(new Map<String, Object>{
            'conversationId' => created.conversationId,
            'quoteId' => created.quoteId,
            'message' => 'Second message'
        }));
        HtPcbQuoteResult appended = HtPcbQuoteResource.appendMessage();
        System.assertEquals(true, appended.success, appended.errorMessage == null ? 'ok' : appended.errorMessage);
        System.assertEquals(
            3,
            [SELECT COUNT() FROM ConversationMessage__c WHERE Conversation__c = :created.conversationId]
        );
    }

    @IsTest
    static void emptyBody_isRejectedWithoutThrowing() {
        callWith('POST', '');
        HtPcbQuoteResult res = HtPcbQuoteResource.createQuote();
        System.assertEquals(false, res.success);
    }

    @IsTest
    static void get_returnsTeamReplyForMatchingPair() {
        callWith('POST', '{"name":"Gia Poll","company":"Get Boards","email":"gia@getboards.example","boardType":"Rigid PCB","quantity":5,"message":"Hello"}');
        HtPcbQuoteResult created = HtPcbQuoteResource.createQuote();
        insert new ConversationMessage__c(
            Conversation__c = created.conversationId, Body__c = 'Team reply', IsInbound__c = false,
            IsHumanMessage__c = true, SenderDisplayName__c = 'HT Global team', SentDate__c = System.now()
        );

        RestRequest req = new RestRequest();
        req.httpMethod = 'GET';
        req.params.put('conversationId', created.conversationId);
        req.params.put('quoteId', created.quoteId);
        RestContext.request = req;
        RestContext.response = new RestResponse();
        HtPcbQuoteMessagesResult r = HtPcbQuoteResource.getMessages();
        System.assertEquals(true, r.success);
        System.assertEquals(1, r.messages.size());

        req.params.put('quoteId', '0Q0000000000000AAA');
        System.assertEquals(false, HtPcbQuoteResource.getMessages().success);
    }
}
