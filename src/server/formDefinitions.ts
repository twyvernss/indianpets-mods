import type { FormField, UiResponse } from '@devvit/web/shared';
import { CONFIG } from './config.js';
import type { AppSettings } from './settings.js';
import { ANY_FLAIR, checklistItemsToText } from './settings.js';
import {
  DEFAULT_INTAKE_TEMPLATE,
  DEFAULT_NOTICE_TEMPLATE,
  DEFAULT_REMINDER_TEMPLATE,
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

/** Field names for slot `index`, shared by the form and its submit handler. */
export function noticeFieldNames(index: number): { title: string; body: string } {
  return { title: `notice${index}Title`, body: `notice${index}Body` };
}

/**
 * The verification-notice editor, on its own menu action.
 *
 * Previously these lived in the settings form as a single textarea holding
 * every notice separated by `---`. That was unreadable on a phone and required
 * learning a separator syntax to add a second message. Numbered title/message
 * pairs need no syntax at all, and splitting them out keeps the settings form
 * small enough for the mobile client to open promptly.
 */
export function noticesFormResponse(current: AppSettings): UiResponse {
  const slots: FormField[] = [];

  for (let index = 0; index < NOTICE_SLOTS; index++) {
    const names = noticeFieldNames(index);
    const saved = current.messageTemplates[index];

    slots.push(
      {
        type: 'string',
        name: names.title,
        label: `Notice ${index + 1} - title`,
        helpText:
          index === 0
            ? 'Shown in the dropdown when verifying. Leave the title blank to remove a notice.'
            : undefined,
        defaultValue: saved?.label ?? '',
      },
      {
        type: 'paragraph',
        name: names.body,
        label: `Notice ${index + 1} - message`,
        lineHeight: 6,
        defaultValue: saved?.body ?? '',
      },
    );
  }

  return {
    showForm: {
      name: 'noticesForm',
      form: {
        title: 'Bot messages',
        description:
          'Everything the bot says, in one place. A saved notice needs both a title and a message to appear in the dropdown when verifying.',
        acceptLabel: 'Save',
        cancelLabel: 'Cancel',
        fields: [
          {
            type: 'paragraph',
            name: 'customNoticeText',
            label: 'Default notice (used when no saved notice is picked)',
            helpText:
              'This is the exact wording being posted now. Clear the box to go back to the built-in text. Keep the "not a guarantee" and "donate at your own discretion" language.',
            lineHeight: 8,
            defaultValue: current.customNoticeText || DEFAULT_NOTICE_TEMPLATE,
          },
          ...slots,
          {
            type: 'paragraph',
            name: 'automodReplyText',
            label: 'Message when AutoModerator holds a fundraiser',
            helpText:
              'Only posted if that feature is switched on in settings. Clear the box to go back to the built-in text. Placeholders: {subreddit}, {op}.',
            lineHeight: 8,
            // Prefilled with the real wording rather than left blank: an empty
            // box tells a moderator nothing about what the bot would say.
            defaultValue: current.automodReplyText || DEFAULT_INTAKE_TEMPLATE,
          },
          {
            type: 'paragraph',
            name: 'customReminderText',
            label: 'Message asking the OP for an update on an old fundraiser',
            helpText:
              'Clear the box to go back to the built-in text. Placeholders: {subreddit}, {op}, {days}, {grace}.',
            lineHeight: 8,
            defaultValue: current.customReminderText || DEFAULT_REMINDER_TEMPLATE,
          },
        ],
      },
    },
  };
}

/**
 * The in-subreddit settings editor.
 *
 * Pre-filled with the EFFECTIVE values, so what a moderator sees is what the app
 * is currently doing, whatever layer it came from. Submitting writes a runtime
 * override that takes effect on the next action - no trip to
 * developers.reddit.com, no redeploy.
 */
export function settingsFormResponse(
  current: AppSettings,
  /** The subreddit's live post flairs. Empty on a sub with none, e.g. a test sub. */
  availableFlairs: readonly { id: string; text: string }[] = [],
): UiResponse {
  const { reminders } = CONFIG;

  // A dropdown of the subreddit's real flairs when there are any; a plain text
  // box otherwise, so a brand new test subreddit is not stuck with an empty
  // menu and no way to type a value.
  const flairField: FormField =
    availableFlairs.length > 0
      ? {
          type: 'select',
          name: 'fundraiserFlairText',
          label: 'Which flair marks a fundraiser?',
          helpText:
            'The bot only replies to and reports posts with this flair. Choose "Any post" to switch the filter off.',
          options: [
            { label: 'Any post (no flair filter)', value: ANY_FLAIR },
            ...availableFlairs.map((flair) => ({ label: flair.text, value: flair.text })),
          ],
          defaultValue: [current.fundraiserFlairText.length > 0 ? current.fundraiserFlairText : ANY_FLAIR],
        }
      : {
          type: 'string',
          name: 'fundraiserFlairText',
          label: 'Which flair marks a fundraiser?',
          helpText:
            'This subreddit has no post flairs yet, so type the flair text by hand. Leave blank to apply the bot to every post.',
          defaultValue: current.fundraiserFlairText,
        };

  return {
    showForm: {
      name: 'settingsForm',
      form: {
        title: 'Fundraiser tools settings',
        description:
          'Changes take effect immediately and apply to this subreddit only. The wording the bot posts is edited separately, under "Edit bot messages". Tick "Reset everything" at the bottom to go back to the app defaults.',
        acceptLabel: 'Save',
        cancelLabel: 'Cancel',
        fields: [
          {
            type: 'boolean',
            name: 'enabled',
            label: 'App enabled',
            helpText: 'Master switch. Turn off to stop every automated action at once.',
            defaultValue: current.enabled,
          },
          {
            type: 'group',
            label: 'Verification',
            fields: [
              {
                type: 'boolean',
                name: 'addModNote',
                label: 'Add a mod note on the OP when verifying',
                defaultValue: current.addModNote,
              },
              {
                type: 'boolean',
                name: 'showVerifyingModInComment',
                label: 'Name the verifying moderator in the public comment',
                helpText: 'Not recommended - this is what causes unsolicited DMs to moderators.',
                defaultValue: current.showVerifyingModInComment,
              },
              {
                type: 'boolean',
                name: 'compactChecklist',
                label: 'Compact checklist (one tick-list instead of a row of toggles)',
                helpText: 'Keeps the verify form short, which matters most on mobile.',
                defaultValue: current.compactChecklist,
              },
              {
                type: 'paragraph',
                name: 'checklistItems',
                label: 'Checklist items, one per line',
                helpText: `Leave blank for the built-in list. Maximum ${CONFIG.maxChecklistItems} items.`,
                lineHeight: 6,
                defaultValue: checklistItemsToText(current.checklistItems),
              },
              {
                type: 'boolean',
                name: 'showAuthorSummary',
                label: "Show the author's history on the verify form",
                helpText:
                  'Account age, karma, and how many fundraisers they have had verified here before. Moderator-only.',
                defaultValue: current.showAuthorSummary,
              },
            ],
          },
          {
            type: 'group',
            label: 'When AutoModerator holds a fundraiser',
            fields: [
              {
                type: 'boolean',
                name: 'automodReplyEnabled',
                label: 'Reply to the OP listing the documents we need',
                helpText:
                  'Off by default. If AutoModerator already posts a similar comment, remove that one first - two bot comments on a post is worse than one.',
                defaultValue: current.automodReplyEnabled,
              },
            ],
          },
          flairField,
          {
            type: 'group',
            label: 'Duplicate fundraiser links',
            fields: [
              {
                type: 'boolean',
                name: 'duplicateDetectionEnabled',
                label: 'Detect repeated fundraiser links',
                defaultValue: current.duplicateDetectionEnabled,
              },
              {
                type: 'boolean',
                name: 'reportSameAuthorReposts',
                label: 'Also report when the same person reposts their own link',
                defaultValue: current.reportSameAuthorReposts,
              },
              {
                type: 'number',
                name: 'sameAuthorRepostHours',
                label: 'Hours before the same person may repost their own link',
                helpText:
                  'Match your subreddit rules. A repost that waits this long counts as legitimate and is never reported. 0 = no waiting period. If you do not allow reposts at all, set this very high (8760 = a year).',
                defaultValue: current.sameAuthorRepostHours,
              },
              {
                type: 'boolean',
                name: 'scanCommentsForLinks',
                label: 'Also scan comments for fundraiser links',
                helpText: 'Off by default. Much more traffic for a comparatively rare signal.',
                defaultValue: current.scanCommentsForLinks,
              },
            ],
          },
          {
            type: 'group',
            label: 'Stale fundraiser reminders',
            fields: [
              {
                type: 'boolean',
                name: 'staleRemindersEnabled',
                label: 'Ask the OP for an update on old fundraisers',
                defaultValue: current.staleRemindersEnabled,
              },
              {
                type: 'number',
                name: 'reminderDays',
                label: 'Days after verification before asking for an update',
                helpText: `Between ${reminders.minReminderDays} and ${reminders.maxReminderDays}.`,
                defaultValue: current.reminderDays,
              },
              {
                type: 'number',
                name: 'graceDays',
                label: 'Days to wait for a reply before reporting to the modqueue',
                helpText: `Between ${reminders.minGraceDays} and ${reminders.maxGraceDays}.`,
                defaultValue: current.graceDays,
              },
              {
                type: 'boolean',
                name: 'lockStalePosts',
                label: 'Also lock the post when reporting it',
                helpText: 'Off by default.',
                defaultValue: current.lockStalePosts,
              },
            ],
          },
          {
            type: 'group',
            label: 'Author thresholds (used to annotate modqueue reports)',
            fields: [
              {
                type: 'number',
                name: 'minAccountAgeDays',
                label: 'Minimum account age in days',
                helpText: '0 disables this annotation.',
                defaultValue: current.minAccountAgeDays,
              },
              {
                type: 'number',
                name: 'minKarma',
                label: 'Minimum combined karma',
                helpText: '0 disables this annotation.',
                defaultValue: current.minKarma,
              },
            ],
          },
          {
            type: 'boolean',
            name: 'resetAll',
            label: 'Reset everything to the app defaults',
            helpText: 'When ticked, every other field on this form is ignored.',
            defaultValue: false,
          },
        ],
      },
    },
  };
}
