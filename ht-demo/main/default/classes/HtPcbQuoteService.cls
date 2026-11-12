/**
 * Creates PCB Instant Quote records and Sellium Conversation threads for the HT Global demo.
 * Implements a form-then-chat quote pattern on top of Conversation__c.
 */
public with sharing class HtPcbQuoteService {
    /** Plain exception: AuraHandledException hides its message ('Script-thrown exception') outside Aura. */
    public class HtPcbQuoteException extends Exception {}

    public class QuoteRequest {
        public String name;
        public String company;
        public String email;
        public String phone;
        public String boardType;
        public String singleUpOrArray;
        public String unitOfMeasure;
        public Decimal width;
        public Decimal length;
        public Decimal layers;
        public Decimal leadTimeDays;
        public Decimal quantity;
        public String itarClassification;
        public String comment;
        public String message;
        public String conversationId;
        public String quoteId;
    }

    public static HtPcbQuoteResult startQuote(QuoteRequest req) {
        HtPcbQuoteResult res = new HtPcbQuoteResult();
        Savepoint sp = Database.setSavepoint();
        try {
            validateStart(req);

            Account account = upsertAccount(req);
            Contact contact = upsertContact(req, account.Id);
            Opportunity opportunity = createOpportunity(req, account.Id, contact.Id);
            Quote quote = createQuote(req, opportunity.Id, contact.Id);
            createPcbLineItem(quote);
            Conversation__c conversation = createConversation(req, contact);
            createOpportunityContactRole(opportunity.Id, contact.Id);
            createInboundMessage(conversation.Id, buildFormSummary(req), req.name);
            if (String.isNotBlank(req.message)) {
                createInboundMessage(conversation.Id, req.message, req.name);
            }
            linkConversationToQuote(conversation.Id, quote.Id, account.Id);
            linkConversationToContact(conversation.Id, contact, account.Id);
            quote.PCB_Conversation_Id__c = conversation.Id;
            update quote;

            res.success = true;
            res.created = true;
            res.quoteId = quote.Id;
            res.conversationId = conversation.Id;
            res.opportunityId = opportunity.Id;
            res.accountId = account.Id;
            res.contactId = contact.Id;
            return res;
        } catch (Exception e) {
            Database.rollback(sp);
            res.success = false;
            res.errorMessage = e.getMessage();
            return res;
        }
    }

    public static HtPcbQuoteResult appendMessage(QuoteRequest req) {
        HtPcbQuoteResult res = new HtPcbQuoteResult();
        Savepoint sp = Database.setSavepoint();
        try {
            if (String.isBlank(req.conversationId)) {
                throw new HtPcbQuoteException('conversationId is required');
            }
            if (String.isBlank(req.message)) {
                throw new HtPcbQuoteException('message is required');
            }

            Conversation__c conversation = [
                SELECT Id, DisplayName__c, IsClosed__c
                FROM Conversation__c
                WHERE Id = :req.conversationId
                LIMIT 1
            ];
            if (conversation.IsClosed__c == true) {
                throw new HtPcbQuoteException('Conversation is closed');
            }

            createInboundMessage(conversation.Id, req.message, conversation.DisplayName__c);

            if (String.isNotBlank(req.quoteId)) {
                Quote quote = [
                    SELECT Id, PCB_Customer_Comment__c, Description
                    FROM Quote
                    WHERE Id = :req.quoteId
                    LIMIT 1
                ];
                String prior = String.isBlank(quote.PCB_Customer_Comment__c)
                    ? ''
                    : quote.PCB_Customer_Comment__c + '\n';
                quote.PCB_Customer_Comment__c = prior + req.message;
                update quote;
                res.quoteId = quote.Id;
            }

            res.success = true;
            res.created = false;
            res.conversationId = conversation.Id;
            return res;
        } catch (Exception e) {
            Database.rollback(sp);
            res.success = false;
            res.errorMessage = e.getMessage();
            return res;
        }
    }

    /**
     * Customer-visible replies (team or agent) on a web quote conversation.
     * The conversationId/quoteId pair must match, otherwise nothing is returned.
     */
    /**
     * Sellium stores Body__c as sanitized HTML (It's -> It&#39;s, & -> &amp;, simple tags allowed).
     * The website renders plain text (textContent), so turn line breaks into newlines, drop tags and
     * decode entities here.
     */
    @TestVisible
    private static String toPlainText(String html) {
        if (html == null) {
            return null;
        }
        String text = html.replaceAll('(?i)<br\\s*/?>', '\n').replaceAll('(?i)</p>\\s*<p[^>]*>', '\n\n');
        text = text.replaceAll('<[^>]+>', '');
        return text.unescapeHtml4();
    }

    public static HtPcbQuoteMessagesResult getMessages(String conversationId, String quoteId, String after) {
        HtPcbQuoteMessagesResult res = new HtPcbQuoteMessagesResult();
        res.serverTime = System.now();
        res.success = false;
        res.errorMessage = 'Conversation not found';
        try {
            if (String.isBlank(conversationId) || String.isBlank(quoteId)) {
                return res;
            }
            Id convId = (Id) conversationId;
            Id qId = (Id) quoteId;
            Integer matches = [
                SELECT COUNT()
                FROM Quote
                WHERE Id = :qId AND PCB_Conversation_Id__c = :conversationId
            ];
            if (matches == 0) {
                return res;
            }
            Datetime afterTime = null;
            if (String.isNotBlank(after)) {
                try {
                    afterTime = (Datetime) JSON.deserialize('"' + after + '"', Datetime.class);
                } catch (Exception ignored) {
                    afterTime = null;
                }
            }
            List<ConversationMessage__c> rows = afterTime == null
                ? [
                    SELECT Id, Body__c, SenderDisplayName__c, SentDate__c, CreatedDate,
                           IsHumanMessage__c, IsAgentMessage__c
                    FROM ConversationMessage__c
                    WHERE Conversation__c = :convId
                      AND IsInbound__c = false AND IsInternal__c = false AND IsSystemMessage__c = false
                    ORDER BY CreatedDate ASC, Id ASC
                    LIMIT 100
                ]
                : [
                    SELECT Id, Body__c, SenderDisplayName__c, SentDate__c, CreatedDate,
                           IsHumanMessage__c, IsAgentMessage__c
                    FROM ConversationMessage__c
                    WHERE Conversation__c = :convId
                      AND IsInbound__c = false AND IsInternal__c = false AND IsSystemMessage__c = false
                      AND CreatedDate > :afterTime
                    ORDER BY CreatedDate ASC, Id ASC
                    LIMIT 100
                ];
            for (ConversationMessage__c row : rows) {
                HtPcbQuoteMessagesResult.Item item = new HtPcbQuoteMessagesResult.Item();
                item.id = row.Id;
                item.body = toPlainText(row.Body__c);
                item.fromAgent = row.IsAgentMessage__c == true;
                item.fromTeam = row.IsHumanMessage__c == true;
                item.sender = String.isNotBlank(row.SenderDisplayName__c)
                    ? row.SenderDisplayName__c
                    : (item.fromAgent ? 'HT Global assistant' : 'HT Global team');
                item.sentAt = row.SentDate__c != null ? row.SentDate__c : row.CreatedDate;
                res.messages.add(item);
            }
            res.success = true;
            res.errorMessage = null;
            return res;
        } catch (Exception e) {
            res.messages = new List<HtPcbQuoteMessagesResult.Item>();
            res.success = false;
            res.errorMessage = 'Conversation not found';
            return res;
        }
    }

    private static void validateStart(QuoteRequest req) {
        if (req == null) {
            throw new HtPcbQuoteException('Request body is required');
        }
        if (String.isBlank(req.name)) {
            throw new HtPcbQuoteException('name is required');
        }
        if (String.isBlank(req.company)) {
            throw new HtPcbQuoteException('company is required');
        }
        if (String.isBlank(req.email) || !req.email.contains('@')) {
            throw new HtPcbQuoteException('A valid email is required');
        }
        if (req.quantity == null || req.quantity < 1) {
            throw new HtPcbQuoteException('Quantity is required.');
        }
    }

    /**
     * Matches by name. An existing account is never overwritten: only a blank phone may be filled.
     */
    private static Account upsertAccount(QuoteRequest req) {
        List<Account> existing = [
            SELECT Id, Name, Phone
            FROM Account
            WHERE Name = :req.company
            LIMIT 1
        ];
        if (existing.isEmpty()) {
            Account created = new Account(Name = req.company, Phone = blankToNull(req.phone));
            insert created;
            return created;
        }
        Account account = existing[0];
        if (String.isBlank(account.Phone) && String.isNotBlank(req.phone)) {
            account.Phone = req.phone;
            update account;
        }
        return account;
    }

    /**
     * Matches by email. An existing contact keeps its name, phone and account: only blank phone or
     * blank account may be filled.
     */
    private static Contact upsertContact(QuoteRequest req, Id accountId) {
        List<Contact> existing = [
            SELECT Id, FirstName, LastName, Email, Phone, AccountId
            FROM Contact
            WHERE Email = :req.email
            LIMIT 1
        ];
        if (existing.isEmpty()) {
            List<String> parts = req.name.trim().split('\\s+', 2);
            Contact created = new Contact(
                Email = req.email,
                AccountId = accountId,
                Phone = blankToNull(req.phone),
                FirstName = parts.size() > 1 ? parts[0] : null,
                LastName = parts.size() > 1 ? parts[1] : parts[0]
            );
            insert created;
            return created;
        }
        Contact contact = existing[0];
        Boolean changed = false;
        if (String.isBlank(contact.Phone) && String.isNotBlank(req.phone)) {
            contact.Phone = req.phone;
            changed = true;
        }
        if (contact.AccountId == null) {
            contact.AccountId = accountId;
            changed = true;
        }
        if (changed) {
            update contact;
        }
        return contact;
    }

    private static Opportunity createOpportunity(QuoteRequest req, Id accountId, Id contactId) {
        Opportunity opportunity = new Opportunity(
            Name = 'PCB Quote - ' + req.company,
            AccountId = accountId,
            StageName = 'Prospecting',
            CloseDate = Date.today().addDays(14),
            Description = 'HT Global Circuits Instant Quote request'
        );
        insert opportunity;
        return opportunity;
    }

    private static Quote createQuote(QuoteRequest req, Id opportunityId, Id contactId) {
        Quote quote = new Quote(
            Name = 'PCB RFQ - ' + req.company,
            OpportunityId = opportunityId,
            Status = 'Draft',
            ContactId = contactId,
            Email = req.email,
            Phone = req.phone,
            Pricebook2Id = HtPcbQuoteLines.standardPricebookId(),
            Description = buildFormSummary(req),
            PCB_Board_Type__c = req.boardType,
            PCB_Single_Up_Or_Array__c = req.singleUpOrArray,
            PCB_Unit_Of_Measure__c = req.unitOfMeasure,
            PCB_Board_Width__c = req.width,
            PCB_Board_Length__c = req.length,
            PCB_Layer_Count__c = req.layers,
            PCB_Lead_Time_Days__c = req.leadTimeDays,
            PCB_Quantity__c = req.quantity,
            PCB_ITAR_Classification__c = req.itarClassification,
            PCB_Customer_Comment__c = req.comment
        );
        insert quote;
        return quote;
    }

    private static Conversation__c createConversation(QuoteRequest req, Contact contact) {
        Conversation__c conversation = new Conversation__c(
            DisplayName__c = req.name,
            ExternalContactId__c = req.email,
            ExternalReference__c = 'ht-pcb:' + req.email.toLowerCase(),
            Channel__c = 'Web',
            Language__c = 'en-US',
            PhoneNumber__c = req.phone,
            LastMessagePreview__c = 'New PCB Instant Quote request',
            IsHumanInTheLoop__c = false,
            NeedsHumanIntervention__c = false,
            IsClosed__c = false,
            HadHumanIntervention__c = false,
            HasClientInterest__c = true,
            FollowUpSent__c = false,
            HadError__c = false,
            MessageSequence__c = 0
        );
        // Channel picklist may not include Web in every package version; fall back quietly.
        try {
            insert conversation;
        } catch (DmlException e) {
            conversation.Channel__c = null;
            insert conversation;
        }
        return conversation;
    }

    private static void createInboundMessage(Id conversationId, String body, String senderName) {
        ConversationMessage__c message = new ConversationMessage__c(
            Conversation__c = conversationId,
            Body__c = body,
            IsInbound__c = true,
            IsAgentMessage__c = false,
            IsHumanMessage__c = false,
            IsInternal__c = false,
            IsSystemMessage__c = false,
            SenderDisplayName__c = senderName,
            SentDate__c = System.now(),
            DeliveryStatus__c = 'Delivered'
        );
        insert message;

        Conversation__c conversation = [
            SELECT Id, MessageSequence__c
            FROM Conversation__c
            WHERE Id = :conversationId
            LIMIT 1
        ];
        Decimal sequence = conversation.MessageSequence__c == null
            ? 1
            : conversation.MessageSequence__c + 1;
        conversation.MessageSequence__c = sequence;
        conversation.LastMessagePreview__c = body != null && body.length() > 240
            ? body.substring(0, 240)
            : body;
        update conversation;
    }

    private static void linkConversationToQuote(Id conversationId, Id quoteId, Id accountId) {
        insert new ConversationLink__c(
            Conversation__c = conversationId,
            Account__c = accountId,
            RelatedObjectApiName__c = 'Quote',
            RelatedRecordId__c = String.valueOf(quoteId),
            RelatedRecordName__c = 'PCB Quote',
            LinkType__c = 'Primary'
        );
    }

    private static void linkConversationToContact(Id conversationId, Contact contact, Id accountId) {
        String fullName = String.join(
            new List<String>{ nullToEmpty(contact.FirstName), nullToEmpty(contact.LastName) }, ' '
        ).trim();
        insert new ConversationLink__c(
            Conversation__c = conversationId,
            Account__c = accountId,
            RelatedObjectApiName__c = 'Contact',
            RelatedRecordId__c = String.valueOf(contact.Id),
            RelatedRecordName__c = fullName,
            LinkType__c = 'Secondary'
        );
    }

    private static void createOpportunityContactRole(Id opportunityId, Id contactId) {
        insert new OpportunityContactRole(
            OpportunityId = opportunityId,
            ContactId = contactId,
            IsPrimary = true,
            Role = 'Decision Maker'
        );
    }

    /** The PCB Fabrication line is best effort: a missing product must not fail the visitor. */
    private static void createPcbLineItem(Quote quote) {
        try {
            PricebookEntry entry = HtPcbQuoteLines.pcbEntry(quote.Pricebook2Id);
            if (entry == null) {
                System.debug(LoggingLevel.WARN, 'HtPcbQuoteService: PCB Fabrication product not found; quote ' + quote.Id + ' has no line item.');
                return;
            }
            insert new QuoteLineItem(
                QuoteId = quote.Id,
                PricebookEntryId = entry.Id,
                Product2Id = entry.Product2Id,
                Quantity = quote.PCB_Quantity__c,
                UnitPrice = 0,
                Description = HtPcbQuoteLines.specSummary(quote)
            );
        } catch (Exception e) {
            System.debug(LoggingLevel.WARN, 'HtPcbQuoteService: line item skipped for quote ' + quote.Id + ': ' + e.getMessage());
        }
    }

    private static String blankToNull(String value) {
        return String.isBlank(value) ? null : value;
    }

    private static String buildFormSummary(QuoteRequest req) {
        List<String> lines = new List<String>{ 'PCB Instant Quote request' };
        addLine(lines, 'Name', req.name);
        addLine(lines, 'Company', req.company);
        addLine(lines, 'Email', req.email);
        addLine(lines, 'Phone', req.phone);
        addLine(lines, 'Board Type', req.boardType);
        addLine(lines, 'Single Up or Array', req.singleUpOrArray);
        addLine(lines, 'Unit', req.unitOfMeasure);
        addLine(lines, 'Width', HtPcbQuoteLines.fmt(req.width));
        addLine(lines, 'Length', HtPcbQuoteLines.fmt(req.length));
        addLine(lines, 'Layers', HtPcbQuoteLines.fmt(req.layers));
        addLine(lines, 'Lead Time Days', HtPcbQuoteLines.fmt(req.leadTimeDays));
        addLine(lines, 'Quantity', HtPcbQuoteLines.fmt(req.quantity));
        addLine(lines, 'ITAR Classification', req.itarClassification);
        addLine(lines, 'Comment', req.comment);
        return String.join(lines, '\n');
    }

    private static void addLine(List<String> lines, String label, String value) {
        if (String.isNotBlank(value)) {
            lines.add(label + ': ' + value);
        }
    }

    private static String nullToEmpty(String value) {
        return value == null ? '' : value;
    }
}
