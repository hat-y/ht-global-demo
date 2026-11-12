import { LightningElement, api, wire } from 'lwc';
import { NavigationMixin } from 'lightning/navigation';
import { getRecord, getFieldValue } from 'lightning/uiRecordApi';
import CONTACT_ID from '@salesforce/schema/Quote.ContactId';
import ACCOUNT_ID from '@salesforce/schema/Quote.AccountId';
import ACCOUNT_NAME from '@salesforce/schema/Quote.Account.Name';
import OPP_ID from '@salesforce/schema/Quote.OpportunityId';
import OPP_NAME from '@salesforce/schema/Quote.Opportunity.Name';
import C_NAME from '@salesforce/schema/Contact.Name';
import C_TITLE from '@salesforce/schema/Contact.Title';
import C_EMAIL from '@salesforce/schema/Contact.Email';
import C_PHONE from '@salesforce/schema/Contact.Phone';

export default class HtCustomerCard extends NavigationMixin(LightningElement) {
    @api recordId;

    @wire(getRecord, { recordId: '$recordId', fields: [CONTACT_ID, ACCOUNT_ID, ACCOUNT_NAME, OPP_ID, OPP_NAME] })
    quote;

    @wire(getRecord, { recordId: '$contactId', fields: [C_NAME, C_TITLE, C_EMAIL, C_PHONE] })
    contact;

    get contactId() {
        return getFieldValue(this.quote.data, CONTACT_ID);
    }
    get accountId() {
        return getFieldValue(this.quote.data, ACCOUNT_ID);
    }
    get accountName() {
        return getFieldValue(this.quote.data, ACCOUNT_NAME);
    }
    get opportunityId() {
        return getFieldValue(this.quote.data, OPP_ID);
    }
    get opportunityName() {
        return getFieldValue(this.quote.data, OPP_NAME);
    }
    get loaded() {
        return Boolean(this.quote && this.quote.data);
    }
    get hasContact() {
        return Boolean(this.contactId && this.contact && this.contact.data);
    }
    get name() {
        return getFieldValue(this.contact.data, C_NAME);
    }
    get title() {
        return getFieldValue(this.contact.data, C_TITLE);
    }
    get email() {
        return getFieldValue(this.contact.data, C_EMAIL);
    }
    get phone() {
        return getFieldValue(this.contact.data, C_PHONE);
    }
    get emailHref() {
        return this.email ? 'mailto:' + this.email : null;
    }
    get phoneHref() {
        return this.phone ? 'tel:' + this.phone : null;
    }
    get initials() {
        return (this.name || '?')
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .map((p) => p[0].toUpperCase())
            .join('');
    }
    get subtitle() {
        return [this.title, this.accountName].filter(Boolean).join(' · ');
    }

    open(recordId, objectApiName) {
        this[NavigationMixin.Navigate]({
            type: 'standard__recordPage',
            attributes: { recordId, objectApiName, actionName: 'view' }
        });
    }
    openContact(event) {
        event.preventDefault();
        this.open(this.contactId, 'Contact');
    }
    openAccount(event) {
        event.preventDefault();
        this.open(this.accountId, 'Account');
    }
    openOpportunity(event) {
        event.preventDefault();
        this.open(this.opportunityId, 'Opportunity');
    }
}
