// Seeds believable English Sellium threads for the 4 HT Global demo quotes. Idempotent:
// a quote that already has a ConversationLink__c (RelatedObjectApiName__c='Quote') is skipped.
// Additive: creates Conversation__c, ConversationMessage__c, ConversationLink__c and sets Quote.PCB_Conversation_Id__c.
// Message tuples: [kind, minutesAfterQuoteCreated, body]; kind = in | agent | team | note
Set<Id> quoteIds = new Set<Id>{
    '0Q0g70000029PajCAE', '0Q0g70000029PkPCAU', '0Q0g70000029Q29CAE', '0Q0g70000029Q8bCAE'
};
Map<Id, List<List<Object>>> script = new Map<Id, List<List<Object>>>{
    '0Q0g70000029PajCAE' => new List<List<Object>>{
        new List<Object>{'in', 3, 'Hi, we need ENIG finish on these. Standard FR-4, 1.6 mm, green solder mask, white silkscreen.'},
        new List<Object>{'agent', 4, 'Thanks Alex! ENIG noted. Do you need controlled impedance on any traces, or is this a standard 4-layer stack-up?'},
        new List<Object>{'in', 9, 'Standard 4-layer stack-up is fine, no impedance control. Delivery in 10 days would be great.'}
    },
    '0Q0g70000029PkPCAU' => new List<List<Object>>{
        new List<Object>{'in', 2, 'This is a prototype run for our flight computer carrier board. We need ENIG, polyimide flex section 0.2 mm, and 50 ohm single-ended impedance control on the high-speed lines.'},
        new List<Object>{'in', 3, 'Stack-up: 8 layers, 2 flex layers in the middle. Delivery needed within 15 days, array of 4 boards per panel.'},
        new List<Object>{'agent', 4, 'Thanks Vince, that helps. One question: should the coverlay be placed on both sides of the flex section, or only on the outer side?'},
        new List<Object>{'note', 12, 'Check ITAR paperwork before pricing.'},
        new List<Object>{'team', 25, 'Hi Vince, this is the HT Global team. Your Rigid-Flex quote is being reviewed by engineering and we will send pricing shortly.'}
    },
    '0Q0g70000029Q29CAE' => new List<List<Object>>{
        new List<Object>{'in', 4, 'HASL finish is fine (lead-free if possible). 1.6 mm thickness, black solder mask. We need about 20 pieces.'},
        new List<Object>{'agent', 5, 'Got it Casey, lead-free HASL with black mask. What delivery date are you aiming for, so I can check lead times?'},
        new List<Object>{'in', 11, 'Ideally by the end of next week, but we can flex a few days.'}
    },
    '0Q0g70000029Q8bCAE' => new List<List<Object>>{
        new List<Object>{'in', 3, 'Flexible polyimide, 0.1 mm total thickness. Please add stiffener notes for the connector area: 0.2 mm FR-4 stiffener under the connector.'},
        new List<Object>{'agent', 4, 'Thanks Riley! Noted the stiffener under the connector. Do you want gold fingers (ENIG) on the connector pads?'},
        new List<Object>{'in', 8, 'Yes, ENIG on the connector pads please. Standard delivery is fine, around 2 weeks.'}
    }
};
String nz(Object v) { return v == null ? '' : String.valueOf(v); }

