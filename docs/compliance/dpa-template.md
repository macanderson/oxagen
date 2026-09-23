# Draft data processing addendum

**Draft. Legal review required. Not for signature in its current form.**

Your organization needs agreed terms for the personal data its agent records contain. This draft supplies a review structure. Counsel must complete the parties, governing law, processing schedule, transfer terms, and operational commitments. In particular, full cross-store erasure is incomplete in the [current implementation](data-retention.md).

## Parties and scope

Controller: [customer legal name, registration, address, and contact]. Processor: [Oxagen contracting legal name, registration, address, and privacy contact]. Effective date: [date]. Main agreement: [reference]. Applicable data protection law: [jurisdictions].

For customer content, the customer determines purposes and documented instructions. Oxagen processes that content to provide the contracted agent control plane. The parties must separately identify any account or billing processing for which Oxagen determines its own purposes. This draft does not settle that allocation.

## Instructions and confidentiality

Oxagen will process covered personal data only on documented lawful instructions, including instructions about transfers, except where applicable law requires otherwise. Oxagen will notify the customer of a conflicting legal requirement where law permits and flag an instruction it considers unlawful. Personnel permitted to process covered data must be subject to confidentiality duties and access restrictions.

## Security and assistance

The parties will attach agreed technical and organizational measures from the [security overview](security-overview.md), with dated production evidence. Oxagen will assist the customer, taking account of processing and available information, with rights requests, security obligations, impact assessments, and regulator consultations. The agreement must name request channels, responsibilities, and any charges.

Oxagen will notify the customer without undue delay after becoming aware of a covered personal-data breach and supply available information about affected data, consequences, mitigation, and contact details. Information may follow in stages. Counsel must agree contacts and any contractual timing without confusing a processor notice with a controller's regulator-notification deadline.

## Other processors and transfers

Attach the completed [subprocessor schedule](subprocessors.md). Specify [specific or general written authorization], advance notice [period], and a reasonable objection process [remedy and timetable]. Oxagen will impose applicable data-protection duties on authorized subprocessors and remain responsible as required by applicable law.

List every restricted international transfer and the lawful mechanism used for it. Attach applicable transfer clauses and assessments separately. An AWS region selection alone does not settle model-provider or email transfers.

## Return and deletion

At the end of services, the customer's choice will govern return or deletion, subject to lawful retention obligations. The parties must agree the format, deadline, backup lifecycle, retained categories, and evidence of completion. Do not sign a deletion promise until the multi-store gaps in [data retention](data-retention.md) have an implemented, tested process or a legally reviewed arrangement that can meet the commitment. Partial identity cleanup is not full erasure.

## Information and audits

Oxagen will make available information needed to demonstrate compliance with the agreed processing obligations and permit audits as required by applicable law. Agree notice, confidentiality, scope, and practical access arrangements without removing statutory rights. A source-backed questionnaire is not a SOC 2 report.

## Processing schedule

- Subject and purpose: governed agent activity, identity administration, attribution, and records for the services in the order form.
- Nature: collection, storage, retrieval, analysis of recorded activity, authorized disclosure, export, and deletion where implemented and agreed.
- Duration: [service period and each retention exception].
- Data subjects: [operators, administrators, personnel, and third parties whose data customer content contains].
- Data categories: identifiers, contact details, access metadata, recorded prompts and outputs, repository content, cost attribution, and [customer-specific categories].
- Sensitive categories: [exclude by agreement or enumerate with additional measures]. Do not assume arbitrary prompts contain none.
- Contacts, security measures, approved recipients, countries, and transfer safeguards: [complete attached schedules].

## Review references

The European Commission publishes [controller-processor clauses under Article 28](https://commission.europa.eu/publications/standard-contractual-clauses-controllers-and-processors-eueea_en). Its [SCC guidance](https://commission.europa.eu/law/law-topic/data-protection/international-dimension-data-protection/new-standard-contractual-clauses-questions-and-answers-overview_en) distinguishes those clauses from international-transfer clauses. Counsel should select the relevant instruments. This original draft does not reproduce or replace them.
