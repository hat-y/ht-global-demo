/**
 * REST-safe response for GET /htglobal/quote (customer-visible replies only).
 */
global class HtPcbQuoteMessagesResult {
    global class Item {
        global String id;
        global String body;
        global String sender;
        global Datetime sentAt;
        global Boolean fromTeam;
        global Boolean fromAgent;
    }
    global Boolean success;
    global String errorMessage;
    global List<Item> messages = new List<Item>();
    global Datetime serverTime;
}
