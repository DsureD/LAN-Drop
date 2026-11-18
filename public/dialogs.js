const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]';

export function installDialogs(document) {
  const stack = [];
  const EventConstructor = document.defaultView.Event;
  const top = () => stack[stack.length - 1];
  const focusable = dialog => [...dialog.querySelectorAll(FOCUSABLE)].filter(target => !target.disabled && !target.hidden && target.tabIndex >= 0 && target.getClientRects().length > 0);
  const focusDialog = dialog => {
    const target = focusable(dialog)[0] || dialog;
    target.focus({ preventScroll: true });
  };
  let fallbackCount = 0;

  for (const dialog of document.querySelectorAll('dialog')) {
    if (typeof dialog.showModal === 'function' && typeof dialog.close === 'function') continue;
    fallbackCount += 1;
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-fallback';
    backdrop.hidden = true;
    dialog.classList.add('modal-fallback-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('tabindex', '-1');
    const heading = dialog.querySelector('h2');
    if (heading) {
      if (!heading.id) heading.id = `${dialog.id}-title`;
      dialog.setAttribute('aria-labelledby', heading.id);
    }
    document.body.append(backdrop);
    backdrop.append(dialog);
    const entry = { dialog, backdrop, previousFocus: null };

    Object.defineProperty(dialog, 'open', { configurable: true, get: () => dialog.hasAttribute('open') });
    dialog.showModal = () => {
      if (dialog.open) return;
      entry.previousFocus = document.activeElement;
      document.body.append(backdrop);
      stack.push(entry);
      dialog.setAttribute('open', '');
      backdrop.hidden = false;
      document.body.classList.add('modal-fallback-open');
      focusDialog(dialog);
    };
    dialog.close = () => {
      if (!dialog.open) return;
      dialog.removeAttribute('open');
      backdrop.hidden = true;
      const index = stack.indexOf(entry);
      if (index >= 0) stack.splice(index, 1);
      document.body.classList.toggle('modal-fallback-open', stack.length > 0);
      if (top()) focusDialog(top().dialog);
      else if (entry.previousFocus?.isConnected) entry.previousFocus.focus({ preventScroll: true });
      dialog.dispatchEvent(new EventConstructor('close'));
    };
  }

  if (!fallbackCount) return;
  document.addEventListener('keydown', event => {
    const current = top();
    if (!current) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      const cancellation = new EventConstructor('cancel', { cancelable: true });
      if (current.dialog.dispatchEvent(cancellation)) current.dialog.close();
    } else if (event.key === 'Tab') {
      const targets = focusable(current.dialog);
      const index = targets.indexOf(document.activeElement);
      if (!targets.length) {
        event.preventDefault();
        current.dialog.focus({ preventScroll: true });
      } else if (event.shiftKey && index <= 0) {
        event.preventDefault();
        targets[targets.length - 1].focus({ preventScroll: true });
      } else if (!event.shiftKey && (index === -1 || index === targets.length - 1)) {
        event.preventDefault();
        targets[0].focus({ preventScroll: true });
      }
    }
  }, true);
  document.addEventListener('focusin', event => {
    const current = top();
    if (current && !current.dialog.contains(event.target)) focusDialog(current.dialog);
  }, true);
}
