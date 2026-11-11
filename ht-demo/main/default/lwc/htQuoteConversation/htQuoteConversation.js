import { LightningElement, api, wire } from 'lwc';
import { NavigationMixin } from 'lightning/navigation';
import { refreshApex } from '@salesforce/apex';
import getThread from '@salesforce/apex/HtQuoteConversationController.getThread';

export default class HtQuoteConversation extends NavigationMixin(LightningElement) {
    @api recordId;
    result;

    @wire(getThread, { quoteId: '$recordId' })
    wiredThread(value) {
        this.result = value;
    }

    get data() {
        return this.result && this.result.data ? this.result.data : null;
    }
    get loading() {
        return !this.result || (!this.result.data && !this.result.error);
    }
    get hasError() {
        return Boolean(this.result && this.result.error);
    }
    get conversationId() {
        return this.data ? this.data.conversationId : null;
    }
    get noConversation() {
        return Boolean(this.data) && !this.data.conversationId;
    }
    get summary() {
        const n = this.data ? this.data.messages.length : 0;
        return n === 1 ? '1 message' : n + ' messages';
    }

    handleRefresh() {
        if (this.result) {
            refreshApex(this.result);
        }
    }

    openConsole() {
        this[NavigationMixin.Navigate]({
            type: 'standard__navItemPage',
            attributes: { apiName: 'Conversation_Console' },
            state: { c__conversationId: this.conversationId }
        });
    }
}
