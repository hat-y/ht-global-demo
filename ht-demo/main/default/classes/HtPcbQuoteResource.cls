/**
 * Public demo REST API for HT Global Circuits Instant Quote + chat.
 * POST /services/apexrest/htglobal/quote
 * PATCH /services/apexrest/htglobal/quote
 * GET /services/apexrest/htglobal/quote?conversationId=&quoteId=&after=
 */
@RestResource(urlMapping='/htglobal/quote/*')
global with sharing class HtPcbQuoteResource {
    @HttpPost
    global static HtPcbQuoteResult createQuote() {
        HtPcbQuoteService.QuoteRequest req = parseBody();
        return HtPcbQuoteService.startQuote(req);
    }

    @HttpGet
    global static HtPcbQuoteMessagesResult getMessages() {
        Map<String, String> params = RestContext.request == null
            ? new Map<String, String>()
            : RestContext.request.params;
        return HtPcbQuoteService.getMessages(
            params.get('conversationId'), params.get('quoteId'), params.get('after')
        );
    }

    @HttpPatch
    global static HtPcbQuoteResult appendMessage() {
        HtPcbQuoteService.QuoteRequest req = parseBody();
        return HtPcbQuoteService.appendMessage(req);
    }

    private static HtPcbQuoteService.QuoteRequest parseBody() {
        String body = RestContext.request == null || RestContext.request.requestBody == null
            ? null
            : RestContext.request.requestBody.toString();
        if (String.isBlank(body)) {
            return new HtPcbQuoteService.QuoteRequest();
        }
        return (HtPcbQuoteService.QuoteRequest) JSON.deserialize(body, HtPcbQuoteService.QuoteRequest.class);
    }
}
