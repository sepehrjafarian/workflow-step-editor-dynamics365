// Moves a workflow step inside the raw XAML text without re-serializing it.
// Dynamics rejects XAML that differs from what its designer emits (error 0x80045040),
// so we only cut and paste exact substrings.
(function (root) {
  'use strict';

  // The designer page loads MicrosoftAjax.js, which replaces String.prototype.startsWith
  // with a one-argument version, so never rely on startsWith(prefix, position) here.
  function at(xml, i, s) { return xml.substr(i, s.length) === s; }

  function skipPast(xml, from, s) {
    var k = xml.indexOf(s, from);
    if (k < 0) throw new Error('Unterminated ' + s + ' at ' + from);
    return k + s.length;
  }

  // Minimal XML scanner that records each element's [start, end) offsets.
  function parse(xml) {
    var top = { name: '#root', attrs: {}, children: [], parent: null, start: 0, end: xml.length };
    var cur = top, i = 0, n = xml.length;
    while (i < n) {
      var lt = xml.indexOf('<', i);
      if (lt < 0) break;
      if (at(xml, lt, '<?')) { i = skipPast(xml, lt, '?>'); continue; }
      if (at(xml, lt, '<!--')) { i = skipPast(xml, lt, '-->'); continue; }
      if (at(xml, lt, '<![CDATA[')) { i = skipPast(xml, lt, ']]>'); continue; }
      var j = lt + 1, q = null;
      for (; j < n; j++) {
        var c = xml[j];
        if (q) { if (c === q) q = null; }
        else if (c === '"' || c === "'") q = c;
        else if (c === '>') break;
      }
      if (j >= n) throw new Error('Unterminated tag at ' + lt);
      var tag = xml.slice(lt + 1, j);
      if (tag[0] === '/') {
        cur.end = j + 1;
        cur = cur.parent;
        if (!cur) throw new Error('Unbalanced end tag at ' + lt);
      } else {
        var selfClose = tag[tag.length - 1] === '/';
        var name = /^[^\s/>]+/.exec(tag)[0];
        var attrs = {}, re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g, m;
        while ((m = re.exec(tag))) attrs[m[1]] = m[3] !== undefined ? m[3] : m[4];
        var el = {
          name: name, attrs: attrs, children: [], parent: cur,
          start: lt, openEnd: j + 1, end: selfClose ? j + 1 : -1, selfClose: selfClose
        };
        cur.children.push(el);
        if (!selfClose) cur = el;
      }
      i = j + 1;
    }
    if (cur !== top) throw new Error('Unclosed element ' + cur.name);
    return top;
  }

  function walk(el, fn) {
    for (var k = 0; k < el.children.length; k++) {
      if (fn(el.children[k]) === false) return false;
      if (walk(el.children[k], fn) === false) return false;
    }
  }

  function matches(el, id) {
    var d = el.attrs.DisplayName;
    return d === id || (d !== undefined && d.indexOf(id + ':') === 0);
  }

  // Outermost element for a designer step id (e.g. "UpdateStep46").
  function findStep(tree, id) {
    var hit = null;
    walk(tree, function (el) { if (matches(el, id)) { hit = el; return false; } });
    return hit;
  }

  function activitiesOf(el) {
    var props = el.children.filter(function (c) { return /\.Properties$/.test(c.name); })[0];
    return props && props.children.filter(function (c) { return c.attrs['x:Key'] === 'Activities'; })[0];
  }

  // Collection holding the children of a container step (branch "Then", dialog page, stage).
  // For a branch the innermost match is the "Then" composite, which is what we want.
  function findContainer(tree, id) {
    var hit = null;
    walk(tree, function (el) { if (matches(el, id) && activitiesOf(el)) hit = activitiesOf(el); });
    if (!hit && id === 'WorkflowStep0') {
      walk(tree, function (el) { if (el.name === 'mxswa:Workflow') { hit = el; return false; } });
    }
    return hit;
  }

  function named(el) { return el.attrs.DisplayName !== undefined; }

  // The step plus the unnamed elements the designer emits right after it
  // (<Persist />, <Assign> for dialog prompts, <If> for custom activity outputs).
  function unit(el) {
    var sib = el.parent.children, k = sib.indexOf(el), end = el.end;
    while (sib[++k] && !named(sib[k])) end = sib[k].end;
    return { start: el.start, end: end };
  }

  // The designer writes empty collections as "<X ... />" and non-empty ones as "<X ...>...</X>".
  function selfClosed(xml, el) { return xml.slice(el.start, el.openEnd - 1).replace(/\s+$/, '') + ' />'; }
  function opened(xml, el) { return xml.slice(el.start, el.openEnd).replace(/\s*\/>$/, '>'); }

  // position: 'before' | 'after' (targetId is a step) or 'first' | 'last' (targetId is a branch/page).
  // Returns the new XAML, or the same string when the move changes nothing.
  function moveStep(xml, stepId, targetId, position) {
    var tree = parse(xml);
    var step = findStep(tree, stepId);
    if (!step) throw new Error('Step ' + stepId + ' was not found in the saved definition. Save the process first.');
    var src = unit(step), piece = xml.slice(src.start, src.end);
    var edits = [];

    var srcParent = step.parent;
    var srcSiblings = srcParent.children.filter(function (c) { return c.start < src.start || c.start >= src.end; });
    var emptiesParent = srcParent.attrs['x:Key'] === 'Activities' && srcSiblings.length === 0;

    if (position === 'before' || position === 'after') {
      var t = findStep(tree, targetId);
      if (!t) throw new Error('Step ' + targetId + ' was not found in the saved definition. Save the process first.');
      if (t.start >= src.start && t.start < src.end) return xml;
      var at = position === 'before' ? t.start : unit(t).end;
      edits.push({ start: at, end: at, text: piece });
    } else {
      var c = findContainer(tree, targetId);
      if (!c) throw new Error('Branch ' + targetId + ' was not found in the saved definition. Save the process first.');
      if (c.start >= src.start && c.start < src.end) throw new Error('A step cannot be moved inside itself.');
      if (c === srcParent && emptiesParent) return xml;
      if (c.selfClose) {
        edits.push({ start: c.start, end: c.end, text: opened(xml, c) + piece + '</' + c.name + '>' });
      } else {
        // 'first' goes before the first designer step, after leading elements such as <mxswa:Workflow.Variables>.
        var firstStep = c.children.filter(function (k) { return /^[A-Za-z]+Step\d+(:|$)/.test(k.attrs.DisplayName); })[0];
        var closeAt = xml.lastIndexOf('</', c.end - 1);
        var pos = position === 'first' && firstStep ? firstStep.start : closeAt;
        edits.push({ start: pos, end: pos, text: piece });
      }
    }

    if (emptiesParent) edits.push({ start: srcParent.start, end: srcParent.end, text: selfClosed(xml, srcParent) });
    else edits.push({ start: src.start, end: src.end, text: '' });

    // Apply right-to-left so earlier offsets stay valid. Insert points never fall inside a removed range.
    edits.sort(function (a, b) { return b.start - a.start || b.end - a.end; });
    var out = xml;
    edits.forEach(function (e) { out = out.slice(0, e.start) + e.text + out.slice(e.end); });
    return out;
  }

  var api = { parse: parse, findStep: findStep, findContainer: findContainer, moveStep: moveStep };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WfDragXaml = api;
})(this);
