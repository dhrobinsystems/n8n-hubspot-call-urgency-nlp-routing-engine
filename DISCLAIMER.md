# ⚠️ Disclaimer & Liability Limitation

**Use at your own risk.** The code, workflows, and scripts in this repository (**n8n-hubspot-call-urgency-nlp-routing-engine**) are provided for educational and architectural demonstration purposes.

**No Liability:** The author and dhRobin Systems accept no responsibility or liability for any direct, indirect, incidental, or consequential damages that result from using, misusing, or deploying these scripts. This includes, without limitation:
- missed, delayed or false escalations;
- lost deals or churned customers;
- incorrect urgency or sentiment scores written to contact or deal records;
- overwritten CRM properties;
- Slack messages sent to the wrong audience;
- AI provider or HubSpot usage charges;
- decisions made on the basis of automated call analysis.

**No Warranty:** All software, n8n JSON blueprints, JavaScript modules and prompts are provided "AS IS", without warranty of any kind, express or implied. This includes, but is not limited to, warranties of merchantability, fitness for a particular purpose, and non-infringement. Lexicon and AI-based sentiment and urgency scoring are probabilistic. They can misread sarcasm, accents, transcription errors, domain jargon, mixed-language calls and cultural differences in tone, and they can be manipulated by text inside a transcript. PII redaction is pattern-based and will not catch every form of personal data.

**Production Testing Required:** Always test thoroughly in an isolated staging environment, such as a HubSpot developer test account or sandbox, with `SANDBOX_MODE=true` and `DRY_RUN=true` enabled, before you connect live HubSpot, AI provider or Slack credentials. Run the offline simulator (`node scripts/simulate-sandbox-run.js`) after every change to the workflow, thresholds or prompt. Treat every urgency score, sentiment label, summary and escalation as decision support that a person must review. Never use them as the sole basis for decisions about a customer or an employee.

**Third-Party APIs & Compliance:** You alone are responsible for complying with the terms of service, rate limits, data privacy regulations (GDPR/CCPA and others) and security policies of HubSpot, your AI provider (e.g. OpenAI or Anthropic), Slack, your telephony or transcription provider, and any connected services. That includes:
- complying with call-recording and transcription consent laws in every jurisdiction you operate in, including one-party and all-party consent rules, and telling callers how call content is analysed;
- confirming a lawful basis and a data processing agreement before sending call transcripts, even redacted ones, to an AI provider, and checking the provider's data retention and training settings;
- keeping sensitive and special-category data (health, payment, government IDs) out of transcripts, CRM properties, prompts and Slack, and verifying that redaction works for your call content;
- honouring data subject rights (access, correction, deletion) for scores and summaries stored on contact and deal records;
- limiting who can read the escalation channels, the n8n execution data and the CRM properties this workflow writes;
- protecting the inbound webhook with a strong shared secret, rotating it regularly, and remembering that n8n execution data stores the raw request headers of every delivery;
- reviewing every automatically created or updated record and every escalation;
- rotating any token or secret that is ever exposed in logs, screenshots, exports or version control.

**Not Legal or Compliance Advice:** Nothing in this repository is legal, privacy or employment advice. Consult qualified counsel about call recording, AI processing and data protection obligations in your jurisdictions before you deploy.

**Synthetic Data Only:** All people, companies, email addresses, phone numbers, card numbers, record IDs, portal IDs, transcripts and URLs in this repository are fictional placeholders. Examples include "Jane Doe", "EnterpriseCorp Inc", portal `99000001`, `*.example.com`, 555-01xx numbers and the public `4111…` test card. Any resemblance to real people or organisations is coincidental.

The full disclaimer is also referenced from README.md.

## License

Released under the MIT License. Copyright (c) 2026 DH Robin (dhRobin Systems). See [LICENSE](LICENSE).

---

Full text: DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 DH Robin (dhRobin Systems) · Provided as-is, see the disclaimer.
