// Run: node --test extension/test/xaml-move.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parse, findStep, moveStep } = require('../xaml-move.js');

// Fixture: root > ConditionStep1 > ConditionBranchStep2 > [ChildWorkflowStep3, CustomActivityStep6, SetStateStep5]
const xaml = fs.readFileSync(path.join(__dirname, 'fixture.xaml'), 'utf8');

function order(x) {
  return [...x.matchAll(/DisplayName="((?:ChildWorkflow|CustomActivity|SetState)Step\d+)/g)]
    .map(m => m[1]).filter((v, i, a) => a.indexOf(v) === i);
}

test('moves a step before a sibling and back to the identical text', () => {
  const moved = moveStep(xaml, 'SetStateStep5', 'ChildWorkflowStep3', 'before');
  assert.deepStrictEqual(order(moved), ['SetStateStep5', 'ChildWorkflowStep3', 'CustomActivityStep6']);
  assert.strictEqual(moved.length, xaml.length);
  assert.strictEqual(moveStep(moved, 'SetStateStep5', 'CustomActivityStep6', 'after'), xaml);
});

test('carries the trailing <Persist /> with the step', () => {
  const moved = moveStep(xaml, 'SetStateStep5', 'ConditionStep1', 'after');
  const tree = parse(moved);
  const step = findStep(tree, 'SetStateStep5');
  assert.strictEqual(step.parent.name, 'mxswa:Workflow');
  assert.strictEqual(step.parent.children[step.parent.children.indexOf(step) + 1].name, 'Persist');
});

test('emptying a branch writes a self-closing collection, refilling expands it again', () => {
  let x = xaml;
  for (const id of ['ChildWorkflowStep3', 'CustomActivityStep6', 'SetStateStep5']) x = moveStep(x, id, 'WorkflowStep0', 'last');
  assert.match(x, /<sco:Collection x:TypeArguments="Activity" x:Key="Activities" \/><\/mxswa:ActivityReference.Properties><\/mxswa:ActivityReference><x:Null x:Key="Else"/);
  parse(x);
  for (const id of ['ChildWorkflowStep3', 'CustomActivityStep6', 'SetStateStep5']) x = moveStep(x, id, 'ConditionBranchStep2', 'last');
  assert.strictEqual(x, xaml);
});

test('no-op moves return the same string', () => {
  assert.strictEqual(moveStep(xaml, 'ChildWorkflowStep3', 'CustomActivityStep6', 'before'), xaml);
  assert.strictEqual(moveStep(xaml, 'ChildWorkflowStep3', 'ChildWorkflowStep3', 'after'), xaml);
});

test('works with the one-argument startsWith that MicrosoftAjax.js installs on the designer page', () => {
  const original = String.prototype.startsWith;
  String.prototype.startsWith = function (a) { return this.substr(0, a.length) === a; };
  try {
    assert.deepStrictEqual(order(moveStep(xaml, 'SetStateStep5', 'ChildWorkflowStep3', 'before')),
      ['SetStateStep5', 'ChildWorkflowStep3', 'CustomActivityStep6']);
  } finally {
    String.prototype.startsWith = original;
  }
});

test('refuses to move a step into itself and reports unknown ids', () => {
  assert.throws(() => moveStep(xaml, 'ConditionStep1', 'ConditionBranchStep2', 'first'), /inside itself/);
  assert.throws(() => moveStep(xaml, 'UpdateStep99', 'ConditionStep1', 'before'), /not found/);
});
