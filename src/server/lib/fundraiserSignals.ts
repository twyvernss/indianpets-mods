import { extractPaymentIdentifiers, identifierKind } from './fingerprint.js';
import { collectLinks, extractUrls } from './urls.js';

/**
 * Does a post look like a fundraiser, whatever its flair says?
 *
 * Used to catch fundraisers posted under another flair, which would otherwise
 * slip past every check the app runs on fundraiser-flaired posts. The result
 * only ever puts a post in the modqueue for a human to look at; it never
 * removes anything, so it leans towards catching rather than towards silence.
 *
 * Pure and synchronous: no network, no state.
 */
export type FundraiserSignals = {
  likely: boolean;
  /** Short, human-readable reasons, strongest first. Empty when not likely. */
  reasons: string[];
};

const PLATFORM_LABEL: Readonly<Record<string, string>> = {
  ketto: 'Ketto link',
  milaap: 'Milaap link',
  gofundme: 'GoFundMe link',
  impactguru: 'ImpactGuru link',
  donatekart: 'Donatekart link',
  give: 'Give.do link',
  fueladream: 'FuelADream link',
};

/**
 * Words that, two at a time, mark a post as asking for money. Each entry is
 * one signal however many of its forms appear, so "donate, donation, donors"
 * counts once rather than three times.
 */
const KEYWORDS: readonly { label: string; pattern: RegExp }[] = [
  { label: 'fundraiser', pattern: /\bfund ?rais(?:e|er|ers|ing)\b|\bcrowd ?fund/iu },
  { label: 'donate', pattern: /\bdonat(?:e|es|ed|ing|ion|ions)\b|\bdonors?\b/iu },
  { label: 'contribute', pattern: /\bcontribut(?:e|ion|ions|ing)\b/iu },
  { label: 'payment app', pattern: /\b(?:g ?pay|google pay|phone ?pe|paytm|upi|bhim)\b/iu },
  { label: 'bill or cost', pattern: /\b(?:vet|medical|hospital|treatment|surgery|operation) (?:bills?|costs?|expenses?|charges)\b/iu },
  { label: 'asking for money', pattern: /\b(?:need|raise|raising|short of|arrange) (?:funds?|money)\b|\bfinancial (?:help|support|aid)\b|\bany amount\b/iu },
  { label: 'account details', pattern: /\b(?:a\/c|account (?:no|number)|ifsc)\b/iu },
  { label: 'Hindi', pattern: /\b(?:madad|paise|paisa|chanda|daan)\b/iu },
];

/** At least this many different keyword signals, when there is no link or UPI ID. */
const MIN_KEYWORDS = 2;

export function fundraiserSignals(input: { title: string; body: string; url: string }): FundraiserSignals {
  const reasons: string[] = [];

  // Strong: a link to a fundraising platform.
  for (const link of collectLinks(input, 10)) {
    const label = link.platform ? PLATFORM_LABEL[link.platform] : undefined;
    if (label && !reasons.includes(label)) reasons.push(label);
  }

  // Strong: payment details. Phone numbers alone are not counted - people
  // share a clinic's number in all kinds of posts.
  const text = `${input.title}\n${input.body}`;
  const kinds = new Set(extractPaymentIdentifiers(text).map(identifierKind));
  if (kinds.has('upi')) reasons.push('UPI ID');
  if (kinds.has('bank')) reasons.push('bank account');
  const strong = reasons.length > 0;

  // Weaker: wording. Links are stripped first so a URL slug cannot count.
  let plain = text;
  for (const url of extractUrls(text)) plain = plain.split(url).join(' ');
  const words = KEYWORDS.filter((keyword) => keyword.pattern.test(plain)).map((keyword) => keyword.label);

  if (strong) return { likely: true, reasons: [...reasons, ...words.map((word) => `"${word}"`)] };
  if (words.length >= MIN_KEYWORDS) return { likely: true, reasons: words.map((word) => `"${word}"`) };
  return { likely: false, reasons: [] };
}
