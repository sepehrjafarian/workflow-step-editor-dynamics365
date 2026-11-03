# Chrome Web Store listing

Text to paste into the Developer Dashboard, field by field.

## Package

Upload `dist/workflow-step-editor-<version>.zip` (see "Build the upload" in `README.md`).

## Store listing tab

**Name** (from the manifest): Workflow Step Editor for Dynamics 365

**Summary** (from the manifest, 132 characters max):
Move and edit steps of classic workflows, actions and dialogs in Dynamics 365 / CRM with drag and drop. By Sepehr Jafarian.

**Description:**

```
Reordering steps in the classic Dynamics process designer means deleting and re-creating them, or nesting them by hand under conditions. Workflow Step Editor adds an "Edit steps" button to the designer that opens the whole process as a tree you can rearrange with the mouse.

MOVE STEPS
• Drag any step before or after another, into a condition branch, or out of one
• Move steps between If / Otherwise if / Otherwise branches, wait branches, dialog pages and stages
• Keyboard support: Alt+↑ / Alt+↓
• Nothing is saved until you click Apply; Reset and Cancel throw your moves away

EDIT STEPS
• Change the inline dropdowns of steps such as Change status and Stop workflow right in the panel
• Open Set Properties and Edit condition for any step from the panel
• Edits are applied with Apply and undone with Cancel, together with your moves

SAFE BY DESIGN
• Steps are moved as exact copies of the designer's own saved definition, so Dynamics accepts them unchanged
• Saving checks that nobody else changed the process since you opened the panel
• Works only on draft (deactivated) processes, like the designer itself

WORKS WITH
• Workflows, actions and dialogs in the classic process designer
• Dynamics 365 on-premises 9.x (tested on 9.1); Dynamics CRM 2016 (8.x) should work too
• Chrome and Edge

PRIVACY
The extension collects no data. It talks only to your own Dynamics server, using your existing sign-in.

Written by Sepehr Jafarian.

Not affiliated with or endorsed by Microsoft. Dynamics 365 is a trademark of Microsoft Corporation.
```

**Category:** Developer Tools

**Language:** English

**Graphics:**
- Store icon: `extension/icons/icon128.png`
- Small promo tile (440×280): `store/promo-small-440x280.png`
- Screenshots (1280×800, at least 1): take them yourself on a test process; see "Screenshots" below.

## Privacy tab

**Single purpose:**
Lets users move and edit the steps of classic processes (workflows, actions, dialogs) in the Microsoft Dynamics 365 / CRM process designer.

**Host permission justification** (the content script matches `http://*/*` and `https://*/*`):
Dynamics 365 / CRM on-premises runs on each customer's own server, so its address is different for every organization and cannot be listed in advance. The content script is limited with include_globs to the process designer page (`*/sfa/workflow/edit.aspx*`) and does nothing on any other page. It calls that same server's Web API to read and save the process being edited.

**Are you using remote code?** No, I am not using remote code.

**Data usage:** tick nothing (the extension collects no user data). Then tick all three certifications
(no selling of data, no use unrelated to the single purpose, no use for creditworthiness / lending).

**Privacy policy URL:** the public address where you host `store/privacy-policy.html`.

## Distribution tab

**Visibility:** Public. **Regions:** All regions.

## Screenshots

At 1280×800, on a test process, without customer names or other internal data in view:
1. The panel open over the designer, showing a nested condition.
2. A step being dragged (the blue drop line visible).
3. A Change status step with its dropdowns in the panel.

Tip: in Chrome DevTools, open the device toolbar, set the size to 1280×800, then use "Capture screenshot" from the ⋮ menu.
