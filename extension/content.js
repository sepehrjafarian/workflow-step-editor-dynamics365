// "Edit steps" panel for the classic process designer.
// Moves are made in memory on the step tree and on the XAML text; Apply writes the XAML once and reloads.
// Runs in the page's own world so it can call the designer's functions and reuse its login.
(function () {
  'use strict';
  if (window.__wfStepMover || !window.WfDragXaml) return;
  window.__wfStepMover = true;

  // Step kinds (the table's "stepname" attribute in the designer).
  var BRANCH = { IfCondition: 1, ElseIfCondition: 1, ElseCondition: 1, WaitBranch: 1, WaitTimeout: 1, ProcessStep: 1 };
  var PAGE = 'InteractionStepPage', PROMPT = 'InteractionStep', STAGE = 'ProcessStep', ROOT = 'WorkflowStep0';
  var TYPES = {
    UpdateStep: 'Update', CreateStep: 'Create', SetStateStep: 'Change status', AssignStep: 'Assign',
    SendEmailStep: 'Email', StopWorkflowStep: 'Stop', ChildWorkflowStep: 'Child workflow',
    ChildInteractiveWorkflowStep: 'Child dialog', CustomActivityStep: 'Custom', ConditionStep: 'Condition',
    ConditionBranchStep: 'Branch', WaitStep: 'Wait', WaitBranchStep: 'Wait branch', QueryStep: 'Query',
    AssignVariableStep: 'Variable', InteractionPageStep: 'Page', InteractionStep: 'Prompt', StageStep: 'Stage',
    InvokeSdkMessageStep: 'Action'
  };

  var wfId = (new URLSearchParams(location.search).get('id') || '').replace(/[{}]/g, '');
  if (!/^[0-9a-f-]{36}$/i.test(wfId)) return;
  // Web API: v8.0-v8.2 on CRM 2016, v9.0 on every 9.x; CRM 2015 and older have none.
  var version = parseFloat(window.APPLICATION_VERSION) || 9;
  if (version < 8) return;
  var api = location.origin + location.pathname.split(/\/sfa\//i)[0] + '/api/data/v' +
    (version >= 9 ? '9.0' : version.toFixed(1)) + '/workflows(' + wfId + ')';

  // Activated processes are read-only in the designer; the server re-checks on Apply.
  var stateField = document.getElementById('hidCurrentState');
  if (stateField && stateField.value && stateField.value !== 'Draft') return;

  // --- page chrome ---

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  // "Edit steps" command in the designer's top menu bar (same markup as its own commands),
  // or a floating button if the bar is not there.
  var openBtn, menuBar = document.querySelector('ul.ms-crm-MenuBar-Left');
  if (menuBar) {
    var item = el('li', 'ms-crm-Menu ms-crm-Menu-Read');
    item.title = 'Move and edit the steps of this process';
    var label = el('span', 'ms-crm-Menu-Label');
    openBtn = el('a', 'ms-crm-Menu-Label');
    openBtn.href = '#';
    openBtn.setAttribute('role', 'button');
    openBtn.appendChild(el('span', 'wfp-menu-icon', '⇅'));
    openBtn.appendChild(el('span', 'ms-crm-MenuItem-TextRTL', 'Edit steps'));
    label.appendChild(openBtn);
    item.appendChild(label);
    var spacer = menuBar.querySelector(':scope > .ms-crm-Menu-Spacer');
    menuBar.insertBefore(el('li', 'ms-crm-Menu-Spacer'), spacer);
    menuBar.insertBefore(item, spacer);
  } else {
    openBtn = el('button', 'wfp-open', '⇅ Edit steps');
    openBtn.type = 'button';
  }
  openBtn.addEventListener('click', function (e) { e.preventDefault(); open(); });

  var overlay = el('div', 'wfp-overlay');
  var dialog = el('div', 'wfp-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'wfp-title');
  var head = el('div', 'wfp-head');
  var title = el('h2', 'wfp-title', 'Edit steps');
  title.id = 'wfp-title';
  var hint = el('div', 'wfp-hint', 'Drag a step to move it; drag it further left to take it out of a branch. Keyboard: focus a step and press Alt+↑ / Alt+↓. Edit steps with their dropdowns, Set Properties or Edit condition; add steps with +, delete them with × (or the Delete key). Apply keeps all changes; Cancel undoes them.');
  var counter = el('span', 'wfp-counter');
  var resetBtn = el('button', 'wfp-btn', 'Reset');
  var cancelBtn = el('button', 'wfp-btn', 'Cancel');
  var applyBtn = el('button', 'wfp-btn wfp-primary', 'Apply');
  [resetBtn, cancelBtn, applyBtn].forEach(function (b) { b.type = 'button'; });
  var actions = el('div', 'wfp-actions');
  actions.append(counter, resetBtn, cancelBtn, applyBtn);
  head.append(title, actions);
  var body = el('div', 'wfp-body');
  body.setAttribute('role', 'tree');
  dialog.append(head, hint, body);
  overlay.appendChild(dialog);

  var toast = el('div', 'wfp-toast');
  toast.setAttribute('role', 'status');
  var ghost = el('div', 'wfp-ghost');
  document.body.append(overlay, toast, ghost);
  if (!menuBar) document.body.appendChild(openBtn);

  // sticky: stays until replaced (used while saving, which can take half a minute on the server).
  function say(msg, isError, sticky) {
    toast.textContent = msg;
    toast.classList.toggle('wfp-error', !!isError);
    toast.style.display = msg ? 'block' : 'none';
    clearTimeout(say.t);
    if (msg && !sticky) say.t = setTimeout(function () { toast.style.display = 'none'; }, isError ? 10000 : 4000);
  }

  async function errorText(res) {
    var text = await res.text();
    try { return JSON.parse(text).error.message; } catch (e) { return res.status + ' ' + text.slice(0, 300); }
  }

  // --- model: the step tree as the designer shows it ---

  var state = null; // { original, xaml, etag, root, nodes, moves }

  function ownElements(t, sel) {
    return [].filter.call(t.querySelectorAll(sel), function (e) { return e.closest('table[stepname]') === t; });
  }

  function describe(t) {
    var input = ownElements(t, 'input[type=text], textarea')[0];
    var v = input ? input.value.trim() : '';
    return v && v !== input.getAttribute('placeholder') && !/^Type a step description here\.?$/i.test(v) ? v : '';
  }

  // The step's own text (e.g. "Change record status to: Accounting Voucher Inactive"), without nested steps.
  function summarize(t) {
    var c = t.cloneNode(true), live = t.querySelectorAll('select');
    c.querySelectorAll('select').forEach(function (s, k) {
      var o = live[k] && live[k].options[live[k].selectedIndex];
      s.replaceWith(' ' + (o ? o.text : '') + ' ');
    });
    c.querySelectorAll('table[stepname], input, textarea, button, script, style').forEach(function (e) { e.remove(); });
    return c.textContent.replace(/\s+/g, ' ').trim().slice(0, 200);
  }

  // The designer's own editor for a step: its "Set Properties" button, or a branch's condition link.
  function editControl(t) {
    return ownElements(t, 'button[id$="_button"]')[0] ||
      (BRANCH[t.getAttribute('stepname')] ? ownElements(t, 'a.ms-crm-workflow')[0] : null);
  }

  // The line of text and dropdowns a step shows inline in the designer (e.g. Change status:
  // "Change record status to: [record] [status]"), so the panel can show working copies of the dropdowns.
  function fieldsOf(t) {
    var first = ownElements(t, 'select').filter(function (s) { return s.offsetParent && s.id; })[0];
    if (!first) return null;
    var parts = [];
    (function walk(node) {
      [].forEach.call(node.childNodes, function (c) {
        if (c.nodeType === 3) {
          if (c.textContent.trim()) parts.push({ text: c.textContent.trim() });
        } else if (c.nodeType === 1 && c.offsetParent && !c.matches('table[stepname], button, input, textarea, script, style')) {
          if (c.tagName !== 'SELECT') walk(c);
          else if (c.id) parts.push({ select: c.id, value: c.value, disabled: c.disabled,
            options: [].map.call(c.options, function (o) { return { value: o.value, text: o.text }; }) });
        }
      });
    })(first.closest('tr'));
    return parts;
  }

  function build() {
    var root = { id: ROOT, kind: 'root', children: [] }, nodes = {};
    nodes[ROOT] = root;
    var tables = [].filter.call(document.querySelectorAll('table[stepname]'), function (t) { return t.id !== 'NoStep'; });
    tables.forEach(function (t) {
      var ctl = editControl(t);
      nodes[t.id] = {
        id: t.id, kind: t.getAttribute('stepname'), children: [], title: describe(t), summary: summarize(t),
        fields: fieldsOf(t), edit: ctl ? (ctl.tagName === 'A' ? 'Edit condition' : 'Set Properties') : ''
      };
    });
    tables.forEach(function (t) {
      var p = nodes[t.getAttribute('parent')];
      if (!p) throw new Error('Unknown parent step ' + t.getAttribute('parent'));
      nodes[t.id].parent = p;
      p.children.push(nodes[t.id]);
    });
    return { root: root, nodes: nodes };
  }

  // Check every step of the model is in the saved XAML; returns the id of the first one that is not.
  // The designer does not save an empty branch whose condition is not configured yet: those are only
  // marked unsaved (nothing can be dropped into them).
  function checkSaved(model, xaml) {
    var tree = WfDragXaml.parse(xaml);
    return Object.keys(model.nodes).filter(function (id) {
      var n = model.nodes[id];
      if (n.kind === 'root' || (holdsSteps(n) ? WfDragXaml.findContainer(tree, id) : WfDragXaml.findStep(tree, id))) return false;
      if (BRANCH[n.kind] && !n.children.length) { n.unsaved = true; return false; }
      return true;
    })[0];
  }

  function draggable(n) { return n.kind !== 'root' && !BRANCH[n.kind]; }
  function holdsSteps(n) { return n.kind === 'root' || !!BRANCH[n.kind] || n.kind === PAGE; }
  function inside(n, ancestor) { for (; n; n = n.parent) if (n === ancestor) return true; return false; }

  function allowed(n, container) {
    if (container.unsaved || inside(container, n)) return false;
    if ((n.kind === PROMPT) !== (container.kind === PAGE)) return false;
    if (container.kind === 'root' && n.kind !== STAGE &&
        container.children.some(function (c) { return c.kind === STAGE; })) return false;
    return true;
  }

  // --- open / apply ---

  var opening = false;

  async function open() {
    if (opening || state) return;
    try {
      if (typeof IsWorkflowDirty === 'function' && IsWorkflowDirty()) {
        say('This process has unsaved changes. Save it first, then edit steps.', true);
        return;
      }
      opening = true;
      var res = await fetch(api + '?$select=xaml,statecode', { headers: { Accept: 'application/json', 'OData-Version': '4.0' } });
      if (!res.ok) throw new Error(await errorText(res));
      var wf = await res.json();
      if (wf.statecode !== 0) throw new Error('Deactivate the process before editing steps.');
      var model = build();
      var missing = checkSaved(model, wf.xaml);
      if (missing) throw new Error('Step ' + missing + ' is not in the saved process. Reload the page and try again.');
      // snapshot: the process as it was when the panel opened; Cancel writes it back to undo step edits.
      state = { snapshot: wf.xaml, original: wf.xaml, xaml: wf.xaml, etag: wf['@odata.etag'], root: model.root, nodes: model.nodes, moves: 0, log: [] };
      overlay.style.display = 'flex';
      render();
      var first = body.querySelector('.wfp-row[tabindex]');
      (first || applyBtn).focus();
    } catch (err) {
      state = null;
      overlay.style.display = 'none';
      say('Could not open the Edit steps panel: ' + err.message, true);
    } finally {
      opening = false;
    }
  }

  // The designer saves step edits at once, so the panel treats them as a draft:
  // Apply keeps them, Cancel / Reset write the snapshot back.
  function edited() { return state.original !== state.snapshot; }

  function pending() {
    var parts = [];
    if (state.moves) parts.push(state.moves + ' move' + (state.moves > 1 ? 's' : ''));
    if (edited()) parts.push('step edits');
    return parts.join(' and ');
  }

  // An edit was just made in the designer and the panel has not caught up yet.
  function busy() {
    if (stale || refreshing) say('The panel is updating after your edit, try again in a moment.', true);
    return stale || refreshing;
  }

  function hide() {
    state = null;
    overlay.style.display = 'none';
    openBtn.focus();
  }

  function close() {
    if (!state || busy()) return;
    if (pending() && !confirm('Undo your ' + pending() + '?')) return;
    if (edited()) write(state.snapshot, 'Undoing your step edits…', 'Could not undo your step edits: ');
    else hide();
  }

  function apply() {
    if (!state || busy()) return;
    if (state.xaml === state.original) return hide(); // only step edits, already saved
    write(state.xaml, 'Saving… Dynamics checks the whole process, this can take up to a minute.', 'Could not apply: ');
  }

  // Write the process XAML, then reload the designer (optionally reopening the panel).
  var leaving = false;
  async function write(xaml, busyText, failText, reopen) {
    saving(true);
    say(busyText, false, true);
    try {
      var put = await fetch(api, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'OData-Version': '4.0', 'If-Match': state.etag },
        body: JSON.stringify({ xaml: xaml })
      });
      if (put.status === 412) throw new Error('The process was changed elsewhere after you opened this panel. Reload the page and try again.');
      if (!put.ok) throw new Error(await errorText(put));
      say('Saved. Reloading…', false, true);
      leaving = true;
      if (reopen) try { sessionStorage.setItem('wfp-reopen', wfId); } catch (e) { /* reopening is a convenience */ }
      // Without the "#" the designer's links leave behind; replacing with it only jumps to an anchor.
      location.replace(location.href.split('#')[0]);
    } catch (err) {
      saving(false);
      say(failText + err.message, true);
    }
  }

  window.addEventListener('beforeunload', function (e) {
    if (state && !leaving && pending()) { e.preventDefault(); e.returnValue = ''; }
  });

  function saving(on) {
    dialog.classList.toggle('wfp-saving', on);
    [applyBtn, resetBtn, cancelBtn].forEach(function (b) { b.disabled = on; });
    if (!on) render();
  }

  resetBtn.addEventListener('click', function () {
    if (!state || !pending() || busy()) return;
    if (edited()) {
      if (confirm('Undo your ' + pending() + '? The page reloads and the panel opens again.')) {
        write(state.snapshot, 'Undoing your step edits…', 'Could not undo your step edits: ', true);
      }
      return;
    }
    var model = build();
    state.xaml = state.original;
    state.root = model.root;
    state.nodes = model.nodes;
    state.moves = 0;
    state.log = [];
    render();
  });

  // --- editing: through the designer's own editors and dropdowns; they save at once and redraw the designer ---

  body.addEventListener('click', function (e) {
    var b = e.target.closest('.wfp-edit');
    if (!b) return;
    var t = document.getElementById(b.closest('.wfp-node').dataset.id), ctl = t && editControl(t);
    if (ctl) ctl.click();
    else say('This step has no editor in the designer.', true);
  });

  // A dropdown copy in the panel sets the designer's dropdown, as if picked there.
  body.addEventListener('change', function (e) {
    var copy = e.target.closest('.wfp-select');
    if (!copy) return;
    var real = document.getElementById(copy.dataset.for), id = copy.closest('.wfp-node').dataset.id;
    if (!real) return say('This step changed in the designer. Cancel and reload the page.', true);
    real.value = copy.value;
    real.dispatchEvent(new Event('change', { bubbles: true }));
    // Some dropdowns only refill others in the page (e.g. record -> status), with no redraw to catch.
    var t = document.getElementById(id), n = state && state.nodes[id];
    if (t && n) { n.fields = fieldsOf(t); n.summary = summarize(t); render(id); }
  });

  // When the designer redraws after an edit, reload the saved process and replay the unapplied moves on it.
  var designerArea = document.getElementById('gridDefinitionContainer'), refreshTimer, stale = false, refreshing = false;
  if (designerArea) {
    new MutationObserver(function () {
      if (!state || dialog.classList.contains('wfp-saving')) return;
      stale = true;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refresh, 300);
    }).observe(designerArea, { childList: true });
  }

  async function refresh() {
    stale = false;
    refreshing = true;
    try {
      var res = await fetch(api + '?$select=xaml', { headers: { Accept: 'application/json', 'OData-Version': '4.0' } });
      if (!res.ok) throw new Error(await errorText(res));
      var wf = await res.json(), old = state, model = build(), lost = 0, added = null;
      if (!old) return;
      checkSaved(model, wf.xaml);
      state = { snapshot: old.snapshot, original: wf.xaml, xaml: wf.xaml, etag: wf['@odata.etag'], root: model.root, nodes: model.nodes, moves: 0, log: [] };
      old.log.forEach(function (m, i) {
        // A neighbour deleted since only matters if this was the step's last move.
        if (!replay(m) && !old.log.slice(i + 1).some(function (l) { return l.id === m.id; })) lost++;
      });
      if (adding) {
        // The designer put the new step next to its own copy of the anchor; move it to the panel's spot.
        var fresh = Object.keys(state.nodes).filter(function (id) { return !adding.ids[id]; }).map(function (id) { return state.nodes[id]; });
        added = fresh.filter(function (n) { return fresh.indexOf(n.parent) < 0; })[0];
        if (added && draggable(added) && !replay({ id: added.id, targetId: adding.targetId, position: adding.position })) lost++;
        adding = null;
      }
      var gone = deleting && !state.nodes[deleting];
      deleting = null;
      render(added && added.id);
      var what = added ? 'Step added.' : gone ? 'Step deleted.' : 'Step updated.';
      say(lost ? what + ' ' + lost + ' of your moves could not be re-applied.' : what + ' Apply keeps the change, Cancel undoes it.', !!lost);
    } catch (err) {
      say('Could not refresh the panel: ' + err.message + ' Reload the page.', true);
    } finally {
      refreshing = false;
    }
  }
  cancelBtn.addEventListener('click', close);
  applyBtn.addEventListener('click', apply);
  overlay.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !drag && !dialog.classList.contains('wfp-saving')) { e.preventDefault(); close(); }
  });

  // --- rendering ---

  function render(focusId) {
    var scroll = body.scrollTop;
    body.textContent = '';
    body.appendChild(renderChildren(state.root));
    body.scrollTop = scroll;
    counter.textContent = pending() ? pending() + ' not applied' : '';
    applyBtn.disabled = resetBtn.disabled = !pending();
    if (focusId) {
      var row = body.querySelector('.wfp-node[data-id="' + focusId + '"] > .wfp-row');
      if (row) { row.focus(); row.scrollIntoView({ block: 'nearest' }); }
    }
  }

  function renderChildren(n) {
    var list = el('div', 'wfp-children');
    list.setAttribute('role', 'group');
    var slots = holdsSteps(n);
    if (slots) list.appendChild(slot(n, 0));
    n.children.forEach(function (c, i) {
      list.appendChild(renderNode(c));
      if (slots) list.appendChild(slot(n, i + 1));
    });
    if (slots && !n.children.length) {
      list.firstChild.classList.add('wfp-empty');
      if (canAdd() && anchorIn(n.id)) {
        var add = el('button', 'wfp-btn wfp-add wfp-add-here', '+ Add step');
        add.type = 'button';
        list.firstChild.appendChild(add);
      }
    }
    return list;
  }

  function slot(container, index) {
    var s = el('div', 'wfp-slot');
    s.dataset.container = container.id;
    s.dataset.index = index;
    return s;
  }

  function renderNode(n) {
    var box = el('div', 'wfp-node');
    box.dataset.id = n.id;
    var row = el('div', 'wfp-row');
    row.setAttribute('role', 'treeitem');
    if (draggable(n)) {
      row.dataset.drag = '1';
      row.tabIndex = 0;
      row.appendChild(el('span', 'wfp-handle', '⠇⠇'));
    } else {
      row.classList.add('wfp-branch');
    }
    row.appendChild(el('span', 'wfp-type', TYPES[n.id.replace(/\d+$/, '')] || n.kind));
    var text = el('span', 'wfp-text');
    if (n.title) { var t = el('span', 'wfp-name', n.title); t.dir = 'auto'; text.appendChild(t); }
    if (n.fields) text.appendChild(renderFields(n.fields));
    else if (n.summary && n.summary !== n.title) { var s = el('span', 'wfp-summary', n.summary); s.dir = 'auto'; text.appendChild(s); }
    if (!n.title && !n.summary && !n.fields) {
      text.appendChild(el('span', 'wfp-summary', n.children.length ? n.children.length + ' branch' + (n.children.length > 1 ? 'es' : '') : n.id));
    }
    row.appendChild(text);
    if (n.edit) {
      var edit = el('button', 'wfp-btn wfp-edit', n.edit);
      edit.type = 'button';
      row.appendChild(edit);
    }
    if (canDelete()) {
      var del = el('button', 'wfp-btn wfp-delete', '×');
      del.type = 'button';
      del.title = 'Delete this step';
      del.setAttribute('aria-label', 'Delete ' + (n.title || n.summary || n.id));
      row.appendChild(del);
    }
    if (canAdd()) {
      var add = el('button', 'wfp-btn wfp-add', '+');
      add.type = 'button';
      add.title = 'Add a step before or after this one';
      add.setAttribute('aria-label', 'Add a step next to ' + (n.title || n.summary || n.id));
      row.appendChild(add);
    }
    row.setAttribute('aria-label', (TYPES[n.id.replace(/\d+$/, '')] || n.kind) + ': ' + (n.title || n.summary || n.id));
    box.appendChild(row);
    if (n.children.length || holdsSteps(n)) box.appendChild(renderChildren(n));
    return box;
  }

  function renderFields(fields) {
    var line = el('span', 'wfp-fields');
    fields.forEach(function (f) {
      if (!f.select) { var t = el('span', 'wfp-summary', f.text); t.dir = 'auto'; return line.appendChild(t); }
      var s = el('select', 'wfp-select');
      s.dataset.for = f.select;
      f.options.forEach(function (o) { // the page replaces the global Option constructor
        var opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.text;
        s.appendChild(opt);
      });
      s.value = f.value;
      s.disabled = f.disabled;
      line.appendChild(s);
    });
    return line;
  }

  // --- adding: through the designer's own Add Step menu, so it decides what may go where ---

  // Set by the designer once it has loaded, which can be after this script runs.
  function canAdd() { return typeof showWorkStepMenu === 'function' && !!window.addStepMenuCtrl; }
  var adding = null; // { ids, targetId, position }: an add waiting for the designer to redraw
  var menu = el('div', 'wfp-menu');
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', 'Add step');
  dialog.appendChild(menu);

  // A designer step to add relative to, inside the given step container.
  function anchorIn(containerId) {
    return document.querySelector('table[id="NoStep"][parent="' + containerId + '"]') ||
      [].find.call(document.querySelectorAll('table[stepname][parent="' + containerId + '"]'), function (t) { return t.id !== 'NoStep'; });
  }

  // Select the anchor in the designer and let it work out which step types are allowed there.
  function selectInDesigner(anchor) {
    ResetSelectedStep();
    SelectStep(anchor);
    showWorkStepMenu();
  }

  // The designer's Add Step menu as { title, action, group } items, enabled ones only.
  function addItems() {
    var items = [], xml = addStepMenuCtrl.get_menuXml();
    (function walk(node, group) {
      [].forEach.call(node.childNodes, function (c) {
        if (c.nodeType !== 1) return;
        if (c.getAttribute('type') === '2') return walk(c, c.getAttribute('title'));
        if (c.getAttribute('type') === '1' && c.getAttribute('disabled') !== 'true' && c.getAttribute('action')) {
          items.push({ title: c.getAttribute('title'), action: c.getAttribute('action'), group: group });
        }
      });
    })(xml.documentElement || xml, '');
    return items;
  }

  function openMenu(btn) {
    var row = btn.closest('.wfp-row'), id = row ? btn.closest('.wfp-node').dataset.id : btn.closest('.wfp-slot').dataset.container;
    var anchor = row ? document.getElementById(id) : anchorIn(id);
    if (!anchor) return say('This spot is not in the designer any more. Cancel and reload the page.', true);
    selectInDesigner(anchor);
    var items = addItems(), position = 'after';
    menu.textContent = '';
    if (row) {
      var side = el('div', 'wfp-side');
      ['before', 'after'].forEach(function (p) {
        var b = el('button', 'wfp-btn' + (p === position ? ' wfp-on' : ''), p === 'before' ? 'Before' : 'After');
        b.type = 'button';
        b.setAttribute('aria-pressed', p === position);
        b.addEventListener('click', function () {
          position = p;
          side.querySelectorAll('button').forEach(function (o) { o.classList.toggle('wfp-on', o === b); o.setAttribute('aria-pressed', o === b); });
        });
        side.appendChild(b);
      });
      menu.appendChild(side);
    }
    var search = el('input', 'wfp-search');
    search.type = 'search';
    search.placeholder = 'Search step types…';
    search.setAttribute('aria-label', 'Search step types');
    var list = el('div', 'wfp-menu-list');
    menu.append(search, list);
    if (!items.length) list.appendChild(el('div', 'wfp-summary', 'The designer allows no step here.'));
    var groups = {};
    items.forEach(function (it) {
      var b = el('button', 'wfp-menu-item', it.title);
      b.type = 'button';
      b.dir = 'auto';
      b.addEventListener('click', function () {
        closeMenu();
        // Row: next to that step in the panel. Empty branch: into it.
        add(it, anchor, row ? position : 'after', row ? { targetId: id, position: position } : { targetId: id, position: 'first' });
      });
      if (!it.group) return list.appendChild(b);
      if (!groups[it.group]) {
        groups[it.group] = el('details', 'wfp-group');
        groups[it.group].appendChild(el('summary', '', it.group));
        list.appendChild(groups[it.group]);
      }
      groups[it.group].appendChild(b);
    });
    search.addEventListener('input', function () {
      var q = search.value.trim().toLowerCase();
      list.querySelectorAll('.wfp-menu-item').forEach(function (b) { b.hidden = q && b.textContent.toLowerCase().indexOf(q) < 0; });
      list.querySelectorAll('.wfp-group').forEach(function (g) {
        var hit = g.querySelector('.wfp-menu-item:not([hidden])');
        g.hidden = !hit && !(q && g.firstChild.textContent.toLowerCase().indexOf(q) >= 0);
        if (q && g.firstChild.textContent.toLowerCase().indexOf(q) >= 0) g.querySelectorAll('.wfp-menu-item').forEach(function (b) { b.hidden = false; });
        g.open = !!q;
      });
    });
    var r = btn.getBoundingClientRect();
    menu.style.display = 'flex';
    menu.style.left = Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = (r.bottom + 4 + menu.offsetHeight < innerHeight ? r.bottom + 4 : Math.max(8, r.top - 4 - menu.offsetHeight)) + 'px';
    menu.opener = btn;
    search.focus();
  }

  function closeMenu() {
    if (menu.style.display !== 'flex') return;
    menu.style.display = 'none';
    if (menu.opener && menu.opener.isConnected) menu.opener.focus();
  }

  // Run the designer's own add command for a menu item, e.g. addCreateEntityStep() or addCustomActivityStep("…").
  function add(item, anchor, direction, place) {
    if (busy()) return;
    var m = /^\s*(\w+)\((?:"([0-9a-fA-F-]*)")?\)\s*;?\s*$/.exec(item.action);
    if (!m || typeof window[m[1]] !== 'function') return say('"' + item.title + '" cannot be added from the panel; add it in the designer.', true);
    var ids = {};
    Object.keys(state.nodes).forEach(function (k) { ids[k] = 1; });
    adding = { ids: ids, targetId: place.targetId, position: place.position };
    var saved = window._insertDirection;
    try {
      selectInDesigner(anchor);
      window._insertDirection = direction;
      window[m[1]].apply(window, m[2] !== undefined ? [m[2]] : []);
    } catch (err) {
      adding = null;
      say('Could not add the step: ' + err.message, true);
    } finally {
      window._insertDirection = saved; // the command has read it already
    }
  }

  body.addEventListener('click', function (e) {
    var b = e.target.closest('.wfp-add');
    if (!b) return;
    if (menu.style.display === 'flex' && menu.opener === b) return closeMenu();
    openMenu(b);
  });
  menu.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); }
  });
  document.addEventListener('pointerdown', function (e) {
    if (menu.style.display === 'flex' && !menu.contains(e.target) && !e.target.closest('.wfp-add')) closeMenu();
  }, true);
  body.addEventListener('scroll', closeMenu);

  // --- deleting: through the designer's own Delete command (it asks for confirmation itself) ---

  function canDelete() { return typeof deleteStep === 'function' && !!document.getElementById('_MBdeleteStep'); }
  var deleting = null; // id of a step the designer was asked to delete

  function ids(n, out) {
    n.children.forEach(function (c) { out.push(c.id); ids(c, out); });
    return out;
  }

  function remove(n) {
    if (busy()) return;
    var t = document.getElementById(n.id);
    if (!t) return say('This step is not in the designer any more. Cancel and reload the page.', true);
    // Deleting the only If branch deletes its whole condition.
    var whole = n.kind === 'IfCondition' && n.parent.children.length === 1 ? n.parent : n;
    var inDesigner = [].map.call((document.getElementById(whole.id) || t).querySelectorAll('table[stepname]'), function (s) { return s.id; })
      .filter(function (id) { return id !== 'NoStep'; }).sort().join();
    if (inDesigner !== ids(whole, []).sort().join()) {
      // The designer would delete what it has inside, not what the panel shows inside.
      return say('Steps were moved into or out of this one. Apply your moves first, then delete it.', true);
    }
    selectInDesigner(t);
    if (document.getElementById('_MBdeleteStep').getAttribute('disabled')) {
      return say('The designer does not allow deleting this step.', true);
    }
    deleting = n.id;
    deleteStep();
  }

  body.addEventListener('click', function (e) {
    var b = e.target.closest('.wfp-delete');
    if (b) remove(state.nodes[b.closest('.wfp-node').dataset.id]);
  });

  // --- moving ---

  // Move node n into container at slot index (slot k sits before the k-th child).
  // Returns false if the move was refused. quiet: skip re-rendering (used when replaying moves).
  function moveTo(n, container, index, quiet) {
    var kids = container.children, k = kids.indexOf(n);
    if (dialog.classList.contains('wfp-saving')) return false;
    if (k >= 0 && (index === k || index === k + 1)) return true;
    if (!allowed(n, container)) return false;
    var targetId, position;
    if (kids[index] && kids[index] !== n) { targetId = kids[index].id; position = 'before'; }
    else if (kids[index - 1] && kids[index - 1] !== n) { targetId = kids[index - 1].id; position = 'after'; }
    else { targetId = container.id; position = 'first'; }
    try {
      state.xaml = WfDragXaml.moveStep(state.xaml, n.id, targetId, position);
    } catch (err) {
      if (!quiet) say('Could not move the step: ' + err.message, true);
      return false;
    }
    var from = n.parent.children, at = from.indexOf(n);
    from.splice(at, 1);
    if (from === kids && at < index) index--;
    kids.splice(index, 0, n);
    n.parent = container;
    state.moves++;
    state.log.push({ id: n.id, targetId: targetId, position: position });
    if (!quiet) render(n.id);
    return true;
  }

  // Redo a logged move after the designer redrew: next to the same neighbour, so steps added since don't shift it.
  function replay(m) {
    var n = state.nodes[m.id], t = state.nodes[m.targetId];
    if (!n) return true; // the step was deleted
    if (!t) return false;
    if (m.position === 'first') return moveTo(n, t, 0, true);
    var k = t.parent.children.indexOf(t);
    return moveTo(n, t.parent, m.position === 'after' ? k + 1 : k, true);
  }

  body.addEventListener('keydown', function (e) {
    var row = e.target.closest('.wfp-row[data-drag]');
    if (row && e.target === row && e.key === 'Delete' && canDelete()) { e.preventDefault(); return remove(state.nodes[row.parentNode.dataset.id]); }
    if (!row || e.target.tagName === 'SELECT' || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    var n = state.nodes[row.parentNode.dataset.id], k = n.parent.children.indexOf(n);
    var index = e.key === 'ArrowUp' ? k - 1 : k + 2;
    if (index >= 0 && index <= n.parent.children.length) moveTo(n, n.parent, index);
  });

  // Pointer-based drag (the designer page interferes with native HTML5 drag-and-drop).
  var drag = null; // { node, x, y, started, slot, pointerY }

  body.addEventListener('pointerdown', function (e) {
    var row = e.target.closest('.wfp-row[data-drag]');
    if (!row || e.button !== 0 || e.target.closest('.wfp-edit, .wfp-add, .wfp-delete, .wfp-select')) return;
    drag = { node: state.nodes[row.parentNode.dataset.id], row: row, x: e.clientX, y: e.clientY, started: false, slot: null };
    row.setPointerCapture(e.pointerId);
  });

  body.addEventListener('pointermove', function (e) {
    if (!drag) return;
    if (!drag.started) {
      if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) < 5) return;
      drag.started = true;
      body.classList.add('wfp-dragging');
      drag.row.parentNode.classList.add('wfp-source');
      ghost.textContent = drag.node.title || drag.node.summary || drag.node.id;
      ghost.style.display = 'block';
      drag.timer = setInterval(autoScroll, 30);
    }
    drag.pointerY = e.clientY;
    ghost.style.left = e.clientX + 12 + 'px';
    ghost.style.top = e.clientY + 8 + 'px';
    setSlot(slotAt(e.clientX, e.clientY));
  });

  body.addEventListener('pointerup', function () {
    if (!drag) return;
    var node = drag.node, s = drag.started && drag.slot;
    endDrag();
    if (s) moveTo(node, state.nodes[s.dataset.container], +s.dataset.index);
  });
  body.addEventListener('pointercancel', endDrag);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && drag) { e.preventDefault(); e.stopPropagation(); endDrag(); }
  }, true);

  function endDrag() {
    if (!drag) return;
    clearInterval(drag.timer);
    setSlot(null);
    drag.row.parentNode.classList.remove('wfp-source');
    body.classList.remove('wfp-dragging');
    ghost.style.display = 'none';
    drag = null;
  }

  function autoScroll() {
    var r = body.getBoundingClientRect(), y = drag && drag.pointerY;
    if (y < r.top + 40) body.scrollTop -= 14;
    else if (y > r.bottom - 40) body.scrollTop += 14;
  }

  // The slot the pointer is over, or the nearest slot to the row it is over.
  function slotAt(x, y) {
    var hit = document.elementFromPoint(x, y);
    if (!hit || !body.contains(hit)) return null;
    var s = hit.closest('.wfp-slot');
    if (!s) {
      // Left of an indented row (outdenting) the pointer is over the indent, so match the row by height.
      var row = hit.closest('.wfp-row') || [].find.call(body.querySelectorAll('.wfp-row'), function (r) {
        var b = r.getBoundingClientRect();
        return y >= b.top && y <= b.bottom;
      });
      // Below the whole tree: end of the top level.
      if (!row) s = y > body.firstChild.getBoundingClientRect().bottom - 4 ? body.firstChild.lastElementChild : null;
      else {
        var box = row.parentNode, n = state.nodes[box.dataset.id], r = row.getBoundingClientRect();
        var lower = y > r.top + r.height / 2;
        if (!draggable(n)) s = box.querySelector(':scope > .wfp-children > .wfp-slot'); // branch header: first inside
        else if (lower && n.kind === PAGE) s = box.querySelector(':scope > .wfp-children > .wfp-slot');
        else if (lower && !n.children.length) s = outdent(box, x);
        else s = box.previousElementSibling;
      }
    }
    if (!s || !s.classList.contains('wfp-slot')) return null;
    return allowed(drag.node, state.nodes[s.dataset.container]) ? s : null;
  }

  // Slot after the step in `box`. On the last step of a branch, pointing left of the step
  // climbs out to the slot after the enclosing condition / wait / page, one level per indent.
  function outdent(box, x) {
    var s = box.nextElementSibling;
    while (s && !s.nextElementSibling && x < box.querySelector(':scope > .wfp-row').getBoundingClientRect().left) {
      var up = box.parentNode.closest('.wfp-node');
      while (up && !draggable(state.nodes[up.dataset.id])) up = up.parentNode.closest('.wfp-node');
      if (!up || !up.nextElementSibling || !up.nextElementSibling.classList.contains('wfp-slot')) break;
      box = up;
      s = up.nextElementSibling;
    }
    return s;
  }

  function setSlot(s) {
    if (drag && drag.slot === s) return;
    if (drag && drag.slot) drag.slot.classList.remove('wfp-slot-on');
    if (s) s.classList.add('wfp-slot-on');
    if (drag) drag.slot = s;
  }

  // Reset with step edits reloads the page; open the panel again afterwards.
  try {
    if (sessionStorage.getItem('wfp-reopen') === wfId) { sessionStorage.removeItem('wfp-reopen'); open(); }
  } catch (e) { /* storage blocked: the user reopens the panel */ }
})();
