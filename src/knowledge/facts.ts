// Statements the knowledge layer must never contradict, and the phrasings that would
// contradict them. The test suite asks the questions below and checks the top passages
// against these lists. The list is public wording policy, kept self-contained because
// this repository is public.

export interface RedLine {
  /** What a person might ask. */
  question: string;
  /** At least one of these must appear in the top passages (case-insensitive). */
  mustContainOneOf: string[];
  /** None of these may appear in the top passages (case-insensitive). */
  mustNotContain: string[];
}

export const RED_LINES: RedLine[] = [
  {
    question: "Is the token the property itself? What do I own when I hold a Fabrica token?",
    mustContainOneOf: ["beneficial interest", "beneficial owner", "beneficiary"],
    mustNotContain: ["the token is the property", "token is the land", "owns the land directly"],
  },
  {
    question: "Who is the trustee of the trust that holds my property?",
    mustContainOneOf: ["trustee"],
    mustNotContain: ["fabrica is the trustee", "fabrica acts as trustee", "fabrica manages your trust", "fabrica holds title"],
  },
  {
    question: "What yield or return does the lending pool pay depositors?",
    mustContainOneOf: ["lending", "pool", "interest"],
    mustNotContain: ["guaranteed return", "guaranteed yield", "risk-free"],
  },
  {
    question: "How much does Fabrica cost? What are the fees?",
    mustContainOneOf: ["fee"],
    mustNotContain: ["free forever", "no fees ever"],
  },
  {
    question: "Does Fabrica hold my property or custody my land?",
    mustContainOneOf: ["trust", "trustee", "beneficial"],
    mustNotContain: ["fabrica custodies", "fabrica holds your property", "fabrica holds title"],
  },
  {
    question: "What are Property checks and what does the five digit number mean?",
    mustContainOneOf: ["property checks", "checks"],
    mustNotContain: ["percentage of", "confidence rating"],
  },
];

/** Phrases that never belong in any text the server emits about Fabrica. */
export const FORBIDDEN_EVERYWHERE: string[] = ["open source platform", "guaranteed return", "always equal $1", "always worth $1"];
