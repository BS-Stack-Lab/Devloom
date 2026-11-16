import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ownedTarget, CDP, delay } from './commitStateUI.mjs';
export async function observePresentation(host, evidence, binding) {
  let client;
  const handled = new Set();
  try {
    while (!host.state.closed) {
      for (const name of readdirSync(evidence).filter(
        (name) =>
          name.startsWith('presentation-') && name.endsWith('-request.json') && !handled.has(name),
      )) {
        handled.add(name);
        const request = JSON.parse(readFileSync(join(evidence, name), 'utf8'));
        const response = { ...binding, status: 'fail', request: name, observed: Date.now() };
        try {
          for (const key of ['nonce', 'sessionId', 'sourceDigest'])
            if (request[key] !== binding[key]) throw new Error('FOREIGN_PRESENTATION');
          if (!client) {
            const owned = await ownedTarget(host, host.profile, binding.nonce);
            client = await CDP.connect(owned.target.webSocketDebuggerUrl);
          }
          await client.call('Emulation.setDeviceMetricsOverride', {
            width: 1600,
            height: 1000,
            deviceScaleFactor: 1,
            mobile: false,
          });
          const end = Date.now() + 10000;
          let dom;
          do {
            dom = await client.evaluate(
              `(() => ({title:document.title,text:document.body.innerText,resources:[...document.querySelectorAll('.scm-resource')].map(e=>({text:e.innerText,label:e.getAttribute('aria-label'),title:e.getAttribute('title')})),editors:[...document.querySelectorAll('.monaco-diff-editor')].map(e=>({classes:e.className,text:e.innerText,panes:[...e.querySelectorAll('.editor.original,.editor.modified')].map(p=>({classes:p.className,width:p.getBoundingClientRect().width,text:p.innerText})),whitespace:e.querySelectorAll('.mtkz').length,decorations:e.querySelectorAll('.char-insert,.char-delete,.line-insert,.line-delete,.gutter-insert,.gutter-delete').length})),uris:[...document.querySelectorAll('[data-uri]')].map(e=>e.getAttribute('data-uri'))}))()`,
            );
            const matches = (request.texts ?? []).every((text) => dom.text.includes(text));
            const editors = dom.editors.filter((editor) => editor.panes.some((p) => p.width > 0));
            const layout =
              request.layout === undefined ||
              editors.some((e) =>
                request.layout === 'side-by-side'
                  ? e.classes.includes('side-by-side') &&
                    e.panes.filter((p) => p.width > 80).length >= 2
                  : !e.classes.includes('side-by-side'),
              );
            if (matches && layout && Date.now() - request.at >= 500) break;
            await delay(100);
          } while (Date.now() < end);
          if (!(request.texts ?? []).every((text) => dom.text.includes(text)))
            throw new Error('RENDERED_TEXT_MISSING');
          if (
            request.layout &&
            !dom.editors.some((e) =>
              request.layout === 'side-by-side'
                ? e.classes.includes('side-by-side') &&
                  e.panes.filter((p) => p.width > 80).length >= 2
                : !e.classes.includes('side-by-side'),
            )
          )
            throw new Error('RENDERED_LAYOUT_MISSING');
          response.dom = dom;
          response.requested = request;
          response.status = 'pass';
          const png = name.replace('-request.json', '.png');
          await client.screenshot(join(evidence, png));
          response.screenshot = png;
        } catch {
          response.error = 'PRESENTATION_OBSERVATION_FAILED';
        }
        const path = join(evidence, name.replace('-request.json', '-response.json'));
        if (!existsSync(path))
          writeFileSync(path, JSON.stringify(response, null, 2), { flag: 'wx', mode: 0o600 });
      }
      await delay(50);
    }
  } finally {
    client?.close();
  }
}
