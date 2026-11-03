import type { FormField, UiResponse } from '@devvit/web/shared';
import { CONFIG } from './config.js';
import type { AppSettings } from './settings.js';
import { ANY_FLAIR, checklistItemsToText, matchesFundraiserFlair } from './settings.js';
import type { FollowUpStep } from './services/reminders.js';
import {
  DEFAULT_INTAKE_TEMPLATE,
  DEFAULT_NOTICE_TEMPLATE,
  DEFAULT_REMINDER_TEMPLATE,
  FOLLOW_UP_TEXT,
  FORM_TEXT,
} from './text.js';
import type { ChecklistItem, MessageTemplate } from './types.js';

/**
 * Form definitions.
 *
 * The verify flow is ONE form. Devvit cannot show or hide fields conditionally,
 * so an earlier design put the checklist behind a "show checklist" toggle that
 * opened a second form. Every checklist item is optional anyway, so simply
 * showing them in the same box is both simpler and fewer taps: the moderator
 * ticks whatever applies (or nothing) and presses Verify once.
 */

/** The field name used when the checklist is rendered as a single tick-list. */
export const CHECKLIST_FIELD = 'checklist';

/**
 * Builds the checklist portion of the verify form.
 *
 * Two shapes, because Devvit has no true checkbox field:
 *
 *  - `compact` (default) renders ONE multi-select, which is the closest thing
 *    Devvit offers to a tick-list and keeps the form short. Form length matters
 *    on mobile: Reddit draws the Verify/Cancel buttons at the end of the form's
 *    own scroll, and the app cannot pin them. A form that fits on screen is the
 *    only lever we have.
 *  - otherwise, one boolean per item, which Reddit renders as toggle switches.
 */
function checklistFields(items: readonly ChecklistItem[], compact: boolean): FormField[] {
  if (items.length === 0) return [];

  if (compact) {
    return [
      {
        type: 'select',
        name: CHECKLIST_FIELD,
        label: FORM_TEXT.checklistTitle,
        helpText: FORM_TEXT.checklistDescription,
        multiSelect: true,
        required: false,
        options: items.map((item) => ({ label: item.label, value: item.id })),
      },
    ];
  }

  return [
    {
      type: 'group',
      label: FORM_TEXT.checklistTitle,
      helpText: FORM_TEXT.checklistDescription,
      fields: items.map((item) => ({
        type: 'boolean' as const,
        name: item.id,
        label: item.label,
        defaultValue: false,
      })),
    },
  ];
}

/** The option a moderator picks to keep the built-in notice wording. */
export const DEFAULT_TEMPLATE_OPTION = 'default';

export function verifyFormResponse(input: {
  token: string;
  /** Moderator-only context line, or null. */
  authorSummary: string | null;
  items: readonly ChecklistItem[];
  compactChecklist: boolean;
  /** Pre-written notices. Empty means the picker is not shown at all. */
  templates: readonly MessageTemplate[];
}): UiResponse {
  // The author line goes at the top of the description rather than in a
  // disabled field, because a disabled field still looks like something the
  // moderator is meant to fill in.
  // Devvit collapses newlines inside a form description, so the author line is
  // joined with sentence punctuation rather than a blank line - otherwise it
  // runs straight into the next sentence.
  const description = input.authorSummary
    ? `${input.authorSummary}. ${FORM_TEXT.verifyDescription}`
    : FORM_TEXT.verifyDescription;

  return {
    showForm: {
      name: 'verifyForm',
      form: {
        title: FORM_TEXT.verifyTitle,
        description,
        acceptLabel: FORM_TEXT.verifyAccept,
        cancelLabel: FORM_TEXT.verifyCancel,
        fields: [
          // Only shown when the subreddit has actually written some; a
          // one-option dropdown is just clutter.
          ...(input.templates.length > 0
            ? ([
                {
                  type: 'select',
                  name: 'template',
                  label: 'Message to post',
                  helpText: 'Pick the wording that fits. Edit the list in the settings menu.',
                  options: [
                    { label: 'Default verification notice', value: DEFAULT_TEMPLATE_OPTION },
                    ...input.templates.map((template) => ({
                      label: template.label,
                      value: template.id,
                    })),
                  ],
                  defaultValue: [DEFAULT_TEMPLATE_OPTION],
                },
              ] satisfies FormField[])
            : []),
          ...checklistFields(input.items, input.compactChecklist),
          {
            type: 'paragraph',
            name: 'note',
            label: FORM_TEXT.noteLabel,
            helpText: FORM_TEXT.noteHelp,
            placeholder: FORM_TEXT.notePlaceholder,
            lineHeight: 2,
            required: false,
          },
        ],
      },
      // Values in `data` with no matching field are echoed back to the submit
      // endpoint, which is how the token survives without being shown.
      data: { token: input.token },
    },
  };
}

