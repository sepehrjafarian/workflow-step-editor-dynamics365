# Workflow Step Editor for Dynamics 365

Chrome / Edge extension that adds drag-and-drop and step editing to the classic Dynamics 365 / CRM process designer
(`/sfa/workflow/edit.aspx`), for workflows, actions and dialogs, on any server address.
Tested on 9.1 on-premises. Needs the Web API, so CRM 2016 (8.x) or later; on older versions the button does not appear.

## Install

1. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and pick the `extension` folder of this repository.
3. Open or reload a process in the designer.

## Use

1. Click **⇅ Edit steps** in the designer's top menu bar (next to Save and Close). A panel opens with the process's step tree.
2. Move steps as often as you like. Nothing is saved yet.
   - **Drag** a step onto the upper or lower half of another step to put it before or after that step.
   - Drag onto a branch header (If / Otherwise if / Otherwise / wait branch / stage) to put it first in that branch.
   - On the last step of a branch, **drag further left** to take the step out of the branch (after the condition).
   - Release below the tree to move a step to the very end.
   - **Keyboard:** Tab to a step, then **Alt+↑** / **Alt+↓**.
3. **Apply** keeps all your changes (moves and step edits) and reloads the designer.
   **Cancel** / Esc undoes all of them. **Reset** undoes them and stays in the panel.

### Editing steps

- **Dropdowns** – steps the designer edits inline (*Change status*, *Stop workflow* status, *Start child workflow*
  record type) show the same dropdowns in the panel.
- **Set Properties** – opens the step's own Set Properties window (update, create, email, custom activity, stop, …).
- **Edit condition** – opens the condition editor of an *If* / *Otherwise, if* branch.

The designer saves every edit to the server at once; the panel cannot hold it back. So the panel keeps a copy of the
process from when you opened it: **Cancel** and **Reset** write that copy back (and reload the page), **Apply** keeps
the edits. If you close the browser tab while the panel has edits, the browser asks first; leaving anyway keeps the edits.
Lookups (e.g. which child workflow) are not in the panel; edit those in the designer.

The process must be a draft, and any changes to process properties or step descriptions must be saved first.
The panel tells you if either is not the case. Saving can take up to a minute on large processes.

## How it works

The designer keeps steps on the server, not in the page, and has no "move" command. The panel:

1. reads the process XAML through the Web API (with your own login) when it opens,
2. for each move, cuts the step's exact text (including its trailing `<Persist />`, `<Assign>` or `<If>` helpers)
   and pastes it at the new spot, in memory,
3. on Apply, writes the XAML back once with an `If-Match` ETag (so it never overwrites someone else's change), then reloads.

It never re-formats the XAML: Dynamics rejects any XAML that differs from what its own designer would
write (error `0x80045040`), so only exact cut-and-paste is accepted.

## Limits

- Moving a step above a step whose output it uses (e.g. a record created earlier) is not blocked;
  Dynamics reports it when you activate the process.
- Branches themselves (If / Else If / Otherwise) cannot be reordered; drag the whole condition instead.

## Test

```
node --test extension/test/xaml-move.test.js
```

## Build the upload

Bump `version` in `manifest.json` (every upload needs a higher one), then from the repo root (PowerShell):

```
$v = (Get-Content extension/manifest.json | ConvertFrom-Json).version
New-Item -ItemType Directory -Force dist | Out-Null
tar.exe -a -c -f "dist/workflow-step-editor-$v.zip" -C extension manifest.json xaml-move.js content.js content.css icons
```

(Not `Compress-Archive`: Windows PowerShell 5.1 writes `\` in zip paths, which the store does not accept.)

Store listing text, the promo tile and the privacy policy are in `store/`.
