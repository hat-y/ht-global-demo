# HT Global Circuits demo (VAI-181)

English demo for Vince on Salesforce org `ht-global`.

## What is live

- **Sellium Console, same version as the client production console.** It is the production console layer (inbox, thread, assign, notes with @mentions, detail sheet, supervision), deployed from source on top of package 2.26. The UI is English and branded HT Global (#044E72 + HT logo).
- **Revio is installed but hidden.** The `Conversation_Campaigns` app is not visible (Admin profile and both Revio permission sets). Scope is Sellium only for now.
- **Sellium Console app tabs:** Home, Console, **Quotes**, Setup, Reports, Dashboards.
- **Quote page (`HT_Quote_Record_Page`).** It opens on a **Conversation** tab that embeds the Sellium thread of the linked conversation, with an "Open in Sellium Console" button. The Details and Related tabs hold the standard layout, including the **PCB Instant Quote** section.
- **PCB Instant Quote API:** `/services/apexrest/htglobal/quote`.
  - `POST` creates Account, Contact, Opportunity, Quote, Conversation, the form-summary message and the Quote link.
  - `PATCH` appends a customer message.
  - `GET ?conversationId=&quoteId=&after=` returns the customer-visible outbound messages (team and agent). It never returns internal notes, and it requires the quote and conversation to match.
- **Demo website** under `website/`: a clone of htglobalcircuits.com with a floating **quote assistant** (round button, bottom right, on every page; `/quote` opens it automatically).
  - First it collects the RFQ as a guided 3-step form inside the chat (Contact, Board, Details), which creates the Quote and its conversation.
  - Then it is a free chat: the n8n assistant answers, and team replies from the Sellium Console show up too (it polls the Salesforce thread).
  - The conversation survives page changes and reloads (sessionStorage). "Start a new quote" is in the panel menu.
  - Code: `website/public/chat-widget.js` and `chat-widget.css`, with no dependencies.
- **Seed data.** Four quotes with English threads: Summit Avionics (Vince Carter, the main story, with a team reply and an internal ITAR note), Aero Circuits, Lakeview Robotics, Cascade Sensors. Re-seed safely with `sf apex run -o ht-global -f scripts/seed-ht-demo-threads.apex`; it is idempotent.
- **n8n integration user.** It signs in through the JWT External Client App `HT_Global_N8N_Integration`. Setup notes are in `.secrets/ht-global-n8n/README.md`, which is gitignored.

- **AI quote agent on n8n.** It runs on the vendor n8n (`<n8n-host>`) as the workflow "HT Global - PCB Quote Agent" (tag `ht-global-demo`) and is modelled on SelliumWork, without Meta/WhatsApp.
  - Flow: webhook with a shared secret → Sellium `/conversation/v1/context` + Quote → prepare context → LLM (OpenRouter) → output guard → Sellium `/message/` + Quote PCB fields.
  - It asks for missing PCB specs in English, never quotes prices, and stays silent when a human took control in the console.
  - Its code copy is in `n8n/ht-pcb-quote-agent.workflow.ts`.

## Public URL and deploy

- Live at **https://htglobal.vantegrateos.com**. It is public, but `noindex` and rate-limited. It runs as the Docker container `ht-global-web` on the OCI demo VM (<vm-ip>), behind the shared Caddy.
- Repo: `hat-y/ht-global-demo` (`force-app/` excluded).
- Deploy:
  - A push to `main` runs `.github/workflows/deploy.yml`: tests, then `deploy/deploy.sh` on the VM over a forced-command SSH key, then a health check.
  - Manual deploy: `ssh -i .secrets/ht-global-ci/id_ed25519 ubuntu@<vm-ip> deploy`. The key can only run `deploy.sh`.
- Details, rollback and key rotation: `deploy/README.md`.

## Pending

- GitHub Actions does not start on account `hat-y` (`startup_failure` on every private repo, account billing/Actions). Until that is fixed, deploy manually with the command above.
- The agent answers only conversations created by the integration user (Conversation__c is private). The 4 seeded threads are admin-owned: they are for showing, and live RFQs from the website get agent replies.

## Orgs

| Alias | Role |
|---|---|
| `ht-global` | Demo target (local default in this project) |
| (reference orgs) | Read-only sources of the earlier quote pattern and the Sellium console version; not part of this repo |

## Operator walkthrough

1. Open the **Sellium Console** app.
2. **Console** tab: select Vince Carter / Summit Avionics. Show the thread, the internal note and assignment.
3. **Quotes** tab: open "PCB RFQ - Summit Avionics". The Conversation tab shows the same thread; Details shows the PCB fields.
4. Live RFQ: run the website, click the round assistant button, fill the 3 steps and chat. The assistant replies in a few seconds, and the new Quote appears under **Quotes** with its Conversation tab.
5. In the console, take control of that conversation and reply. The reply appears in the website chat and the assistant stops answering.

## Website

`website/.env` (gitignored; template in `website/.env.example`) sets `SF_AUTH=jwt`, so the server talks to Salesforce as the n8n integration user with the key in `.secrets/ht-global-n8n/`. It also sets the n8n webhook URL and secret. Without `SF_AUTH=jwt` it falls back to the `sf` CLI admin session, and the agent cannot answer new RFQs.

```bash
cd website
node server.js
```

Then open http://127.0.0.1:4173 (home) or http://127.0.0.1:4173/quote.

## Build and deploy

- Sellium layer: `SELLIUM_SOURCE_DIR=<console-repo> SELLIUM_PACKAGE_DIR=<package-repo> [SELLIUM_EXCLUDE='<client-vertical-regex>'] python3 scripts/build-sellium-console.py` builds `.tmp/htsellium` from the source console repo's `force-app`, with English object metadata taken from the package repo and the client vertical excluded (`SELLIUM_EXCLUDE` holds the client-specific name patterns, kept out of the repo). Deploy from that folder.
- HT customizations (deploy last, they win): `sf project deploy start -o ht-global -d ht-demo`.

## Known test state

`RunLocalTests`: 4239 methods, 698 failures.

- 666 are Revio, which is out of scope.
- The other 32 are environment or configuration issues:
  - the EmailMessage related-to type;
  - the missing `Revio_Operadores` group;
  - a Task validation rule;
  - the Spanish title check in the Notes test.
- All `HtPcb*` and `HtQuoteConversation*` tests pass.

## Placeholders

- The External Client App metadata (`ht-demo/.../externalClientApps` and `extlClntAppGlobalOauthSets`) carries placeholder values: contact email `admin@example.com` and callback URL `https://n8n.example.com/oauth/callback`. The org keeps its real values; do not deploy these two files as-is.
- `<n8n-host>` and `<vm-ip>` in the docs stand for your own n8n host and VM address. The n8n workflow source uses `__SF_INSTANCE_URL__`, `__SF_JWT_CREDENTIAL_ID__` and `__OPENROUTER_CREDENTIAL_ID__`, to be filled in before deploying.