/** How many saved notices the editor offers. Matches CONFIG.maxMessageTemplates. */
export const NOTICE_SLOTS = CONFIG.maxMessageTemplates;

/**
 * The two editors - settings and bot messages - open in two steps: first a
 * one-field picker, then a small form for just the part picked.
 *
 * WHY: they used to be single forms of 30 fields and 14 large prefilled text
 * boxes. The Reddit mobile app received them (the server logged every open)
 * but did not display them. Small forms are what the mobile client renders
 * reliably - the verify form, which always worked on a phone, is one.
 */
export const PICK_FIELD = 'pick';

/** Reads a select's value, which arrives as a one-element array. */
export function pickedValue(raw: unknown): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : '';
}

/* ---------------------------------------------------------------------- */
/* Bot messages                                                            */
/* ---------------------------------------------------------------------- */

/** Which message is being edited. `saved0`..`saved4` are the saved notices. */
export type MessageChoice = 'default' | 'automod' | 'reminder' | `saved${number}`;

export function isMessageChoice(value: string): value is MessageChoice {
  if (value === 'default' || value === 'automod' || value === 'reminder') return true;
  const match = /^saved(\d)$/u.exec(value);
  return match !== null && Number(match[1]) < NOTICE_SLOTS;
}

/** Step 1: which message to edit. Saved notices are listed by their titles. */
export function noticesPickerResponse(current: AppSettings): UiResponse {
  const saved = Array.from({ length: NOTICE_SLOTS }, (_, index) => {
    const notice = current.messageTemplates[index];
    return {
      label: notice ? `Saved notice ${index + 1}: ${notice.label}` : `Saved notice ${index + 1} (empty)`,
      value: `saved${index}`,
    };
  });

  return {
    showForm: {
      name: 'noticesPickerForm',
      form: {
        title: 'Edit bot messages',
        description: 'Pick the message to edit.',
        acceptLabel: 'Open',
        cancelLabel: 'Cancel',
        fields: [
          {
            type: 'select',
            name: PICK_FIELD,
            label: 'Message',
            options: [
              { label: 'Default verification notice', value: 'default' },
              ...saved,
              { label: 'Reply when AutoModerator holds a fundraiser', value: 'automod' },
              { label: 'Asking the OP for an update', value: 'reminder' },
            ],
            defaultValue: ['default'],
            required: true,
          },
        ],
      },
    },
  };
}

/** Step 2: one message, prefilled with exactly what the bot posts now. */
export function noticeEditorResponse(current: AppSettings, choice: MessageChoice): UiResponse {
  const savedIndex = choice.startsWith('saved') ? Number(choice.slice(5)) : -1;
  const notice = savedIndex >= 0 ? current.messageTemplates[savedIndex] : undefined;

  const fields: FormField[] =
    savedIndex >= 0
      ? [
          {
            type: 'string',
            name: 'title',
            label: 'Title (shown when verifying)',
            helpText: 'Clear the title to delete this notice.',
            defaultValue: notice?.label ?? '',
          },
          { type: 'paragraph', name: 'body', label: 'Message', lineHeight: 6, defaultValue: notice?.body ?? '' },
        ]
      : [
          {
            type: 'paragraph',
            name: 'body',
            label: 'Message',
            helpText:
              choice === 'default'
                ? 'Clear to use the built-in text. Keep "not a guarantee" and "donate at your own discretion".'
                : choice === 'automod'
                  ? 'Clear to use the built-in text. Placeholders: {subreddit}, {op}.'
                  : 'Clear to use the built-in text. Placeholders: {subreddit}, {op}, {days}, {grace}.',
            lineHeight: 8,
            defaultValue:
              choice === 'default'
                ? current.customNoticeText || DEFAULT_NOTICE_TEMPLATE
                : choice === 'automod'
                  ? current.automodReplyText || DEFAULT_INTAKE_TEMPLATE
                  : current.customReminderText || DEFAULT_REMINDER_TEMPLATE,
          },
        ];

  const title =
    savedIndex >= 0
      ? `Saved notice ${savedIndex + 1}`
      : choice === 'default'
        ? 'Default verification notice'
        : choice === 'automod'
          ? 'AutoModerator hold reply'
          : 'Update request';

  return {
    showForm: {
      name: 'noticesForm',
      form: { title, acceptLabel: 'Save', cancelLabel: 'Cancel', fields },
      data: { choice },
    },
  };
}

