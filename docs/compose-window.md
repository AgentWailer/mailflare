# Compose window and direct AI edits

The floating composer follows the supplied Gmail layout: a pale header with
minimize/expand/close controls, compact address and subject rows, a larger writing
area, a rounded writing-instruction field and a bottom action row. Send and its
schedule menu come first, followed by formatting, AI, attachments and links;
discard stays at the right. Formatting opens above the toolbar. On narrow phones,
links are available in that formatting panel. Touch targets remain at least 44px.
The existing sender picker, Cc/Bcc, attachments, templates, scheduled sending and
draft/reply metadata are retained. No unsupported Gmail buttons are introduced.

AI refinement immediately updates the editable body and the normal autosave
state. There is no separate preview or Replace step. A visible Undo action restores
the exact previous HTML; up to ten successive AI changes can be undone. Ctrl/Cmd+Z
in the body also undoes the latest AI change while it is still current. Further
manual edits invalidate that AI undo chain so it cannot overwrite newly typed
text. Changing the sending mailbox clears the chain.

The AI icon refines the current selection, otherwise the editable message. Empty
replies use the authorized conversation history. Empty new mail focuses the
writing-instruction field; submitting an instruction can generate a new body.
Instructions can also request edits to an existing body. Style and language are
chosen before generation and remembered locally. Generating temporarily blocks
editing and sending; Cancel aborts the request and ignores late responses. Errors
keep the original draft and offer retry. Sending always requires the normal Send
action and existing approval flow where applicable.

When the instruction field is empty, a visible **Polish** button in that same row
improves the selected passage or editable body without requiring a prompt. It uses
the polish style even after another style was selected, retaining the language
preference. An empty body focuses the instruction field instead of generating a
reply. Typing an instruction switches the row to its Generate action. The normal
direct-edit, autosave and Undo behavior applies to both actions.

Selecting an editable passage shows a small, 44px-high **Polish** action near the
selection. Pointer/touch activation preserves the captured range. The existing
Polish button and custom instructions also use that passage; focusing the writing
instruction field retains it even when the browser clears its native selection.
Explicit deselection, changes to the draft, switching mailboxes or leaving the
composer prevent old selections from being reused. Escape dismisses the action.
Placement follows the editor scroll area and visual viewport, including resize
and keyboard changes, without opening a modal or trapping focus.

While a request is pending, only its target text receives a subtle blue/violet
shimmer. A Custom Highlight adds text glow where supported; an external range
rectangle layer also works without that API. Neither changes contentEditable
HTML, captured ranges or autosave payloads. The visual stops on completion,
error, cancellation and unmount, and restarts on retry. Reduced-motion preferences
use a static highlight. Signatures and quoted history stay outside the target.

Signatures, quoted history and embedded images remain protected. The server uses
the existing configured model, mailbox permissions, origin checks, rate limiting
and usage accounting. Author instructions are separate from untrusted email
content; model output is escaped as text and validated for image placeholders.
The generation API never saves drafts or sends mail itself. No schema change is
needed.

Validation: `refine-api`, `refine-editor`, `refine-ui` and `compose-network-errors`
unit suites cover direct edits, selection, image/markup protection, permissions,
instructions, cancellation, stale replies, sequential undo and real autosave
payloads. `tests/browser/compose-window.mjs` uses the real form and production CSS
with synthetic APIs at 320/390/430/768/1024/1440px, light/dark themes, simulated
keyboard viewports, minimize/expand, prompt generation and reachable controls.
It also verifies touch/mouse selection actions, selection-only API payloads and
exact surrounding HTML, Undo, scoped glow geometry, reduced motion, the fallback
without Custom Highlight, highlight cleanup and failed-request retry/cancel.
`reading-pane.mjs` also exercises replies and page composers. Browser emulation
does not certify a physical iPhone keyboard or the live provider's prose quality.

For the selection/glow change, the production build, 28 targeted unit checks
(`refine-editor`, `refine-ui`, `compose-network-errors`) and seven composer browser
cases passed. The changed AI/editor code passes targeted ESLint. The prior
composer release also passed 29 reading-pane browser cases.
The global TypeScript check retains 15 pre-existing unrelated diagnostics; the
existing form and scheduling component retain their baseline four lint errors
and one warning. The change does not claim a clean global check.


Personal writing defaults are available under **Settings → Account → AI writing
style**. The section starts collapsed and loads on first expansion. Users choose
an original/professional/friendly/direct/formal tone, balanced polishing,
grammar/spelling-only correction, shorter or more detailed writing, and up to
2,000 characters of their own writing guidance. The settings are stored per user,
not per browser or shared mailbox, so a fresh session on another device sees the
same defaults. Save failures keep edits; reset is saved only after review.

The refinement service reads those defaults from the authenticated user. Polish
uses the personal improvement type; explicit composer choices take priority for
that edit. Professional/friendly choices also override the default tone. Custom
writing guidance is subordinate to the existing factual and source-data rules.
The sender’s personal settings apply to AI drafting as well; mailbox auto-draft
instructions and model/provider choices are unchanged. The composer’s standard
style option is labelled Personal defaults to make this distinction visible.

Migration 0080 adds only a JSON preference column to the existing users table.
The existing users backup includes it automatically; restore filters against live
columns, and older backups without the field receive the original defaults. No
persisted tables are created or removed, so backup table/group lists are unchanged.
Validation adds authenticated settings round-trips, fresh-session isolation,
cookie-origin checks, input limits, prompt precedence and new/legacy backup
round-trips to the refinement API suite. The targeted suites contain 46 passing
checks; four writing-settings browser cases cover 320/390/1440px, light/dark,
failed-save recovery, collapse, reload persistence and reset. The existing seven
composer cases also remain passing. Build and targeted lint pass; the global
TypeScript check retains the same 15 unrelated diagnostics.


The writing-style section now includes a personal model selector with configured
input/output token prices. Its nullable `modelId` lives in the existing per-user
writing JSON, so no further migration or backup-table change is needed. A null
choice uses the enabled Gemma 4 writing default; selecting a model pins that
user's writing requests to it. Unknown models are rejected on save. Removing a
model from the administrator's allowlist safely restores the writing default
while retaining tone and style. The chat assistant keeps its own model selection.

`getAgentModel` distinguishes assistant and refinement calls. Refinement uses
`@cf/google/gemma-4-26b-a4b-it` when enabled and no personal choice is set, passing
`chat_template_kwargs.enable_thinking=false` only for Gemma writing requests.
Other providers and non-Gemma models retain their own settings. Cloudflare model
catalog parsing accepts both legacy string task names and current `{name: ...}`
objects, avoiding an incorrect fallback to old suggestions.

The installation enables Gemma 4, Mistral Small 3.1 and GPT-OSS 120B as writing
choices alongside the existing `moonshotai/kimi-k3`. Known native token prices
were loaded from Cloudflare's live catalog. Kimi K3 remains selectable with an
explicit unavailable-price message because its token price was not verified.
The original first/default assistant model is retained. Live synthetic calls using
the Mailflare model resolver and AI SDK succeeded against Cloudflare: Gemma
without thinking in 1.20s and Kimi K3 in 9.50s for a short correction preserving
name, amount and date. These calls used captured production model configuration
with isolated database state and normal Cloudflare API transports; they did not
log in to the protected production app or process/send real mail.

Validation for model selection: 51 targeted unit checks, four settings browser
cases (including persisted Mistral/Kimi switches, errors, reset, pricing and
mobile/dark layouts), production build and targeted lint pass. The global
TypeScript baseline is unchanged at 15 unrelated diagnostics.
