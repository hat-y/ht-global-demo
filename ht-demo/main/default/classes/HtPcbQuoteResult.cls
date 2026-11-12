/**
 * REST-safe response for HT Global PCB Instant Quote endpoints.
 */
global class HtPcbQuoteResult {
    global Boolean success;
    global String quoteId;
    global String conversationId;
    global String opportunityId;
    global String accountId;
    global String contactId;
    global Boolean created;
    global String errorMessage;
    /** Set when a quote is created: messages created up to this moment are the intake transcript. */
    global Datetime serverTime;
}