/* ---------------------------------------------------------------------- */
/* Settings                                                                */
/* ---------------------------------------------------------------------- */

export const SETTINGS_SECTIONS = [
  { value: 'fundraisers', label: 'Fundraiser flair and rules' },
  { value: 'verify', label: 'Verifying' },
  { value: 'reminders', label: 'Follow-up reminders' },
  { value: 'detection', label: 'Duplicate links and alt accounts' },
  { value: 'wiki', label: 'Wiki log and history pages' },
  { value: 'reset', label: 'Reset to the app defaults' },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['value'];

export function isSettingsSection(value: string): value is SettingsSection {
  return SETTINGS_SECTIONS.some((section) => section.value === value);
}

/** Step 1: which section to change. */
export function settingsPickerResponse(current: AppSettings): UiResponse {
  return {
    showForm: {
      name: 'settingsPickerForm',
      form: {
        title: 'Fundraiser tools settings',
        description: current.enabled ? 'Pick what to change.' : 'The app is switched OFF. Pick what to change.',
        acceptLabel: 'Open',
        cancelLabel: 'Cancel',
        fields: [
          {
            type: 'select',
            name: PICK_FIELD,
            label: 'Section',
            options: SETTINGS_SECTIONS.map((section) => ({ label: section.label, value: section.value })),
            defaultValue: ['fundraisers'],
            required: true,
          },
        ],
      },
    },
  };
}

/**
 * Step 2: the fields of one section, prefilled with the EFFECTIVE values, so
 * what a moderator sees is what the app is currently doing. Saving writes a
 * runtime override for those fields only; the next action respects it.
 */
export function settingsFormResponse(
  current: AppSettings,
  /** The subreddit's live post flairs. Empty on a sub with none, e.g. a test sub. */
  availableFlairs: readonly { id: string; text: string }[] = [],
  section: SettingsSection = 'fundraisers',
): UiResponse {
  const label = SETTINGS_SECTIONS.find((entry) => entry.value === section)?.label ?? 'Settings';
  return {
    showForm: {
      name: 'settingsForm',
      form: {
        title: label,
        acceptLabel: 'Save',
        cancelLabel: 'Cancel',
        fields: settingsSectionFields(current, availableFlairs, section),
      },
      data: { section },
    },
  };
}

function settingsSectionFields(
  current: AppSettings,
  availableFlairs: readonly { id: string; text: string }[],
  section: SettingsSection,
): FormField[] {
  const { reminders } = CONFIG;

  switch (section) {
    case 'fundraisers':
      return [
        {
          type: 'boolean',
          name: 'enabled',
          label: 'App enabled',
          helpText: 'Master switch. Off stops every automatic action.',
          defaultValue: current.enabled,
        },
        flairField(current, availableFlairs),
        {
          type: 'boolean',
          name: 'reportMisflairedFundraisers',
          label: 'Report fundraisers posted under another flair',
          helpText: 'Donation link, UPI ID, bank account, or words like "donate", "vet bill", "GPay". Never removes.',
          defaultValue: current.reportMisflairedFundraisers,
        },
        {
          type: 'number',
          name: 'fundraiserLimitHours',
          label: 'Hours between fundraisers from one person',
          helpText: 'A second one sooner is reported, never removed. 0 = no limit.',
          defaultValue: current.fundraiserLimitHours,
        },
      ];

    case 'verify':
      return [
        {
          type: 'boolean',
          name: 'showVerifyingModInComment',
          label: 'Name the verifying mod in the public comment',
          helpText: 'Not recommended: it brings mods unsolicited DMs.',
          defaultValue: current.showVerifyingModInComment,
        },
        {
          type: 'boolean',
          name: 'compactChecklist',
          label: 'Compact checklist (one tick-list)',
          defaultValue: current.compactChecklist,
        },
        {
          type: 'paragraph',
          name: 'checklistItems',
          label: 'Checklist items, one per line',
          helpText: `Blank = built-in list. Up to ${CONFIG.maxChecklistItems}.`,
          lineHeight: 6,
          defaultValue: checklistItemsToText(current.checklistItems),
        },
        {
          type: 'boolean',
          name: 'showAuthorSummary',
          label: "Show the author's history on the verify form",
          defaultValue: current.showAuthorSummary,
        },
        {
          type: 'boolean',
          name: 'automodReplyEnabled',
          label: 'Reply to the OP listing the documents we need',
          helpText: 'When AutoModerator holds a fundraiser. Off if AutoModerator already says this.',
          defaultValue: current.automodReplyEnabled,
        },
      ];

    case 'reminders':
      return [
        {
          type: 'boolean',
          name: 'staleRemindersEnabled',
          label: 'Ask the OP for an update on old fundraisers',
          defaultValue: current.staleRemindersEnabled,
        },
        {
          type: 'number',
          name: 'reminderDays',
          label: 'Days after verifying before asking',
          helpText: `${reminders.minReminderDays} to ${reminders.maxReminderDays}.`,
          defaultValue: current.reminderDays,
        },
        {
          type: 'number',
          name: 'graceDays',
          label: 'Days to wait before reporting to the modqueue',
          helpText: `${reminders.minGraceDays} to ${reminders.maxGraceDays}.`,
          defaultValue: current.graceDays,
        },
        {
          type: 'boolean',
          name: 'alwaysReportStale',
          label: 'Report even if the OP replied',
          defaultValue: current.alwaysReportStale,
        },
        {
          type: 'boolean',
          name: 'lockStalePosts',
          label: 'Also lock the post when reporting it',
          defaultValue: current.lockStalePosts,
        },
      ];

    case 'detection':
      return [
        {
          type: 'boolean',
          name: 'duplicateDetectionEnabled',
          label: 'Report repeated fundraiser links',
          defaultValue: current.duplicateDetectionEnabled,
        },
        {
          type: 'boolean',
          name: 'reportSameAuthorReposts',
          label: 'Also when the same person reposts their own link',
          defaultValue: current.reportSameAuthorReposts,
        },
        {
          type: 'number',
          name: 'sameAuthorRepostHours',
          label: 'Hours before someone may repost their own link',
          helpText: '0 = any time. 8760 = never.',
          defaultValue: current.sameAuthorRepostHours,
        },
        {
          type: 'boolean',
          name: 'altDetectionEnabled',
          label: "Report posts that match another account's",
          helpText: 'Same UPI ID, phone, bank account, link or wording. Says if that account is banned.',
          defaultValue: current.altDetectionEnabled,
        },
        {
          type: 'number',
          name: 'altSimilarityPercent',
          label: 'Wording match needed on its own (%)',
          helpText: `${CONFIG.alt.minSimilarityPercent} to ${CONFIG.alt.maxSimilarityPercent}.`,
          defaultValue: current.altSimilarityPercent,
        },
        {
          type: 'number',
          name: 'minAccountAgeDays',
          label: 'Flag accounts younger than (days)',
          helpText: 'Only adds a note to reports. 0 = off.',
          defaultValue: current.minAccountAgeDays,
        },
        {
          type: 'number',
          name: 'minKarma',
          label: 'Flag accounts with less karma than',
          helpText: 'Only adds a note to reports. 0 = off.',
          defaultValue: current.minKarma,
        },
        {
          type: 'boolean',
          name: 'scanCommentsForLinks',
          label: 'Also scan comments for links (leave off)',
          defaultValue: current.scanCommentsForLinks,
        },
      ];

    case 'wiki':
      return [
        {
          type: 'boolean',
          name: 'wikiLogEnabled',
          label: 'Keep the verification log on the wiki',
          helpText: 'Moderator-only. History pages need it.',
          defaultValue: current.wikiLogEnabled,
        },
        {
          type: 'string',
          name: 'wikiLogPage',
          label: 'Wiki page',
          defaultValue: current.wikiLogPage,
        },
        {
          type: 'boolean',
          name: 'userHistoryEnabled',
          label: 'Keep a history page for each poster',
          defaultValue: current.userHistoryEnabled,
        },
        {
          type: 'boolean',
          name: 'modmailLogEnabled',
          label: 'Also post each verification to Mod Discussions',
          defaultValue: current.modmailLogEnabled,
        },
      ];

    case 'reset':
      return [
        {
          type: 'boolean',
          name: 'resetAll',
          label: 'Yes, reset every setting to the app defaults',
          helpText: 'Bot messages are reset too. Logs and records are kept.',
          defaultValue: false,
        },
      ];
  }
}

/**
 * The fundraiser flair: a dropdown of the subreddit's real flairs when there
 * are any, a text box otherwise.
 *
 * The saved value is matched loosely (see `matchesFundraiserFlair`), but a
 * select only shows a value equal to one option exactly. So the option is
 * found the same loose way, and a saved value matching no current flair is
 * offered as its own option. Either way the menu shows what the filter is
 * really doing instead of looking unset.
 */
function flairField(current: AppSettings, availableFlairs: readonly { id: string; text: string }[]): FormField {
  const saved = current.fundraiserFlairText;
  if (availableFlairs.length === 0) {
    return {
      type: 'string',
      name: 'fundraiserFlairText',
      label: 'Flair text that marks a fundraiser',
      helpText: 'This subreddit has no post flairs. Blank = every post.',
      defaultValue: saved,
    };
  }

  const savedOption =
    saved.length === 0
      ? ANY_FLAIR
      : (availableFlairs.find((flair) => flair.text.trim().toLowerCase() === saved.toLowerCase()) ??
          availableFlairs.find((flair) => matchesFundraiserFlair(flair.text, saved)))?.text ?? saved;
  const savedIsListed = savedOption === ANY_FLAIR || availableFlairs.some((flair) => flair.text === savedOption);

  return {
    type: 'select',
    name: 'fundraiserFlairText',
    label: 'Which flair marks a fundraiser?',
    options: [
      { label: 'Any post (no flair filter)', value: ANY_FLAIR },
      ...availableFlairs.map((flair) => ({ label: flair.text, value: flair.text })),
      ...(savedIsListed ? [] : [{ label: `${savedOption} (saved, not a current flair)`, value: savedOption }]),
    ],
    defaultValue: [savedOption],
  };
}

/** The step a moderator picked, or "let the app decide". */
export const FOLLOW_UP_FIELD = 'step';

/**
 * The follow-up form.
 *
 * Deliberately a form rather than a one-tap menu action: it can report and
 * lock someone's fundraiser, so the moderator sees the post's current state
 * and what the button will do before pressing it.
 */
export function followUpFormResponse(input: {
  token: string;
  description: string;
  nextStep: FollowUpStep;
}): UiResponse {
  const nextLabel =
    input.nextStep === 'remind'
      ? `${FOLLOW_UP_TEXT.nextOption} (ask the OP)`
      : `${FOLLOW_UP_TEXT.nextOption} (report it)`;

  return {
    showForm: {
      name: 'followUpForm',
      form: {
        title: FOLLOW_UP_TEXT.title,
        description: input.description,
        acceptLabel: FOLLOW_UP_TEXT.accept,
        cancelLabel: FOLLOW_UP_TEXT.cancel,
        fields: [
          {
            type: 'select',
            name: FOLLOW_UP_FIELD,
            label: FOLLOW_UP_TEXT.stepLabel,
            helpText: FOLLOW_UP_TEXT.stepHelp,
            options: [
              { label: nextLabel, value: 'next' },
              { label: FOLLOW_UP_TEXT.remindOption, value: 'remind' },
              { label: FOLLOW_UP_TEXT.escalateOption, value: 'escalate' },
            ],
            defaultValue: ['next'],
          },
        ],
      },
      data: { token: input.token },
    },
  };
}

/** Field name on the "Look up a poster" form. */
export const LOOKUP_FIELD = 'username';

/** Asks which poster's history page to build. */
export function userLookupFormResponse(): UiResponse {
  return {
    showForm: {
      name: 'userLookupForm',
      form: {
        title: "Look up a poster's history",
        // The menu cannot show a spinner, so the wait is said up front: the
        // first lookup of a person builds their page and takes a few seconds.
        description:
          'After you tap Search, please wait 5-10 seconds while their history is gathered. The page opens by itself.',
        acceptLabel: 'Search (takes a few seconds)',
        cancelLabel: 'Cancel',
        fields: [
          {
            type: 'string',
            name: LOOKUP_FIELD,
            label: 'Username',
            helpText: 'With or without the u/. Tap Search once and wait - tapping again starts over.',
            required: true,
          },
        ],
      },
    },
  };
}
