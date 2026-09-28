import type { UiResponse } from '@devvit/web/shared';
import { CONFIG } from './config.js';
import type { AppSettings } from './settings.js';
import { checklistItemsToText } from './settings.js';
import { FORM_TEXT } from './text.js';
import type { ChecklistItem } from './types.js';

/**
 * Form definitions.
 *
 * Devvit forms CANNOT show or hide fields conditionally - progressive
 * disclosure only happens between submissions. That is why the checklist is a
 * separate, second form reached by ticking a box on the first one, rather than
 * a collapsible section of one form.
 *
 * The chosen shape keeps the common case fast: the quick path is a single form
 * with two fields, and a moderator who wants the checklist opts into one extra
 * step.
 *
 * `data` carries the verification token forward. Values in `data` that have no
 * matching field are echoed back to the submit endpoint, which is how the token
 * survives the round trip without being shown to the moderator.
 */

export function verifyFormResponse(token: string, authorSummary: string | null): UiResponse {
  // The author line is prepended to the description rather than added as a
  // disabled field, because a disabled field still looks like something the
  // moderator is meant to fill in.
  const description = authorSummary
    ? `${authorSummary}

${FORM_TEXT.verifyDescription}`
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
          {
            type: 'paragraph',
            name: 'note',
            label: FORM_TEXT.noteLabel,
            helpText: FORM_TEXT.noteHelp,
            placeholder: FORM_TEXT.notePlaceholder,
            lineHeight: 3,
            required: false,
          },
          {
            type: 'boolean',
            name: 'showChecklist',
            label: FORM_TEXT.showChecklistLabel,
            helpText: FORM_TEXT.showChecklistHelp,
            defaultValue: false,
          },
        ],
      },
      data: { token },
    },
  };
}

/**
 * The checklist form is built from the items the subreddit has configured, so
 * moderators can reword, reorder, add or remove tick-boxes without a code
 * change. The exact list shown is also recorded against the token, so editing
 * the setting while a form is open cannot mismatch answers to labels.
 */
export function checklistFormResponse(
  token: string,
  note: string,
  items: readonly ChecklistItem[],
): UiResponse {
  return {
    showForm: {
      name: 'checklistForm',
      form: {
        title: FORM_TEXT.checklistTitle,
        description: FORM_TEXT.checklistDescription,
        acceptLabel: FORM_TEXT.checklistAccept,
        cancelLabel: FORM_TEXT.checklistCancel,
        fields: [
          {
            type: 'group',
            label: FORM_TEXT.checklistTitle,
            fields: items.map((item) => ({
              type: 'boolean' as const,
              name: item.id,
              label: item.label,
              defaultValue: false,
            })),
          },
          {
            type: 'paragraph',
            name: 'note',
            label: FORM_TEXT.noteLabel,
            helpText: FORM_TEXT.noteHelp,
            lineHeight: 3,
            required: false,
          },
        ],
      },
      // Carries the token forward and pre-fills the note typed on step one, so
      // nothing the moderator already wrote is lost by opening the checklist.
      data: { token, note: note.slice(0, CONFIG.noteMaxLength) },
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
export function settingsFormResponse(current: AppSettings): UiResponse {
  const { reminders } = CONFIG;

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
                type: 'paragraph',
                name: 'checklistItems',
                label: 'Checklist items, one per line',
                helpText: `Leave blank for the built-in list. Maximum ${CONFIG.maxChecklistItems} items.`,
                lineHeight: 6,
                defaultValue: checklistItemsToText(current.checklistItems),
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
                label: "Show the author's account age and karma on this form",
                helpText: 'Moderator-only. Costs a moment longer to open the form.',
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