Set<Id> linked = new Set<Id>();
for (ConversationLink__c l : [SELECT RelatedRecordId__c FROM ConversationLink__c WHERE RelatedObjectApiName__c = 'Quote']) {
    if (l.RelatedRecordId__c != null && l.RelatedRecordId__c instanceof Id) { linked.add((Id) l.RelatedRecordId__c); }
}
List<Quote> quotes = [
    SELECT Id, Name, CreatedDate, PCB_Conversation_Id__c, PCB_Board_Type__c, PCB_Single_Up_Or_Array__c, PCB_Unit_Of_Measure__c,
           PCB_Board_Width__c, PCB_Board_Length__c, PCB_Layer_Count__c, PCB_Lead_Time_Days__c, PCB_Quantity__c,
           PCB_ITAR_Classification__c, PCB_Customer_Comment__c,
           Contact.Name, Contact.Email, Contact.Phone, Contact.AccountId, Contact.Account.Name
    FROM Quote WHERE Id IN :quoteIds ORDER BY CreatedDate
];
List<Quote> toUpdate = new List<Quote>();
for (Quote q : quotes) {
    if (linked.contains(q.Id)) { System.debug('SKIP ' + q.Name + ' (already linked)'); continue; }
    String name = q.Contact.Name; String email = q.Contact.Email;
    Conversation__c c = new Conversation__c(
        DisplayName__c = name, ExternalContactId__c = email, ExternalReference__c = 'ht-pcb:' + email.toLowerCase(),
        Channel__c = 'Web', Language__c = 'en-US', PhoneNumber__c = q.Contact.Phone,
        LastMessagePreview__c = 'New PCB Instant Quote request', IsHumanInTheLoop__c = false, NeedsHumanIntervention__c = false,
        IsClosed__c = false, HadHumanIntervention__c = false, HasClientInterest__c = true, FollowUpSent__c = false,
        HadError__c = false, MessageSequence__c = 0
    );
    insert c;
    String summary = String.join(new List<String>{
        'PCB Instant Quote request', 'Name: ' + name, 'Company: ' + q.Contact.Account.Name, 'Email: ' + email,
        'Phone: ' + nz(q.Contact.Phone), 'Board Type: ' + nz(q.PCB_Board_Type__c),
        'Single Up or Array: ' + nz(q.PCB_Single_Up_Or_Array__c), 'Unit: ' + nz(q.PCB_Unit_Of_Measure__c),
        'Width: ' + nz(q.PCB_Board_Width__c), 'Length: ' + nz(q.PCB_Board_Length__c), 'Layers: ' + nz(q.PCB_Layer_Count__c),
        'Lead Time Days: ' + nz(q.PCB_Lead_Time_Days__c), 'Quantity: ' + nz(q.PCB_Quantity__c),
        'ITAR Classification: ' + nz(q.PCB_ITAR_Classification__c), 'Comment: ' + nz(q.PCB_Customer_Comment__c)
    }, '\n');
    List<List<Object>> steps = new List<List<Object>>{ new List<Object>{'in', 0, summary} };
    steps.addAll(script.get(q.Id));
    List<ConversationMessage__c> msgs = new List<ConversationMessage__c>();
    String lastPreview;
    for (List<Object> s : steps) {
        String kind = (String) s[0]; Integer mins = (Integer) s[1]; String body = (String) s[2];
        msgs.add(new ConversationMessage__c(
            Conversation__c = c.Id, Body__c = body,
            IsInbound__c = kind == 'in', IsAgentMessage__c = kind == 'agent', IsHumanMessage__c = kind == 'team' || kind == 'note',
            IsInternal__c = kind == 'note', IsSystemMessage__c = false,
            SenderDisplayName__c = kind == 'in' ? name : (kind == 'agent' ? 'HT Global assistant' : 'HT Global team'),
            SentDate__c = q.CreatedDate.addMinutes(mins).addSeconds(30),
            DeliveryStatus__c = 'Delivered'
        ));
        if (kind != 'note') { lastPreview = body; }
    }
    insert msgs;
    c.MessageSequence__c = msgs.size();
    c.LastMessagePreview__c = lastPreview.length() > 240 ? lastPreview.substring(0, 240) : lastPreview;
    update c;
    insert new ConversationLink__c(
        Conversation__c = c.Id, Account__c = q.Contact.AccountId, RelatedObjectApiName__c = 'Quote',
        RelatedRecordId__c = String.valueOf(q.Id), RelatedRecordName__c = 'PCB Quote', LinkType__c = 'Primary'
    );
    toUpdate.add(new Quote(Id = q.Id, PCB_Conversation_Id__c = c.Id));
    System.debug('CREATED ' + q.Name + ' quote=' + q.Id + ' conversation=' + c.Id + ' messages=' + msgs.size());
}
update toUpdate;
