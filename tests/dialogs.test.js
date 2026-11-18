import test from 'node:test';
import assert from 'node:assert/strict';
import { installDialogs } from '../public/dialogs.js';

class Element extends EventTarget {
  constructor(document, id = '') {
    super();
    this.document = document;
    this.id = id;
    this.attributes = new Map();
    this.children = [];
    this.controls = [];
    this.hidden = false;
    this.disabled = false;
    this.tabIndex = 0;
    this.isConnected = true;
    const classes = new Set();
    this.classList = {
      add: value => classes.add(value),
      contains: value => classes.has(value),
      toggle(value, enabled) { if (enabled) classes.add(value); else classes.delete(value); }
    };
  }

  setAttribute(name, value) { this.attributes.set(name, value); }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  append(child) {
    if (child.parent) child.parent.children = child.parent.children.filter(item => item !== child);
    child.parent = this;
    this.children.push(child);
  }
  querySelector(selector) { return selector === 'h2' ? this.heading : null; }
  querySelectorAll() { return this.controls; }
  getClientRects() { return this.hidden ? [] : [{}]; }
  contains(target) { return target === this || this.controls.includes(target); }
  focus() { this.document.activeElement = this; }
}

class Document extends EventTarget {
  constructor() {
    super();
    this.defaultView = { Event };
    this.body = new Element(this);
    this.dialogs = [];
    this.activeElement = new Element(this, 'opener');
  }

  createElement() { return new Element(this); }
  querySelectorAll() { return this.dialogs; }
  dialog(id, controls = 2) {
    const dialog = new Element(this, id);
    dialog.heading = new Element(this);
    dialog.controls = Array.from({ length: controls }, (_, index) => new Element(this, `${id}-control-${index}`));
    this.body.append(dialog);
    this.dialogs.push(dialog);
    return dialog;
  }
  key(key, shiftKey = false) {
    const event = new Event('keydown', { cancelable: true });
    Object.assign(event, { key, shiftKey });
    this.dispatchEvent(event);
    return event;
  }
}

test('native dialog methods are preserved', () => {
  const document = new Document();
  const dialog = document.dialog('native');
  const showModal = () => {};
  const close = () => {};
  Object.assign(dialog, { showModal, close });
  installDialogs(document);
  assert.equal(dialog.showModal, showModal);
  assert.equal(dialog.close, close);
  assert.equal(dialog.classList.contains('modal-fallback-dialog'), false);
});

test('legacy dialogs start hidden and show with a focused input and accessible title', () => {
  const document = new Document();
  const dialog = document.dialog('password-dialog');
  installDialogs(document);
  assert.equal(dialog.open, false);
  assert.equal(dialog.parent.hidden, true);
  assert.equal(dialog.attributes.get('role'), 'dialog');
  assert.equal(dialog.attributes.get('aria-labelledby'), 'password-dialog-title');
  dialog.showModal();
  assert.equal(dialog.open, true);
  assert.equal(dialog.parent.hidden, false);
  assert.equal(document.activeElement, dialog.controls[0]);
  assert.equal(document.body.classList.contains('modal-fallback-open'), true);
});

test('closing releases scroll lock, restores focus and only dispatches close once', () => {
  const document = new Document();
  const opener = document.activeElement;
  const dialog = document.dialog('receive');
  installDialogs(document);
  let closes = 0;
  dialog.addEventListener('close', () => { closes += 1; });
  dialog.close();
  dialog.showModal();
  dialog.showModal();
  dialog.close();
  dialog.close();
  assert.equal(closes, 1);
  assert.equal(dialog.open, false);
  assert.equal(dialog.parent.hidden, true);
  assert.equal(document.activeElement, opener);
  assert.equal(document.body.classList.contains('modal-fallback-open'), false);
});

test('password cancel handlers can prevent Escape from dismissing authentication', () => {
  const document = new Document();
  const dialog = document.dialog('password');
  installDialogs(document);
  dialog.addEventListener('cancel', event => event.preventDefault());
  dialog.showModal();
  assert.equal(document.key('Escape').defaultPrevented, true);
  assert.equal(dialog.open, true);
});

test('Escape dismisses an ordinary dialog through the cancel event', () => {
  const document = new Document();
  const dialog = document.dialog('help');
  installDialogs(document);
  let cancellations = 0;
  dialog.addEventListener('cancel', () => { cancellations += 1; });
  dialog.showModal();
  document.key('Escape');
  assert.equal(cancellations, 1);
  assert.equal(dialog.open, false);
});

test('Tab navigation stays within the active dialog and skips disabled controls', () => {
  const document = new Document();
  const dialog = document.dialog('receive', 3);
  dialog.controls[1].disabled = true;
  installDialogs(document);
  dialog.showModal();
  document.key('Tab', true);
  assert.equal(document.activeElement, dialog.controls[2]);
  document.key('Tab');
  assert.equal(document.activeElement, dialog.controls[0]);
});

test('a dialog without controls can still receive focus and trap Tab', () => {
  const document = new Document();
  const dialog = document.dialog('empty', 0);
  installDialogs(document);
  dialog.showModal();
  const key = document.key('Tab');
  assert.equal(document.activeElement, dialog);
  assert.equal(key.defaultPrevented, true);
});

test('stacked dialogs retain scroll lock and return focus to the previous dialog', () => {
  const document = new Document();
  const opener = document.activeElement;
  const first = document.dialog('help');
  const second = document.dialog('receive');
  installDialogs(document);
  first.showModal();
  second.showModal();
  second.close();
  assert.equal(document.activeElement, first.controls[0]);
  assert.equal(document.body.classList.contains('modal-fallback-open'), true);
  first.close();
  assert.equal(document.activeElement, opener);
  assert.equal(document.body.classList.contains('modal-fallback-open'), false);
});

test('focus moved outside the fallback modal is returned to its controls', () => {
  const document = new Document();
  const dialog = document.dialog('receive');
  installDialogs(document);
  dialog.showModal();
  const outside = document.createElement('button');
  outside.focus();
  const event = new Event('focusin');
  Object.defineProperty(event, 'target', { value: outside });
  document.dispatchEvent(event);
  assert.equal(document.activeElement, dialog.controls[0]);
});
