import vm from 'node:vm';

class FakeNode {
  constructor() {
    this.children = [];
  }
  append(...items) {
    for (const item of items) this.children.push(typeof item === 'string' ? new FakeText(item) : item);
  }
  replaceChildren(...items) {
    this.children = [];
    this.append(...items);
  }
  remove() {}
  get textContent() {
    return this.children.map((child) => child.textContent).join('');
  }
  set textContent(value) {
    this.children = value === '' ? [] : [new FakeText(value)];
  }
  find(predicate, found = []) {
    for (const child of this.children) {
      if (child instanceof FakeElement) {
        if (predicate(child)) found.push(child);
        child.find(predicate, found);
      }
    }
    return found;
  }
}

class FakeText extends FakeNode {
  constructor(text) {
    super();
    this.text = text;
  }
  get textContent() {
    return this.text;
  }
}

class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.tag = tag;
    this.attributes = {};
    this.listeners = {};
    this.className = '';
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  addEventListener(type, handler) {
    (this.listeners[type] ??= []).push(handler);
  }
  async fire(type, event = {}) {
    for (const handler of this.listeners[type] ?? []) await handler({ target: this, currentTarget: this, ...event });
  }
  click() {
    return this.fire('click');
  }
}

/** 最小 DOM + Canvas 桩，用来在 Node 里真正执行仪表盘客户端脚本。 */
export function runDashboardClient(html, { storage = {}, locale } = {}) {
  const scripts = [...html.matchAll(/<script(?: type="application\/json" id="t3d-data")?>([\s\S]*?)<\/script>/g)];
  const dataText = html.match(/<script type="application\/json" id="t3d-data">([\s\S]*?)<\/script>/)[1];
  const clientScript = scripts.map((match) => match[1]).find((code) => code !== dataText);

  const root = new FakeElement('div');
  const dataEl = new FakeElement('script');
  dataEl.textContent = dataText;
  const drawn = { texts: [], canvases: [] };
  const makeCanvas = () => {
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => new Proxy(
        { measureText: (text) => ({ width: String(text).length * 8 }), createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }) },
        {
          get: (target, key) => target[key] ?? ((...args) => { if (key === 'fillText') drawn.texts.push(args[0]); }),
          set: () => true,
        },
      ),
      toBlob: (callback) => callback(new Blob(['png'], { type: 'image/png' })),
    };
    drawn.canvases.push(canvas);
    return canvas;
  };
  const document = {
    title: '',
    documentElement: { lang: 'en' },
    body: new FakeElement('body'),
    getElementById: (id) => (id === 't3d-data' ? dataEl : id === 't3d-root' ? root : root.find((el) => el.attributes.id === id)[0] ?? null),
    createElement: (tag) => (tag === 'canvas' ? makeCanvas() : new FakeElement(tag)),
    createTextNode: (text) => new FakeText(text),
    querySelector: () => null,
  };
  const localStorage = { getItem: (key) => storage[key] ?? null, setItem: (key, value) => { storage[key] = String(value); } };
  const copied = [];
  const sandbox = {
    document,
    localStorage,
    Node: FakeNode,
    Blob,
    URL,
    JSON,
    Math,
    Date,
    Number,
    Object,
    Set,
    Promise,
    Error,
    String,
    ClipboardItem: class { constructor(items) { this.items = items; } },
    navigator: { clipboard: { write: async (items) => { copied.push(items); } }, language: locale ?? 'en' },
    fetch: async () => ({ ok: false }),
    setInterval: () => 0,
  };
  vm.runInNewContext(clientScript, sandbox);
  const text = () => root.textContent;
  const buttons = (label) => root.find((el) => el.tag === 'button' && el.textContent === label);
  return { root, document, storage, drawn, copied, text, buttons, find: (predicate) => root.find(predicate), flush: () => new Promise((resolve) => setImmediate(resolve)) };
}
