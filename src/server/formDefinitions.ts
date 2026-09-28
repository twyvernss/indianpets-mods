import type { FormField, UiResponse } from '@devvit/web/shared';
import { CONFIG } from './config.js';
import type { AppSettings } from './settings.js';
import {
  ANY_FLAIR,
  checklistItemsToText,
  messageTemplatesToText,
  TEMPLATE_SEPARATOR,
} from './settings.js';
import { FORM_TEXT } from './text.js';
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
  const description = input.authorSummary
    ? `${input.authorSummary}\n\n${FORM_TEXT.verifyDescription}`
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
                  label: 'Which notice should the bot post?',
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
          'Changes take effect immediately and apply to this subreddit only. Tick "Reset everything" at the bottom to go back to the app defaults.',
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
                type: 'paragraph',
                name: 'messageTemplates',
                label: 'Saved notices a moderator can pick from',
                helpText: `One per block, separated by a line containing only ${TEMPLATE_SEPARATOR}. The first line of each block is its name in the dropdown, the rest is the comment. Placeholders: {subreddit}, {date}, {mod}. Maximum ${CONFIG.maxMessageTemplates}.`,
                lineHeight: 8,
                defaultValue: messageTemplatesToText(current.messageTemplates),
              },
              {
                type: 'paragraph',
                name: 'customNoticeText',
                label: 'Custom verification notice',
                helpText:
                  'Blank uses the built-in wording. Placeholders: {subreddit}, {date}, {mod}. Keep the "not a guarantee" and "donate at your own discretion" language.',
                lineHeight: 5,
                defaultValue: current.customNoticeText,
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
              {
                type: 'paragraph',
                name: 'automodReplyText',
                label: 'Custom intake wording',
                helpText: 'Blank uses the built-in text. Placeholders: {subreddit}, {op}.',
                lineHeight: 6,
                defaultValue: current.automodReplyText,
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
              {
                type: 'paragraph',
                name: 'customReminderText',
                label: 'Custom reminder wording',
                helpText:
                  'Blank uses the built-in wording. Placeholders: {subreddit}, {op}, {days}, {grace}.',
                lineHeight: 5,
                defaultValue: current.customReminderText,
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
